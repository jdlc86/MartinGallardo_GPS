from __future__ import annotations

from dataclasses import replace

from .company_shuttle import ShuttleRequest, assign_vehicle, request_mission_window
from .domain import CompanyShuttleMission, OptimizerConfig, Solution, Task, TransferStep, Transition, Worker
from .shifts import operational_day
from .transitions import build_transition


def _mission_for_rider(missions: list[CompanyShuttleMission], worker_id: str, task_id: str):
    for mission in missions:
        for wid, tid in zip(mission.rider_worker_ids, mission.rider_task_ids):
            if wid == worker_id and tid == task_id:
                return mission
    return None


def _company_transition(previous: Task, current: Task, cfg: OptimizerConfig) -> Transition:
    base = build_transition(previous, current, cfg)
    return Transition(
        previous.id,
        current.id,
        "company_shuttle",
        True,
        base.ready_at,
        current.start_at,
        cfg.company_shuttle_mission_cost,
        steps=(
            TransferStep(
                "company_shuttle",
                previous.end_node,
                current.start_node,
                max(0, int((current.start_at - previous.end_at).total_seconds() // 60)),
            ),
        ),
    )


def _rescue_transition(
    previous: Task,
    current: Task,
    worker_id: str,
    tasks: list[Task],
    missions: list[CompanyShuttleMission],
    cfg: OptimizerConfig,
):
    base = build_transition(previous, current, cfg)
    if base.feasible and not base.requires_companion:
        return base, None
    if not base.feasible or base.kind not in {"ride_out", "ride_in"} or base.ready_at is None:
        return None, None

    # A successor can have only one canonical rescue movement. If it already has
    # one, do not create a second mission after another insertion changes its
    # predecessor. This keeps mission ownership and route transitions one-to-one.
    if _mission_for_rider(missions, worker_id, current.id) is not None:
        return None, None

    req = ShuttleRequest(
        worker_id,
        current.id,
        previous.end_node,
        current.start_node,
        base.ready_at,
        current.start_at,
    )
    window = request_mission_window(req, tasks)
    if window is None:
        return None, None
    depart, ret = window
    stops = (
        (previous.end_node, current.start_node)
        if previous.end_node != "PARKING" and current.start_node != "PARKING"
        else tuple(n for n in (previous.end_node, current.start_node) if n != "PARKING")
    )

    # Share only an identical mission, never duplicate the same rider/task pair.
    for i, mission in enumerate(missions):
        if (
            mission.depart_parking_at == depart
            and mission.return_parking_at == ret
            and mission.stops == stops
            and len(mission.rider_worker_ids) < cfg.company_shuttle_passenger_capacity
        ):
            pair = (worker_id, current.id)
            if pair in set(zip(mission.rider_worker_ids, mission.rider_task_ids)):
                return None, None
            shared = replace(
                mission,
                rider_worker_ids=mission.rider_worker_ids + (worker_id,),
                rider_task_ids=mission.rider_task_ids + (current.id,),
            )
            return _company_transition(previous, current, cfg), (i, shared)

    vehicle = assign_vehicle(missions, depart, ret, cfg)
    if vehicle is None:
        return None, None
    mission = CompanyShuttleMission(
        vehicle,
        f"rescue:{worker_id}:{current.id}",
        depart,
        ret,
        stops,
        (worker_id,),
        (current.id,),
    )
    return _company_transition(previous, current, cfg), (None, mission)


def _has_overlap(task: Task, same_day: list[Task]) -> bool:
    return any(task.start_at < other.end_at and other.start_at < task.end_at for other in same_day)


def _rebuild_route_transitions(route, missions: list[CompanyShuttleMission], cfg: OptimizerConfig) -> None:
    rescue_pairs = {
        (wid, tid)
        for mission in missions
        for wid, tid in zip(mission.rider_worker_ids, mission.rider_task_ids)
    }
    rebuilt = {}
    previous = None
    previous_day = None
    for task in route.tasks:
        day = operational_day(task.start_at, cfg)
        if day != previous_day:
            previous = None
        if previous is None:
            rebuilt[task.id] = build_transition(None, task, cfg)
        else:
            base = build_transition(previous, task, cfg)
            if (route.worker.id, task.id) in rescue_pairs:
                if not base.requires_companion:
                    # This rescue mission became obsolete after another insertion.
                    # Leave the canonical direct transition; caller will prune the
                    # unused mission before validation.
                    rebuilt[task.id] = base
                else:
                    rebuilt[task.id] = _company_transition(previous, task, cfg)
            else:
                rebuilt[task.id] = base
        previous = task
        previous_day = day
    route.transitions = rebuilt


def _prune_unused_missions(solution: Solution, missions: list[CompanyShuttleMission]) -> list[CompanyShuttleMission]:
    used_pairs = {
        (wid, task.id)
        for wid, route in solution.routes.items()
        for task in route.tasks
        if route.transitions.get(task.id) is not None and route.transitions[task.id].kind == "company_shuttle"
    }
    pruned = []
    for mission in missions:
        pairs = [
            (wid, tid)
            for wid, tid in zip(mission.rider_worker_ids, mission.rider_task_ids)
            if (wid, tid) in used_pairs
        ]
        if not pairs:
            continue
        pruned.append(
            replace(
                mission,
                rider_worker_ids=tuple(wid for wid, _ in pairs),
                rider_task_ids=tuple(tid for _, tid in pairs),
            )
        )
    return pruned


def augment_with_company_shuttles(
    solution: Solution,
    all_tasks: list[Task],
    workers: list[Worker],
    cfg: OptimizerConfig,
) -> Solution:
    """Conservative rescue pass after CP-SAT.

    Insertions are accepted only when the task does not overlap any existing task,
    both adjacent transitions are valid, and every company-car movement belongs to
    a unique, non-overlapping PARKING-return mission. CP-SAT assignments are never
    removed, so valid coverage can only stay equal or increase.
    """
    if cfg.company_shuttle_vehicle_count <= 0 or not solution.unassigned_task_ids:
        return solution

    by_id = {t.id: t for t in all_tasks}
    missions = list(solution.company_shuttle_missions)
    unassigned = [by_id[i] for i in solution.unassigned_task_ids if i in by_id]
    unassigned.sort(key=lambda t: (t.start_at, t.id))
    shifts = {(s.worker_id, s.operational_day): s for s in solution.shift_assignments}

    for task in unassigned:
        candidate_workers = [w for w in workers if not task.fixed_worker_id or w.id == task.fixed_worker_id]
        for worker in candidate_workers:
            shift = shifts.get((worker.id, operational_day(task.start_at, cfg)))
            if shift is None or task.start_at < shift.start_at or task.end_at > shift.end_at:
                continue

            route = solution.routes[worker.id]
            same_day = [
                t for t in route.tasks
                if operational_day(t.start_at, cfg) == operational_day(task.start_at, cfg)
            ]
            if _has_overlap(task, same_day):
                continue

            before = [t for t in same_day if t.end_at <= task.start_at]
            after = [t for t in same_day if t.start_at >= task.end_at]
            previous = max(before, key=lambda t: (t.start_at, t.id), default=None)
            nxt = min(after, key=lambda t: (t.start_at, t.id), default=None)
            if same_day and previous is None and nxt is None:
                continue

            # If the current successor already depends on a rescue mission, changing
            # its predecessor would make that mission stale. Skip rather than mutate
            # an already validated rescue chain.
            if nxt is not None and _mission_for_rider(missions, worker.id, nxt.id) is not None:
                continue

            trial = list(missions)
            trans_in = build_transition(None, task, cfg) if previous is None else None
            if previous is not None:
                trans_in, update = _rescue_transition(previous, task, worker.id, all_tasks, trial, cfg)
                if trans_in is None:
                    continue
                if update:
                    _apply(trial, update)

            if nxt is not None:
                trans_out, update = _rescue_transition(task, nxt, worker.id, all_tasks, trial, cfg)
                if trans_out is None:
                    continue
                if update:
                    _apply(trial, update)

            missions = trial
            route.tasks.append(task)
            route.tasks.sort(key=lambda t: (t.start_at, t.id))
            solution.unassigned_task_ids.remove(task.id)
            solution.coverage_count += 1

            # Rebuild from the actual chronological route, never from stale adjacency.
            _rebuild_route_transitions(route, missions, cfg)
            break

    for route in solution.routes.values():
        _rebuild_route_transitions(route, missions, cfg)
    missions = _prune_unused_missions(solution, missions)
    # Rebuild once more after pruning to guarantee a one-to-one canonical contract.
    for route in solution.routes.values():
        _rebuild_route_transitions(route, missions, cfg)
    solution.company_shuttle_missions = missions
    return solution


def _apply(missions: list[CompanyShuttleMission], update):
    index, mission = update
    if index is None:
        missions.append(mission)
    else:
        missions[index] = mission
