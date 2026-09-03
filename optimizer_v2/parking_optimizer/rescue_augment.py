from __future__ import annotations

from dataclasses import replace

from .company_shuttle import ShuttleRequest, assign_vehicle, request_mission_window
from .domain import CompanyShuttleMission, OptimizerConfig, Solution, Task, TransferStep, Transition, Worker
from .shifts import operational_day
from .transitions import build_transition


def _rescue_transition(previous: Task, current: Task, worker_id: str, tasks: list[Task], missions: list[CompanyShuttleMission], cfg: OptimizerConfig):
    base = build_transition(previous, current, cfg)
    if base.feasible and not base.requires_companion:
        return base, None
    if not base.feasible or base.kind not in {"ride_out", "ride_in"} or base.ready_at is None:
        return None, None
    req = ShuttleRequest(worker_id, current.id, previous.end_node, current.start_node, base.ready_at, current.start_at)
    window = request_mission_window(req, tasks)
    if window is None:
        return None, None
    depart, ret = window
    stops = (previous.end_node, current.start_node) if previous.end_node != "PARKING" and current.start_node != "PARKING" else tuple(n for n in (previous.end_node, current.start_node) if n != "PARKING")

    # Share an identical mission up to configured passenger capacity.
    for i, mission in enumerate(missions):
        if mission.depart_parking_at == depart and mission.return_parking_at == ret and mission.stops == stops and len(mission.rider_worker_ids) < cfg.company_shuttle_passenger_capacity:
            shared = replace(mission, rider_worker_ids=mission.rider_worker_ids + (worker_id,), rider_task_ids=mission.rider_task_ids + (current.id,))
            return Transition(previous.id, current.id, "company_shuttle", True, base.ready_at, current.start_at, cfg.company_shuttle_mission_cost, steps=(TransferStep("company_shuttle", previous.end_node, current.start_node, max(0, int((current.start_at-base.ready_at).total_seconds()//60))),)), (i, shared)

    vehicle = assign_vehicle(missions, depart, ret, cfg)
    if vehicle is None:
        return None, None
    mission = CompanyShuttleMission(vehicle, f"rescue:{worker_id}:{current.id}", depart, ret, stops, (worker_id,), (current.id,))
    return Transition(previous.id, current.id, "company_shuttle", True, base.ready_at, current.start_at, cfg.company_shuttle_mission_cost, steps=(TransferStep("company_shuttle", previous.end_node, current.start_node, max(0, int((current.start_at-base.ready_at).total_seconds()//60))),)), (None, mission)


def augment_with_company_shuttles(solution: Solution, all_tasks: list[Task], workers: list[Worker], cfg: OptimizerConfig) -> Solution:
    """Conservative rescue pass after CP-SAT.

    It only inserts an unassigned task when both adjacent physical links are proven feasible and
    every company-car movement belongs to a non-overlapping PARKING-return mission. It never removes
    a CP-SAT assignment, so coverage can only stay equal or increase.
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
        inserted = False
        for worker in candidate_workers:
            shift = shifts.get((worker.id, operational_day(task.start_at, cfg)))
            if shift is None or task.start_at < shift.start_at or task.end_at > shift.end_at:
                continue
            route = solution.routes[worker.id]
            same_day = [t for t in route.tasks if operational_day(t.start_at, cfg) == operational_day(task.start_at, cfg)]
            before = [t for t in same_day if t.end_at <= task.start_at]
            after = [t for t in same_day if t.start_at >= task.end_at]
            previous = max(before, key=lambda t: (t.start_at, t.id), default=None)
            nxt = min(after, key=lambda t: (t.start_at, t.id), default=None)
            # Do not create a second disconnected chain in the same worker/day.
            if same_day and previous is None and nxt is None:
                continue
            trial = list(missions)
            trans_in = build_transition(None, task, cfg) if previous is None else None
            mission_updates = []
            if previous is not None:
                trans_in, update = _rescue_transition(previous, task, worker.id, all_tasks, trial, cfg)
                if trans_in is None: continue
                if update: mission_updates.append(update); _apply(trial, update)
            if nxt is not None:
                trans_out, update = _rescue_transition(task, nxt, worker.id, all_tasks, trial, cfg)
                if trans_out is None: continue
                if update: mission_updates.append(update); _apply(trial, update)
            # Commit insertion and rebuild only affected canonical transition entries.
            missions = trial
            route.tasks.append(task); route.tasks.sort(key=lambda t: (t.start_at, t.id))
            route.transitions[task.id] = trans_in
            if nxt is not None: route.transitions[nxt.id] = trans_out
            solution.unassigned_task_ids.remove(task.id)
            solution.coverage_count += 1
            inserted = True
            break
        if inserted:
            continue
    solution.company_shuttle_missions = missions
    return solution


def _apply(missions: list[CompanyShuttleMission], update):
    index, mission = update
    if index is None: missions.append(mission)
    else: missions[index] = mission
