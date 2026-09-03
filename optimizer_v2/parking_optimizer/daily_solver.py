from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Iterable

from ortools.sat.python import cp_model

from .domain import CompanionMatch, OptimizerConfig, ShiftAssignment, Solution, Task, Transition, Worker, WorkerRoute
from .shifts import allowed_shift_types, eligible_shift_types, operational_day, shift_cost, shift_window
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


def _candidate_for_seat(rider_worker_id: str, previous: Task, current: Task, driver_worker_id: str, seat: _SeatTask, cfg: OptimizerConfig) -> _RideCandidate | None:
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
        rider_worker_id, previous.id, current.id, driver_worker_id, seat.task.id,
        seat.direction, seat.depart_at, seat.arrive_at, arrive, transfer_minutes, steps,
    )


def _add_greedy_hints(model: cp_model.CpModel, tasks: list[Task], workers: list[Worker], cfg: OptimizerConfig, x, shift_vars) -> None:
    """Provide a cheap physically valid starting point.

    The hint intentionally uses only transitions that do not require a companion.
    CP-SAT remains free to add companion moves and improve coverage.
    """
    previous: dict[str, Task | None] = {worker.id: None for worker in workers}
    chosen: dict[str, str] = {}
    for task in tasks:
        candidates = [worker for worker in workers if not task.fixed_worker_id or worker.id == task.fixed_worker_id]
        best = None
        for worker in candidates:
            prev = previous[worker.id]
            if prev is None:
                feasible = True
                cost = 0
            else:
                transition = build_transition(prev, task, cfg)
                feasible = transition.feasible and not transition.requires_companion
                cost = transition.cost_minutes
            if feasible:
                rank = (cost, prev.end_at if prev else datetime.min.replace(tzinfo=task.start_at.tzinfo), worker.id)
                if best is None or rank < best[0]:
                    best = (rank, worker)
        if best is None:
            continue
        worker = best[1]
        chosen[task.id] = worker.id
        previous[worker.id] = task

    for task in tasks:
        for worker in workers:
            if chosen.get(task.id) == worker.id:
                model.add_hint(x[task.id, worker.id], 1)

    if not tasks:
        return
    day = operational_day(tasks[0].start_at, cfg)
    for worker in workers:
        worker_tasks = [task for task in tasks if chosen.get(task.id) == worker.id]
        if not worker_tasks:
            continue
        common = set(allowed_shift_types(cfg))
        for task in worker_tasks:
            common &= set(eligible_shift_types(task, cfg))
        if common:
            for shift_type in allowed_shift_types(cfg):
                if shift_type in common:
                    model.add_hint(shift_vars[worker.id, day, shift_type], 1)
                    break


def solve_day(tasks: Iterable[Task], workers: Iterable[Worker], cfg: OptimizerConfig, *, time_limit_seconds: float = 60.0, random_seed: int = 20260903, search_workers: int = 8) -> Solution:
    tasks = _ordered_tasks(tasks)
    workers = list(workers)
    if not tasks:
        return Solution(routes={w.id: WorkerRoute(w) for w in workers}, unassigned_task_ids=[], solver_status="OPTIMAL", coverage_count=0, coverage_best_bound=0.0, coverage_relative_gap=0.0, operational_day_count=0)

    days = {operational_day(task.start_at, cfg) for task in tasks}
    if len(days) != 1:
        raise ValueError("solve_day requires exactly one operational day")
    day = next(iter(days))
    task_by_id = {task.id: task for task in tasks}
    worker_by_id = {worker.id: worker for worker in workers}
    model = cp_model.CpModel()
    allowed = allowed_shift_types(cfg)

    shift_vars = {}
    for worker in workers:
        vars_for_day = []
        for shift_type in allowed:
            var = model.new_bool_var(f"shift_{worker.id}_{day}_{shift_type}")
            shift_vars[worker.id, day, shift_type] = var
            vars_for_day.append(var)
        model.add(sum(vars_for_day) <= 1)

    x, start, end = {}, {}, {}
    for task in tasks:
        eligible = eligible_shift_types(task, cfg)
        for worker in workers:
            x[task.id, worker.id] = model.new_bool_var(f"x_{task.id}_{worker.id}")
            start[task.id, worker.id] = model.new_bool_var(f"start_{task.id}_{worker.id}")
            end[task.id, worker.id] = model.new_bool_var(f"end_{task.id}_{worker.id}")
            if eligible:
                model.add(x[task.id, worker.id] <= sum(shift_vars[worker.id, day, st] for st in eligible))
            else:
                model.add(x[task.id, worker.id] == 0)
        model.add(sum(x[task.id, worker.id] for worker in workers) <= 1)
        if task.fixed_worker_id:
            if task.fixed_worker_id not in worker_by_id:
                raise ValueError(f"fixed worker is not active: {task.fixed_worker_id}")
            model.add(x[task.id, task.fixed_worker_id] == 1)
            for worker in workers:
                if worker.id != task.fixed_worker_id:
                    model.add(x[task.id, worker.id] == 0)

    arcs, arc_meta = {}, {}
    incoming, outgoing = defaultdict(list), defaultdict(list)
    for i, previous in enumerate(tasks):
        for current in tasks[i + 1:]:
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

    seats_by_direction = {"out": [], "in": []}
    for task in tasks:
        seat = _seat_task(task)
        seats_by_direction[seat.direction].append(seat)
    for direction in seats_by_direction:
        seats_by_direction[direction].sort(key=lambda seat: seat.depart_at)
    depart_times = {d: [seat.depart_at for seat in seats] for d, seats in seats_by_direction.items()}

    ride_candidates = defaultdict(list)
    y = {}
    seat_usage = defaultdict(list)
    for key, arc_var in arcs.items():
        rider_worker_id, previous_id, current_id = key
        if arc_meta[key].transition_kind not in ("ride_out", "ride_in"):
            continue
        previous, current = task_by_id[previous_id], task_by_id[current_id]
        transition = build_transition(previous, current, cfg)
        direction = transition.direction
        if direction is None or transition.ready_at is None:
            model.add(arc_var == 0)
            continue
        seats, times = seats_by_direction[direction], depart_times[direction]
        lo, hi = bisect_left(times, transition.ready_at), bisect_right(times, current.start_at)
        for seat in seats[lo:hi]:
            if seat.task.id in (previous_id, current_id) or seat.arrive_at > current.start_at:
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
        compatible = [y[rider_worker_id, previous_id, current_id, c.driver_worker_id, c.driver_task_id] for c in ride_candidates[key]]
        model.add(sum(compatible) == arc_var) if compatible else model.add(arc_var == 0)

    for (driver_worker_id, driver_task_id), vars_ in seat_usage.items():
        model.add(sum(vars_) <= cfg.max_logistics_passengers * x[driver_task_id, driver_worker_id])

    assigned_vars = [x[task.id, worker.id] for task in tasks for worker in workers]
    coverage_expr = sum(assigned_vars)
    loads = []
    for worker in workers:
        load = model.new_int_var(0, len(tasks), f"load_{worker.id}")
        model.add(load == sum(x[task.id, worker.id] for task in tasks))
        loads.append(load)
    max_load = model.new_int_var(0, len(tasks), "max_load")
    min_load = model.new_int_var(0, len(tasks), "min_load")
    model.add_max_equality(max_load, loads)
    model.add_min_equality(min_load, loads)

    movement_terms = [meta.cost_minutes * arcs[key] for key, meta in arc_meta.items() if meta.cost_minutes]
    companion_terms = []
    for ckey, var in y.items():
        rw, prev, cur, dw, dtask = ckey
        candidate = next(c for c in ride_candidates[rw, prev, cur] if c.driver_worker_id == dw and c.driver_task_id == dtask)
        if candidate.extra_transfer_minutes:
            companion_terms.append(candidate.extra_transfer_minutes * var)
    shift_terms = [shift_cost(st, cfg) * var for (wid, d, st), var in shift_vars.items() if shift_cost(st, cfg)]

    _add_greedy_hints(model, tasks, workers, cfg, x, shift_vars)

    # Phase A: coverage only. No balance, movement or shift penalty can reduce it.
    phase1_seconds = max(1.0, time_limit_seconds * 0.75)
    model.maximize(coverage_expr)
    s1 = cp_model.CpSolver()
    s1.parameters.max_time_in_seconds = phase1_seconds
    s1.parameters.num_search_workers = search_workers
    s1.parameters.random_seed = random_seed
    status1 = s1.solve(model)
    if status1 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return Solution(routes={w.id: WorkerRoute(w) for w in workers}, unassigned_task_ids=[t.id for t in tasks], solver_status=s1.status_name(status1), operational_day_count=1)

    coverage_found = int(round(s1.objective_value))
    coverage_bound = float(s1.best_objective_bound)
    coverage_gap = 0.0 if coverage_bound <= 0 else max(0.0, (coverage_bound - coverage_found) / coverage_bound)

    # Phase B: freeze coverage, then improve operational quality.
    model.add(coverage_expr == coverage_found)
    secondary = 1000 * (max_load - min_load)
    if shift_terms:
        secondary += sum(shift_terms)
    if movement_terms:
        secondary += sum(movement_terms)
    if companion_terms:
        secondary += sum(companion_terms)
    model.minimize(secondary)

    # The phase-A incumbent is a high-quality hint for phase B.
    try:
        model.clear_hints()
    except AttributeError:
        pass
    for var in list(x.values()) + list(arcs.values()) + list(y.values()) + list(shift_vars.values()):
        model.add_hint(var, s1.value(var))

    phase2_seconds = max(1.0, time_limit_seconds - phase1_seconds)
    s2 = cp_model.CpSolver()
    s2.parameters.max_time_in_seconds = phase2_seconds
    s2.parameters.num_search_workers = search_workers
    s2.parameters.random_seed = random_seed + 1
    status2 = s2.solve(model)
    chosen = s2 if status2 in (cp_model.OPTIMAL, cp_model.FEASIBLE) else s1
    final_status = s2.status_name(status2) if status2 in (cp_model.OPTIMAL, cp_model.FEASIBLE) else s1.status_name(status1)

    shift_assignments = []
    for worker in workers:
        for shift_type in allowed:
            if chosen.value(shift_vars[worker.id, day, shift_type]):
                st, en = shift_window(day, shift_type, cfg)
                shift_assignments.append(ShiftAssignment(worker.id, day, shift_type, st, en))

    routes = {worker.id: WorkerRoute(worker) for worker in workers}
    assigned_ids = set()
    for worker in workers:
        selected = [task for task in tasks if chosen.value(x[task.id, worker.id])]
        selected.sort(key=lambda task: (task.start_at, task.id))
        route = routes[worker.id]
        route.tasks.extend(selected)
        previous = None
        for task in selected:
            route.transitions[task.id] = build_transition(previous, task, cfg)
            previous = task
            assigned_ids.add(task.id)

    matches = []
    for ckey, var in y.items():
        if not chosen.value(var):
            continue
        rw, prev, cur, dw, dtask = ckey
        candidate = next(c for c in ride_candidates[rw, prev, cur] if c.driver_worker_id == dw and c.driver_task_id == dtask)
        match = CompanionMatch(rw, cur, dw, dtask, candidate.direction, candidate.depart_at, candidate.vehicle_leg_arrive_at, candidate.arrive_at, candidate.steps)
        matches.append(match)
        base = routes[rw].transitions[cur]
        routes[rw].transitions[cur] = Transition(base.predecessor_task_id, cur, base.kind, True, base.ready_at, match.arrive_at, base.cost_minutes, steps=match.steps, requires_companion=True, direction=match.direction)

    return Solution(
        routes=routes,
        unassigned_task_ids=[task.id for task in tasks if task.id not in assigned_ids],
        companion_matches=matches,
        shift_assignments=shift_assignments,
        objective_value=int(round(chosen.objective_value)),
        solver_status=final_status,
        coverage_count=coverage_found,
        coverage_best_bound=coverage_bound,
        coverage_relative_gap=coverage_gap,
        operational_day_count=1,
    )
