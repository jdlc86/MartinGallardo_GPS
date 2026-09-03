from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Iterable

from ortools.sat.python import cp_model

from .daily_solver import _candidate_for_seat, _ordered_tasks, _seat_task, _shuttle_window
from .domain import (
    CompanyShuttleMission,
    CompanionMatch,
    OptimizerConfig,
    ShiftAssignment,
    Solution,
    Task,
    TransferStep,
    Transition,
    Worker,
    WorkerRoute,
)
from .shifts import allowed_shift_types, operational_day, shift_cost, shift_duration_minutes, shift_rest_minutes
from .transitions import build_transition


def _m(base: datetime, at: datetime) -> int:
    return int((at - base).total_seconds() // 60)


def solve_horizon(
    tasks: Iterable[Task],
    workers: Iterable[Worker],
    cfg: OptimizerConfig,
    *,
    time_limit_seconds: float = 180.0,
    random_seed: int = 20260903,
    search_workers: int = 8,
) -> Solution:
    """Solve workforce routing on one continuous 24/7 timeline.

    A worker may start a new work block at any task location after the minimum
    rest required by the policy chosen for that new block. The new block resets
    physical location because the worker reaches its first task by personal
    means. Inside a work block, every movement remains physically constrained
    by terminal transfer, companion vehicle or company shuttle.
    """
    tasks = _ordered_tasks(tasks)
    workers = list(workers)
    routes = {worker.id: WorkerRoute(worker) for worker in workers}
    if not tasks:
        return Solution(routes=routes, unassigned_task_ids=[], solver_status="OPTIMAL", coverage_count=0, coverage_best_bound=0.0, coverage_relative_gap=0.0)

    task_by_id = {task.id: task for task in tasks}
    worker_by_id = {worker.id: worker for worker in workers}
    allowed = allowed_shift_types(cfg)
    base_time = min(task.start_at for task in tasks) - timedelta(hours=24)
    horizon_end = max(task.end_at for task in tasks) + timedelta(hours=24)
    horizon_minutes = max(1, _m(base_time, horizon_end))
    start_min = {task.id: _m(base_time, task.start_at) for task in tasks}
    end_min = {task.id: _m(base_time, task.end_at) for task in tasks}

    model = cp_model.CpModel()

    # Assignment and state of the current work block at each selected task.
    x = {}
    first = {}
    route_end = {}
    shift_origin = {}
    type_at = {}
    first_type = {}
    for task in tasks:
        for worker in workers:
            key = (task.id, worker.id)
            x[key] = model.new_bool_var(f"x_{task.id}_{worker.id}")
            first[key] = model.new_bool_var(f"first_{task.id}_{worker.id}")
            route_end[key] = model.new_bool_var(f"end_{task.id}_{worker.id}")
            shift_origin[key] = model.new_int_var(0, horizon_minutes, f"shift_origin_{task.id}_{worker.id}")
            tvars = []
            ftvars = []
            for st in allowed:
                tv = model.new_bool_var(f"type_{task.id}_{worker.id}_{st}")
                fv = model.new_bool_var(f"first_type_{task.id}_{worker.id}_{st}")
                type_at[task.id, worker.id, st] = tv
                first_type[task.id, worker.id, st] = fv
                tvars.append(tv)
                ftvars.append(fv)
                model.add(fv <= tv)
                model.add(shift_origin[key] == start_min[task.id]).only_enforce_if(fv)
                # The whole block must fit inside the selected policy duration.
                model.add(end_min[task.id] - shift_origin[key] <= shift_duration_minutes(st, cfg)).only_enforce_if(tv)
            model.add(sum(tvars) == x[key])
            model.add(sum(ftvars) == first[key])
            if task.fixed_worker_id and task.fixed_worker_id != worker.id:
                model.add(x[key] == 0)
        model.add(sum(x[task.id, worker.id] for worker in workers) <= 1)
        if task.fixed_worker_id:
            if task.fixed_worker_id not in worker_by_id:
                raise ValueError(f"fixed worker is not active: {task.fixed_worker_id}")
            model.add(x[task.id, task.fixed_worker_id] == 1)

    # One overall path per worker. Path edges are either within the same work
    # block, or start a new block after policy-specific rest.
    same = {}
    restart = {}
    incoming = defaultdict(list)
    outgoing = defaultdict(list)
    pair_transition = {}
    shuttle_pair_window = {}

    for i, previous in enumerate(tasks):
        for current in tasks[i + 1 :]:
            if current.start_at < previous.end_at:
                continue
            pair = (previous.id, current.id)
            canonical = build_transition(previous, current, cfg)
            shuttle_window = _shuttle_window(previous, current, tasks, cfg)
            pair_transition[pair] = canonical
            if shuttle_window is not None:
                shuttle_pair_window[pair] = shuttle_window
            gap_minutes = max(0, int((current.start_at - previous.end_at).total_seconds() // 60))

            for worker in workers:
                w = worker.id
                # Continue same work block only when physical movement is possible.
                if canonical.feasible or shuttle_window is not None:
                    skey = (w, previous.id, current.id)
                    svar = model.new_bool_var(f"same_{w}_{previous.id}_{current.id}")
                    same[skey] = svar
                    model.add(svar <= x[previous.id, w])
                    model.add(svar <= x[current.id, w])
                    incoming[current.id, w].append(svar)
                    outgoing[previous.id, w].append(svar)
                    model.add(shift_origin[current.id, w] == shift_origin[previous.id, w]).only_enforce_if(svar)
                    for st in allowed:
                        model.add(type_at[current.id, w, st] == type_at[previous.id, w, st]).only_enforce_if(svar)

                # A new work block may start at current after the required rest.
                for st in allowed:
                    if gap_minutes < shift_rest_minutes(st, cfg):
                        continue
                    if end_min[current.id] - start_min[current.id] > shift_duration_minutes(st, cfg):
                        continue
                    rkey = (w, previous.id, current.id, st)
                    rvar = model.new_bool_var(f"restart_{w}_{previous.id}_{current.id}_{st}")
                    restart[rkey] = rvar
                    model.add(rvar <= x[previous.id, w])
                    model.add(rvar <= x[current.id, w])
                    model.add(rvar <= type_at[current.id, w, st])
                    model.add(shift_origin[current.id, w] == start_min[current.id]).only_enforce_if(rvar)
                    incoming[current.id, w].append(rvar)
                    outgoing[previous.id, w].append(rvar)

    for worker in workers:
        w = worker.id
        for task in tasks:
            model.add(sum(incoming[task.id, w]) + first[task.id, w] == x[task.id, w])
            model.add(sum(outgoing[task.id, w]) + route_end[task.id, w] == x[task.id, w])
        model.add(sum(first[task.id, w] for task in tasks) <= 1)
        model.add(sum(route_end[task.id, w] for task in tasks) <= 1)

    # Companion candidates for same-block arcs requiring a customer-car seat.
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
    for skey, same_var in same.items():
        rider_worker_id, previous_id, current_id = skey
        previous = task_by_id[previous_id]
        current = task_by_id[current_id]
        canonical = pair_transition[previous_id, current_id]
        if not canonical.feasible or canonical.kind not in ("ride_out", "ride_in") or canonical.direction is None or canonical.ready_at is None:
            continue
        seats = seats_by_direction[canonical.direction]
        times = depart_times[canonical.direction]
        lo = bisect_left(times, canonical.ready_at)
        hi = bisect_right(times, current.start_at)
        for seat in seats[lo:hi]:
            if seat.task.id in (previous_id, current_id) or seat.arrive_at > current.start_at:
                continue
            for driver in workers:
                if driver.id == rider_worker_id:
                    continue
                candidate = _candidate_for_seat(rider_worker_id, previous, current, driver.id, seat, cfg)
                if candidate is None:
                    continue
                ckey = (rider_worker_id, previous_id, current_id, driver.id, seat.task.id)
                var = model.new_bool_var(f"ride_{rider_worker_id}_{previous_id}_{current_id}_{driver.id}_{seat.task.id}")
                y[ckey] = var
                ride_candidates[skey].append(candidate)
                model.add(var <= same_var)
                model.add(var <= x[seat.task.id, driver.id])
                seat_usage[driver.id, seat.task.id].append(var)

    for (driver_worker_id, driver_task_id), vars_ in seat_usage.items():
        model.add(sum(vars_) <= cfg.max_logistics_passengers * x[driver_task_id, driver_worker_id])

    # Native company-shuttle rescue for same-block physical transitions.
    z = {}
    group_riders = defaultdict(list)
    group_data = {}
    z_by_same = {}
    for skey, same_var in same.items():
        worker_id, previous_id, current_id = skey
        canonical = pair_transition[previous_id, current_id]
        window = shuttle_pair_window.get((previous_id, current_id))
        rescue_allowed = window is not None and (not canonical.feasible or canonical.requires_companion)
        if not rescue_allowed:
            continue
        depart, ret, stops = window
        group_key = (depart, ret, stops)
        group_data[group_key] = (depart, ret, stops)
        var = model.new_bool_var(f"shuttle_{worker_id}_{previous_id}_{current_id}")
        z[skey] = var
        z_by_same[skey] = var
        group_riders[group_key].append((skey, var))
        model.add(var <= same_var)

    for skey, same_var in same.items():
        previous_id, current_id = skey[1], skey[2]
        canonical = pair_transition[previous_id, current_id]
        transport_vars = []
        for candidate in ride_candidates.get(skey, []):
            transport_vars.append(y[skey[0], previous_id, current_id, candidate.driver_worker_id, candidate.driver_task_id])
        if skey in z_by_same:
            transport_vars.append(z_by_same[skey])
        if canonical.feasible and canonical.requires_companion:
            model.add(sum(transport_vars) == same_var) if transport_vars else model.add(same_var == 0)
        elif not canonical.feasible:
            model.add(z_by_same[skey] == same_var) if skey in z_by_same else model.add(same_var == 0)

    group_used = {}
    group_vehicle = {}
    vehicle_intervals = defaultdict(list)
    for index, (group_key, rider_vars) in enumerate(group_riders.items()):
        depart, ret, stops = group_data[group_key]
        used = model.new_bool_var(f"shuttle_group_used_{index}")
        group_used[group_key] = used
        vars_only = [var for _, var in rider_vars]
        model.add(sum(vars_only) <= cfg.company_shuttle_passenger_capacity * used)
        model.add(sum(vars_only) >= used)
        per_worker = defaultdict(list)
        for skey, var in rider_vars:
            per_worker[skey[0]].append(var)
        for worker_vars in per_worker.values():
            model.add(sum(worker_vars) <= 1)

        duration = max(1, int((ret - depart).total_seconds()))
        start_seconds = int(depart.timestamp())
        end_seconds = start_seconds + duration
        vehicle_vars = []
        for vehicle_index in range(cfg.company_shuttle_vehicle_count):
            q = model.new_bool_var(f"shuttle_group_{index}_vehicle_{vehicle_index}")
            group_vehicle[group_key, vehicle_index] = q
            vehicle_vars.append(q)
            interval = model.new_optional_interval_var(start_seconds, duration, end_seconds, q, f"shuttle_interval_{index}_{vehicle_index}")
            vehicle_intervals[vehicle_index].append(interval)
        model.add(sum(vehicle_vars) == used)
    for intervals in vehicle_intervals.values():
        if intervals:
            model.add_no_overlap(intervals)

    coverage_expr = sum(x.values())
    loads = []
    for worker in workers:
        load = model.new_int_var(0, len(tasks), f"load_{worker.id}")
        model.add(load == sum(x[task.id, worker.id] for task in tasks))
        loads.append(load)
    max_load = model.new_int_var(0, len(tasks), "max_load")
    min_load = model.new_int_var(0, len(tasks), "min_load")
    model.add_max_equality(max_load, loads)
    model.add_min_equality(min_load, loads)

    shift_terms = []
    for (task_id, worker_id, st), var in first_type.items():
        shift_terms.append((10 + shift_cost(st, cfg)) * var)
    for (worker_id, previous_id, current_id, st), var in restart.items():
        shift_terms.append((10 + shift_cost(st, cfg)) * var)
    movement_terms = []
    for skey, var in same.items():
        canonical = pair_transition[skey[1], skey[2]]
        if canonical.cost_minutes:
            movement_terms.append(canonical.cost_minutes * var)
    companion_terms = []
    for ckey, var in y.items():
        rw, prev, cur, dw, dtask = ckey
        candidate = next(c for c in ride_candidates[rw, prev, cur] if c.driver_worker_id == dw and c.driver_task_id == dtask)
        if candidate.extra_transfer_minutes:
            companion_terms.append(candidate.extra_transfer_minutes * var)
    shuttle_terms = [cfg.company_shuttle_mission_cost * used for used in group_used.values()]

    # Phase A: coverage is lexicographically dominant.
    phase1_seconds = max(1.0, time_limit_seconds * 0.75)
    model.maximize(coverage_expr)
    s1 = cp_model.CpSolver()
    s1.parameters.max_time_in_seconds = phase1_seconds
    s1.parameters.num_search_workers = search_workers
    s1.parameters.random_seed = random_seed
    status1 = s1.solve(model)
    if status1 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return Solution(routes=routes, unassigned_task_ids=[t.id for t in tasks], solver_status=s1.status_name(status1))

    coverage_found = int(round(s1.objective_value))
    coverage_bound = float(s1.best_objective_bound)
    coverage_gap = 0.0 if coverage_bound <= 0 else max(0.0, (coverage_bound - coverage_found) / coverage_bound)

    # Phase B: freeze coverage and improve operational quality.
    model.add(coverage_expr == coverage_found)
    secondary = 1000 * (max_load - min_load)
    if shift_terms:
        secondary += sum(shift_terms)
    if movement_terms:
        secondary += sum(movement_terms)
    if companion_terms:
        secondary += sum(companion_terms)
    if shuttle_terms:
        secondary += sum(shuttle_terms)
    model.minimize(secondary)

    try:
        model.clear_hints()
    except AttributeError:
        pass
    hint_vars = list(x.values()) + list(first.values()) + list(same.values()) + list(restart.values()) + list(type_at.values()) + list(first_type.values()) + list(y.values()) + list(z.values()) + list(group_used.values()) + list(group_vehicle.values())
    for var in hint_vars:
        model.add_hint(var, s1.value(var))

    phase2_seconds = max(1.0, time_limit_seconds - phase1_seconds)
    s2 = cp_model.CpSolver()
    s2.parameters.max_time_in_seconds = phase2_seconds
    s2.parameters.num_search_workers = search_workers
    s2.parameters.random_seed = random_seed + 1
    status2 = s2.solve(model)
    chosen = s2 if status2 in (cp_model.OPTIMAL, cp_model.FEASIBLE) else s1
    final_status = s2.status_name(status2) if status2 in (cp_model.OPTIMAL, cp_model.FEASIBLE) else s1.status_name(status1)

    selected_same_by_current = {}
    for skey, var in same.items():
        if chosen.value(var):
            selected_same_by_current[skey[0], skey[2]] = skey
    selected_restart_by_current = {}
    for rkey, var in restart.items():
        if chosen.value(var):
            selected_restart_by_current[rkey[0], rkey[2]] = rkey

    assigned_ids = set()
    shift_assignments = []
    for worker in workers:
        w = worker.id
        selected = [task for task in tasks if chosen.value(x[task.id, w])]
        selected.sort(key=lambda task: (task.start_at, task.id))
        routes[w].tasks.extend(selected)
        current_shift_start = None
        current_shift_type = None
        current_shift_tasks = []
        previous = None
        for task in selected:
            restart_key = selected_restart_by_current.get((w, task.id))
            starts_new = previous is None or restart_key is not None
            if starts_new:
                if current_shift_tasks:
                    last = current_shift_tasks[-1]
                    shift_assignments.append(ShiftAssignment(w, operational_day(current_shift_start, cfg), current_shift_type, current_shift_start, last.end_at))
                if restart_key is not None:
                    st = restart_key[3]
                    routes[w].transitions[task.id] = Transition(previous.id, task.id, "shift_start", True, previous.end_at, task.start_at, 0, reason=f"rest_complete:{st}")
                else:
                    st = next(st for st in allowed if chosen.value(first_type[task.id, w, st]))
                    routes[w].transitions[task.id] = Transition(None, task.id, "shift_start", True, None, task.start_at)
                current_shift_start = task.start_at
                current_shift_type = st
                current_shift_tasks = [task]
            else:
                skey = selected_same_by_current.get((w, task.id))
                if skey is None:
                    raise RuntimeError(f"missing selected path edge for {w}/{task.id}")
                if skey in z and chosen.value(z[skey]):
                    routes[w].transitions[task.id] = Transition(
                        previous.id,
                        task.id,
                        "company_shuttle",
                        True,
                        previous.end_at,
                        task.start_at,
                        cfg.company_shuttle_mission_cost,
                        steps=(TransferStep("company_shuttle", previous.end_node, task.start_node, max(0, int((task.start_at - previous.end_at).total_seconds() // 60))),),
                    )
                else:
                    routes[w].transitions[task.id] = build_transition(previous, task, cfg)
                current_shift_tasks.append(task)
            previous = task
            assigned_ids.add(task.id)
        if current_shift_tasks:
            last = current_shift_tasks[-1]
            shift_assignments.append(ShiftAssignment(w, operational_day(current_shift_start, cfg), current_shift_type, current_shift_start, last.end_at))

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

    missions = []
    for index, (group_key, rider_vars) in enumerate(group_riders.items()):
        if not chosen.value(group_used[group_key]):
            continue
        depart, ret, stops = group_data[group_key]
        vehicle_index = next(v for v in range(cfg.company_shuttle_vehicle_count) if chosen.value(group_vehicle[group_key, v]))
        selected_riders = [skey for skey, var in rider_vars if chosen.value(var)]
        selected_riders.sort()
        missions.append(CompanyShuttleMission(
            vehicle_index,
            f"cp:horizon:{index}",
            depart,
            ret,
            stops,
            tuple(skey[0] for skey in selected_riders),
            tuple(skey[2] for skey in selected_riders),
        ))

    return Solution(
        routes=routes,
        unassigned_task_ids=[task.id for task in tasks if task.id not in assigned_ids],
        companion_matches=matches,
        company_shuttle_missions=missions,
        shift_assignments=sorted(shift_assignments, key=lambda s: (s.worker_id, s.start_at)),
        objective_value=int(round(chosen.objective_value)),
        solver_status=final_status,
        coverage_count=coverage_found,
        coverage_best_bound=coverage_bound,
        coverage_relative_gap=coverage_gap,
        operational_day_count=len({operational_day(task.start_at, cfg) for task in tasks}),
        day_diagnostics=[{
            "mode": "continuous_24x7",
            "task_count": len(tasks),
            "coverage_count": coverage_found,
            "coverage_best_bound": coverage_bound,
            "coverage_relative_gap": coverage_gap,
            "company_shuttle_vehicle_count": cfg.company_shuttle_vehicle_count,
            "company_shuttle_mission_count": len(missions),
            "shift_count": len(shift_assignments),
            "global_work_mode": cfg.global_work_mode,
        }],
    )
