from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Iterable

from ortools.sat.python import cp_model

from .domain import CompanionMatch, OptimizerConfig, Solution, Task, Worker, WorkerRoute
from .transitions import build_transition, terminal_transfer


@dataclass(frozen=True, slots=True)
class _Arc:
    worker_id: str
    previous_id: str
    current_id: str
    transition_kind: str
    cost_minutes: int


@dataclass(frozen=True, slots=True)
class _SeatTask:
    task: Task
    direction: str
    origin: str
    destination: str
    depart_at: datetime
    arrive_at: datetime


@dataclass(frozen=True, slots=True)
class _RideCandidate:
    rider_worker_id: str
    previous_id: str
    current_id: str
    driver_worker_id: str
    driver_task_id: str
    direction: str
    depart_at: datetime
    vehicle_leg_arrive_at: datetime
    arrive_at: datetime
    extra_transfer_minutes: int
    steps: tuple


def _ordered_tasks(tasks: Iterable[Task]) -> list[Task]:
    return sorted(tasks, key=lambda task: (task.start_at, task.end_at, task.id))


def _seat_task(task: Task) -> _SeatTask:
    if task.task_type == "delivery":
        return _SeatTask(task, "out", "PARKING", task.terminal, task.vehicle_leg_depart_at, task.vehicle_leg_arrive_at)
    return _SeatTask(task, "in", task.terminal, "PARKING", task.vehicle_leg_depart_at, task.vehicle_leg_arrive_at)


def _candidate_for_seat(
    rider_worker_id: str,
    previous: Task,
    current: Task,
    driver_worker_id: str,
    seat: _SeatTask,
    cfg: OptimizerConfig,
) -> _RideCandidate | None:
    if rider_worker_id == driver_worker_id:
        return None
    transition = build_transition(previous, current, cfg)
    if transition.kind not in ("ride_out", "ride_in") or seat.direction != transition.direction or transition.ready_at is None:
        return None

    if seat.direction == "out":
        if seat.depart_at < transition.ready_at:
            return None
        transfer = terminal_transfer(seat.destination, current.start_node, seat.arrive_at, cfg)
        if transfer is None:
            return None
        transfer_minutes, steps = transfer
        arrive = seat.arrive_at + timedelta(minutes=transfer_minutes)
        if arrive > current.start_at:
            return None
    else:
        transfer = terminal_transfer(previous.end_node, seat.origin, transition.ready_at, cfg)
        if transfer is None:
            return None
        transfer_minutes, steps = transfer
        reach_seat = transition.ready_at + timedelta(minutes=transfer_minutes)
        if reach_seat > seat.depart_at or seat.arrive_at > current.start_at:
            return None
        arrive = seat.arrive_at

    return _RideCandidate(
        rider_worker_id=rider_worker_id,
        previous_id=previous.id,
        current_id=current.id,
        driver_worker_id=driver_worker_id,
        driver_task_id=seat.task.id,
        direction=seat.direction,
        depart_at=seat.depart_at,
        vehicle_leg_arrive_at=seat.arrive_at,
        arrive_at=arrive,
        extra_transfer_minutes=transfer_minutes,
        steps=steps,
    )


def solve(
    tasks: Iterable[Task],
    workers: Iterable[Worker],
    cfg: OptimizerConfig,
    *,
    time_limit_seconds: float = 60.0,
    random_seed: int = 20260903,
) -> Solution:
    """Integrated CP-SAT assignment/sequence/companion model.

    Candidate generation is deliberately sparse. Companion seats are indexed by
    direction and time before variables are created, avoiding the old
    transition×task×worker cubic scan.
    """

    tasks = _ordered_tasks(tasks)
    workers = list(workers)
    task_by_id = {task.id: task for task in tasks}
    worker_by_id = {worker.id: worker for worker in workers}
    model = cp_model.CpModel()

    x: dict[tuple[str, str], cp_model.IntVar] = {}
    start: dict[tuple[str, str], cp_model.IntVar] = {}
    end: dict[tuple[str, str], cp_model.IntVar] = {}
    for task in tasks:
        for worker in workers:
            x[task.id, worker.id] = model.new_bool_var(f"x_{task.id}_{worker.id}")
            start[task.id, worker.id] = model.new_bool_var(f"start_{task.id}_{worker.id}")
            end[task.id, worker.id] = model.new_bool_var(f"end_{task.id}_{worker.id}")
        model.add(sum(x[task.id, worker.id] for worker in workers) <= 1)
        if task.fixed_worker_id:
            if task.fixed_worker_id not in worker_by_id:
                raise ValueError(f"fixed worker is not active: {task.fixed_worker_id}")
            model.add(x[task.id, task.fixed_worker_id] == 1)
            for worker in workers:
                if worker.id != task.fixed_worker_id:
                    model.add(x[task.id, worker.id] == 0)

    arcs: dict[tuple[str, str, str], cp_model.IntVar] = {}
    arc_meta: dict[tuple[str, str, str], _Arc] = {}
    incoming: dict[tuple[str, str], list[cp_model.IntVar]] = defaultdict(list)
    outgoing: dict[tuple[str, str], list[cp_model.IntVar]] = defaultdict(list)

    for i, previous in enumerate(tasks):
        for current in tasks[i + 1 :]:
            if current.start_at < previous.end_at:
                continue
            transition = build_transition(previous, current, cfg)
            if not transition.feasible:
                continue
            for worker in workers:
                key = (worker.id, previous.id, current.id)
                var = model.new_bool_var(f"a_{worker.id}_{previous.id}_{current.id}")
                arcs[key] = var
                arc_meta[key] = _Arc(worker.id, previous.id, current.id, transition.kind, transition.cost_minutes)
                model.add(var <= x[previous.id, worker.id])
                model.add(var <= x[current.id, worker.id])
                incoming[current.id, worker.id].append(var)
                outgoing[previous.id, worker.id].append(var)

    for worker in workers:
        for task in tasks:
            model.add(sum(incoming[task.id, worker.id]) + start[task.id, worker.id] == x[task.id, worker.id])
            model.add(sum(outgoing[task.id, worker.id]) + end[task.id, worker.id] == x[task.id, worker.id])
        model.add(sum(start[task.id, worker.id] for task in tasks) <= 1)
        model.add(sum(end[task.id, worker.id] for task in tasks) <= 1)

    seats_by_direction: dict[str, list[_SeatTask]] = {"out": [], "in": []}
    for task in tasks:
        seats_by_direction[_seat_task(task).direction].append(_seat_task(task))
    for direction in seats_by_direction:
        seats_by_direction[direction].sort(key=lambda seat: seat.depart_at)
    depart_times = {direction: [seat.depart_at for seat in seats] for direction, seats in seats_by_direction.items()}

    ride_candidates: dict[tuple[str, str, str], list[_RideCandidate]] = defaultdict(list)
    y: dict[tuple[str, str, str, str, str], cp_model.IntVar] = {}
    seat_usage: dict[tuple[str, str], list[cp_model.IntVar]] = defaultdict(list)

    for key, arc_var in arcs.items():
        rider_worker_id, previous_id, current_id = key
        meta = arc_meta[key]
        if meta.transition_kind not in ("ride_out", "ride_in"):
            continue
        previous = task_by_id[previous_id]
        current = task_by_id[current_id]
        transition = build_transition(previous, current, cfg)
        direction = transition.direction
        if direction is None or transition.ready_at is None:
            model.add(arc_var == 0)
            continue

        seats = seats_by_direction[direction]
        times = depart_times[direction]
        lo = bisect_left(times, transition.ready_at)
        # No useful vehicle can depart after the rider's next task starts.
        hi = bisect_right(times, current.start_at)
        for seat in seats[lo:hi]:
            # A driver task cannot simultaneously be the rider's predecessor/current task.
            if seat.task.id in (previous_id, current_id):
                continue
            # Cheap temporal pruning before terminal transfer calculations.
            if seat.arrive_at > current.start_at:
                continue
            for driver_worker in workers:
                if driver_worker.id == rider_worker_id:
                    continue
                candidate = _candidate_for_seat(rider_worker_id, previous, current, driver_worker.id, seat, cfg)
                if candidate is None:
                    continue
                ckey = (rider_worker_id, previous_id, current_id, driver_worker.id, seat.task.id)
                var = model.new_bool_var(f"ride_{'_'.join(ckey)}")
                y[ckey] = var
                ride_candidates[key].append(candidate)
                model.add(var <= arc_var)
                model.add(var <= x[seat.task.id, driver_worker.id])
                seat_usage[driver_worker.id, seat.task.id].append(var)

        compatible_vars = [
            y[rider_worker_id, previous_id, current_id, candidate.driver_worker_id, candidate.driver_task_id]
            for candidate in ride_candidates[key]
        ]
        if compatible_vars:
            model.add(sum(compatible_vars) == arc_var)
        else:
            model.add(arc_var == 0)

    for (driver_worker_id, driver_task_id), vars_ in seat_usage.items():
        model.add(sum(vars_) <= cfg.max_logistics_passengers * x[driver_task_id, driver_worker_id])

    assigned = [x[task.id, worker.id] for task in tasks for worker in workers]
    loads: list[cp_model.IntVar] = []
    for worker in workers:
        load = model.new_int_var(0, len(tasks), f"load_{worker.id}")
        model.add(load == sum(x[task.id, worker.id] for task in tasks))
        loads.append(load)
    max_load = model.new_int_var(0, len(tasks), "max_load")
    min_load = model.new_int_var(0, len(tasks), "min_load")
    model.add_max_equality(max_load, loads)
    model.add_min_equality(min_load, loads)

    movement_cost_terms = [arc_meta[key].cost_minutes * var for key, var in arcs.items() if arc_meta[key].cost_minutes]
    companion_transfer_terms = []
    for ckey, var in y.items():
        rider_worker_id, previous_id, current_id, driver_worker_id, driver_task_id = ckey
        candidate = next(
            c for c in ride_candidates[rider_worker_id, previous_id, current_id]
            if c.driver_worker_id == driver_worker_id and c.driver_task_id == driver_task_id
        )
        if candidate.extra_transfer_minutes:
            companion_transfer_terms.append(candidate.extra_transfer_minutes * var)

    coverage_weight = 1_000_000
    objective = coverage_weight * sum(assigned) - 1_000 * (max_load - min_load)
    if movement_cost_terms:
        objective -= sum(movement_cost_terms)
    if companion_transfer_terms:
        objective -= sum(companion_transfer_terms)
    model.maximize(objective)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_seconds
    solver.parameters.num_search_workers = 8
    solver.parameters.random_seed = random_seed
    status = solver.solve(model)
    status_name = solver.status_name(status)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return Solution(
            routes={worker.id: WorkerRoute(worker) for worker in workers},
            unassigned_task_ids=[task.id for task in tasks],
            solver_status=status_name,
        )

    routes: dict[str, WorkerRoute] = {worker.id: WorkerRoute(worker) for worker in workers}
    assigned_ids: set[str] = set()
    for worker in workers:
        selected = [task for task in tasks if solver.value(x[task.id, worker.id])]
        selected.sort(key=lambda task: (task.start_at, task.id))
        route = routes[worker.id]
        route.tasks.extend(selected)
        previous = None
        for task in selected:
            route.transitions[task.id] = build_transition(previous, task, cfg)
            previous = task
            assigned_ids.add(task.id)

    matches: list[CompanionMatch] = []
    for ckey, var in y.items():
        if not solver.value(var):
            continue
        rider_worker_id, previous_id, current_id, driver_worker_id, driver_task_id = ckey
        candidate = next(
            c for c in ride_candidates[rider_worker_id, previous_id, current_id]
            if c.driver_worker_id == driver_worker_id and c.driver_task_id == driver_task_id
        )
        matches.append(
            CompanionMatch(
                rider_worker_id=rider_worker_id,
                rider_task_id=current_id,
                driver_worker_id=driver_worker_id,
                driver_task_id=driver_task_id,
                direction=candidate.direction,
                depart_at=candidate.depart_at,
                vehicle_leg_arrive_at=candidate.vehicle_leg_arrive_at,
                arrive_at=candidate.arrive_at,
                steps=candidate.steps,
            )
        )

    return Solution(
        routes=routes,
        unassigned_task_ids=[task.id for task in tasks if task.id not in assigned_ids],
        companion_matches=matches,
        objective_value=int(round(solver.objective_value)),
        solver_status=status_name,
    )
