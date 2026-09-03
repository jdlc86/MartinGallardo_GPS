from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Iterable

from ortools.sat.python import cp_model

from .domain import (
    CompanionMatch,
    OptimizerConfig,
    Solution,
    Task,
    Worker,
    WorkerRoute,
)
from .transitions import build_transition, terminal_transfer


@dataclass(frozen=True, slots=True)
class _Arc:
    worker_id: str
    previous_id: str
    current_id: str
    transition_kind: str
    cost_minutes: int


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


def _candidate_seat(task: Task):
    if task.task_type == "delivery":
        return "out", "PARKING", task.terminal, task.vehicle_leg_depart_at, task.vehicle_leg_arrive_at
    return "in", task.terminal, "PARKING", task.vehicle_leg_depart_at, task.vehicle_leg_arrive_at


def _ride_candidate(
    rider_worker_id: str,
    previous: Task,
    current: Task,
    driver_worker_id: str,
    driver_task: Task,
    cfg: OptimizerConfig,
) -> _RideCandidate | None:
    if rider_worker_id == driver_worker_id:
        return None
    transition = build_transition(previous, current, cfg)
    if transition.kind not in ("ride_out", "ride_in"):
        return None

    direction, seat_origin, seat_destination, depart_at, vehicle_arrive = _candidate_seat(driver_task)
    if direction != transition.direction:
        return None

    if direction == "out":
        if transition.ready_at is None or depart_at < transition.ready_at:
            return None
        transfer = terminal_transfer(seat_destination, current.start_node, vehicle_arrive, cfg)
        if transfer is None:
            return None
        transfer_minutes, steps = transfer
        arrive = vehicle_arrive if transfer_minutes == 0 else vehicle_arrive + (current.start_at - current.start_at)
        if transfer_minutes:
            from datetime import timedelta
            arrive = vehicle_arrive + timedelta(minutes=transfer_minutes)
        if arrive > current.start_at:
            return None
        return _RideCandidate(
            rider_worker_id,
            previous.id,
            current.id,
            driver_worker_id,
            driver_task.id,
            direction,
            depart_at,
            vehicle_arrive,
            arrive,
            transfer_minutes,
            steps,
        )

    if transition.ready_at is None:
        return None
    transfer = terminal_transfer(previous.end_node, seat_origin, transition.ready_at, cfg)
    if transfer is None:
        return None
    transfer_minutes, steps = transfer
    from datetime import timedelta
    reach_seat = transition.ready_at + timedelta(minutes=transfer_minutes)
    if reach_seat > depart_at or vehicle_arrive > current.start_at:
        return None
    return _RideCandidate(
        rider_worker_id,
        previous.id,
        current.id,
        driver_worker_id,
        driver_task.id,
        direction,
        depart_at,
        vehicle_arrive,
        vehicle_arrive,
        transfer_minutes,
        steps,
    )


def solve(
    tasks: Iterable[Task],
    workers: Iterable[Worker],
    cfg: OptimizerConfig,
    *,
    time_limit_seconds: float = 60.0,
    random_seed: int = 20260903,
) -> Solution:
    """Solve assignment, physical succession and companion capacity in one CP-SAT model.

    Task times are fixed by the reservation/timing layer. The model chooses which
    tasks to cover, who covers them, which tasks are consecutive for every worker,
    and which other assigned customer-car movement transports a worker whenever a
    Parking<->terminal reposition is required.
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
        # If a worker has any selected task, the DAG flow equations force one start and one end.

    ride_candidates: dict[tuple[str, str, str], list[_RideCandidate]] = defaultdict(list)
    y: dict[tuple[str, str, str, str, str], cp_model.IntVar] = {}
    seat_usage: dict[tuple[str, str], list[cp_model.IntVar]] = defaultdict(list)

    for key, arc_var in arcs.items():
        worker_id, previous_id, current_id = key
        meta = arc_meta[key]
        if meta.transition_kind not in ("ride_out", "ride_in"):
            continue
        previous = task_by_id[previous_id]
        current = task_by_id[current_id]
        for driver_worker in workers:
            if driver_worker.id == worker_id:
                continue
            for driver_task in tasks:
                candidate = _ride_candidate(worker_id, previous, current, driver_worker.id, driver_task, cfg)
                if candidate is None:
                    continue
                ckey = (worker_id, previous_id, current_id, driver_worker.id, driver_task.id)
                var = model.new_bool_var(f"ride_{'_'.join(ckey)}")
                y[ckey] = var
                ride_candidates[key].append(candidate)
                model.add(var <= arc_var)
                model.add(var <= x[driver_task.id, driver_worker.id])
                seat_usage[driver_worker.id, driver_task.id].append(var)

        compatible_vars = [
            y[worker_id, previous_id, current_id, c.driver_worker_id, c.driver_task_id]
            for c in ride_candidates[key]
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

    movement_cost_terms = []
    for key, var in arcs.items():
        cost = arc_meta[key].cost_minutes
        if cost:
            movement_cost_terms.append(cost * var)
    companion_transfer_terms = []
    for ckey, var in y.items():
        worker_id, previous_id, current_id, driver_worker_id, driver_task_id = ckey
        candidate = next(
            c for c in ride_candidates[worker_id, previous_id, current_id]
            if c.driver_worker_id == driver_worker_id and c.driver_task_id == driver_task_id
        )
        if candidate.extra_transfer_minutes:
            companion_transfer_terms.append(candidate.extra_transfer_minutes * var)

    # Dominant coverage term makes the objective lexicographic in practice:
    # no amount of movement/load improvement can compensate for one lost task.
    coverage_weight = 1_000_000
    objective = coverage_weight * sum(assigned)
    objective -= 1_000 * (max_load - min_load)
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
        worker_id, previous_id, current_id, driver_worker_id, driver_task_id = ckey
        candidate = next(
            c for c in ride_candidates[worker_id, previous_id, current_id]
            if c.driver_worker_id == driver_worker_id and c.driver_task_id == driver_task_id
        )
        matches.append(
            CompanionMatch(
                rider_worker_id=worker_id,
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
