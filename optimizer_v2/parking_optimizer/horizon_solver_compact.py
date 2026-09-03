from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Iterable

from ortools.sat.python import cp_model

from .daily_solver import _candidate_for_seat, _ordered_tasks, _seat_task, _shuttle_window
from .domain import CompanyShuttleMission, CompanionMatch, OptimizerConfig, ShiftAssignment, Solution, Task, TransferStep, Transition, Worker, WorkerRoute
from .shifts import allowed_shift_types, operational_day, shift_cost, shift_duration_minutes, shift_rest_minutes
from .transitions import build_transition


def _m(base: datetime, at: datetime) -> int:
    return int((at - base).total_seconds() // 60)


def solve_horizon(
    tasks: Iterable[Task], workers: Iterable[Worker], cfg: OptimizerConfig, *,
    time_limit_seconds: float = 180.0, random_seed: int = 20260903, search_workers: int = 8,
) -> Solution:
    tasks = _ordered_tasks(tasks)
    workers = list(workers)
    routes = {w.id: WorkerRoute(w) for w in workers}
    if not tasks:
        return Solution(routes=routes, unassigned_task_ids=[], solver_status="OPTIMAL", coverage_count=0, coverage_best_bound=0.0, coverage_relative_gap=0.0)

    task_by_id = {t.id: t for t in tasks}
    worker_by_id = {w.id: w for w in workers}
    allowed = allowed_shift_types(cfg)
    max_shift = max(shift_duration_minutes(st, cfg) for st in allowed)
    max_rest = max(shift_rest_minutes(st, cfg) for st in allowed)
    base = min(t.start_at for t in tasks) - timedelta(hours=24)
    horizon = max(1, _m(base, max(t.end_at for t in tasks) + timedelta(hours=24)))
    sm = {t.id: _m(base, t.start_at) for t in tasks}
    em = {t.id: _m(base, t.end_at) for t in tasks}

    model = cp_model.CpModel()
    x, begin, finish, origin, type_at, begin_type = {}, {}, {}, {}, {}, {}
    for t in tasks:
        for w in workers:
            k = (t.id, w.id)
            x[k] = model.new_bool_var(f"x_{t.id}_{w.id}")
            begin[k] = model.new_bool_var(f"begin_{t.id}_{w.id}")
            finish[k] = model.new_bool_var(f"finish_{t.id}_{w.id}")
            origin[k] = model.new_int_var(0, horizon, f"origin_{t.id}_{w.id}")
            tvs, bvs = [], []
            for st in allowed:
                tv = model.new_bool_var(f"type_{t.id}_{w.id}_{st}")
                bv = model.new_bool_var(f"begin_type_{t.id}_{w.id}_{st}")
                type_at[t.id, w.id, st] = tv
                begin_type[t.id, w.id, st] = bv
                tvs.append(tv); bvs.append(bv)
                model.add(bv <= tv)
                model.add(origin[k] == sm[t.id]).only_enforce_if(bv)
                model.add(em[t.id] - origin[k] <= shift_duration_minutes(st, cfg)).only_enforce_if(tv)
            model.add(sum(tvs) == x[k])
            model.add(sum(bvs) == begin[k])
            if t.fixed_worker_id and t.fixed_worker_id != w.id:
                model.add(x[k] == 0)
        model.add(sum(x[t.id, w.id] for w in workers) <= 1)
        if t.fixed_worker_id:
            if t.fixed_worker_id not in worker_by_id:
                raise ValueError(f"fixed worker is not active: {t.fixed_worker_id}")
            model.add(x[t.id, t.fixed_worker_id] == 1)

    same, incoming, outgoing = {}, defaultdict(list), defaultdict(list)
    pair_transition, shuttle_window_by_pair = {}, {}
    for i, a in enumerate(tasks):
        for b in tasks[i + 1:]:
            if b.start_at < a.end_at:
                for w in workers:
                    model.add(x[a.id, w.id] + x[b.id, w.id] <= 1)
                continue
            if int((b.end_at - a.start_at).total_seconds() // 60) > max_shift:
                continue
            tr = build_transition(a, b, cfg)
            sw = _shuttle_window(a, b, tasks, cfg)
            pair_transition[a.id, b.id] = tr
            if sw is not None:
                shuttle_window_by_pair[a.id, b.id] = sw
            if not tr.feasible and sw is None:
                continue
            for w in workers:
                k = (w.id, a.id, b.id)
                v = model.new_bool_var(f"same_{w.id}_{a.id}_{b.id}")
                same[k] = v
                model.add(v <= x[a.id, w.id]); model.add(v <= x[b.id, w.id])
                incoming[b.id, w.id].append(v); outgoing[a.id, w.id].append(v)
                model.add(origin[b.id, w.id] == origin[a.id, w.id]).only_enforce_if(v)
                for st in allowed:
                    model.add(type_at[b.id, w.id, st] == type_at[a.id, w.id, st]).only_enforce_if(v)

    for w in workers:
        for t in tasks:
            model.add(sum(incoming[t.id, w.id]) + begin[t.id, w.id] == x[t.id, w.id])
            model.add(sum(outgoing[t.id, w.id]) + finish[t.id, w.id] == x[t.id, w.id])

    # Policy rest between separate work-block paths.
    for i, a in enumerate(tasks):
        for b in tasks[i + 1:]:
            gap = int((b.start_at - a.end_at).total_seconds() // 60)
            if gap < 0:
                continue
            if gap >= max_rest:
                break
            for w in workers:
                for st in allowed:
                    if gap < shift_rest_minutes(st, cfg):
                        model.add(finish[a.id, w.id] + begin_type[b.id, w.id, st] <= 1)

    seats = {"out": [], "in": []}
    for t in tasks:
        seat = _seat_task(t); seats[seat.direction].append(seat)
    for d in seats:
        seats[d].sort(key=lambda s: s.depart_at)
    depart_times = {d: [s.depart_at for s in seats[d]] for d in seats}

    # Compact companion variables: driver identity is derived from assignment x.
    y = {}
    ride_meta = {}
    seat_usage = defaultdict(list)
    rides_by_same = defaultdict(list)
    for skey, svar in same.items():
        rw, aid, bid = skey
        a, b = task_by_id[aid], task_by_id[bid]
        tr = pair_transition[aid, bid]
        if not tr.feasible or tr.kind not in ("ride_out", "ride_in") or tr.direction is None or tr.ready_at is None:
            continue
        pool, times = seats[tr.direction], depart_times[tr.direction]
        lo, hi = bisect_left(times, tr.ready_at), bisect_right(times, b.start_at)
        other_workers = [w for w in workers if w.id != rw]
        if not other_workers:
            continue
        dummy_driver = other_workers[0].id
        for seat in pool[lo:hi]:
            if seat.task.id in (aid, bid) or seat.arrive_at > b.start_at:
                continue
            candidate = _candidate_for_seat(rw, a, b, dummy_driver, seat, cfg)
            if candidate is None:
                continue
            ck = (rw, aid, bid, seat.task.id)
            v = model.new_bool_var(f"ride_{rw}_{aid}_{bid}_{seat.task.id}")
            y[ck] = v; ride_meta[ck] = candidate; rides_by_same[skey].append(v)
            model.add(v <= svar)
            model.add(v <= sum(x[seat.task.id, dw.id] for dw in other_workers))
            seat_usage[seat.task.id].append(v)

    for driver_task_id, vars_ in seat_usage.items():
        model.add(sum(vars_) <= cfg.max_logistics_passengers * sum(x[driver_task_id, w.id] for w in workers))

    z, groups, group_data = {}, defaultdict(list), {}
    for skey, svar in same.items():
        rw, aid, bid = skey
        tr = pair_transition[aid, bid]
        sw = shuttle_window_by_pair.get((aid, bid))
        if sw is None or (tr.feasible and not tr.requires_companion):
            continue
        depart, ret, stops = sw
        g = (depart, ret, stops)
        group_data[g] = (depart, ret, stops)
        v = model.new_bool_var(f"shuttle_{rw}_{aid}_{bid}")
        z[skey] = v; groups[g].append((skey, v)); model.add(v <= svar)

    for skey, svar in same.items():
        aid, bid = skey[1], skey[2]
        tr = pair_transition[aid, bid]
        modes = list(rides_by_same.get(skey, []))
        if skey in z: modes.append(z[skey])
        if tr.feasible and tr.requires_companion:
            model.add(sum(modes) == svar) if modes else model.add(svar == 0)
        elif not tr.feasible:
            model.add(z[skey] == svar) if skey in z else model.add(svar == 0)

    group_used, group_vehicle, vehicle_intervals = {}, {}, defaultdict(list)
    for gi, (g, riders) in enumerate(groups.items()):
        depart, ret, stops = group_data[g]
        used = model.new_bool_var(f"shuttle_group_{gi}"); group_used[g] = used
        rv = [v for _, v in riders]
        model.add(sum(rv) <= cfg.company_shuttle_passenger_capacity * used)
        model.add(sum(rv) >= used)
        by_worker = defaultdict(list)
        for sk, v in riders: by_worker[sk[0]].append(v)
        for vs in by_worker.values(): model.add(sum(vs) <= 1)
        duration = max(1, int((ret - depart).total_seconds()))
        start_sec = int(depart.timestamp()); end_sec = start_sec + duration
        qvars = []
        for vi in range(cfg.company_shuttle_vehicle_count):
            q = model.new_bool_var(f"shuttle_group_{gi}_vehicle_{vi}")
            group_vehicle[g, vi] = q; qvars.append(q)
            vehicle_intervals[vi].append(model.new_optional_interval_var(start_sec, duration, end_sec, q, f"shuttle_interval_{gi}_{vi}"))
        model.add(sum(qvars) == used)
    for ivs in vehicle_intervals.values():
        if ivs: model.add_no_overlap(ivs)

    coverage = sum(x.values())
    loads = []
    for w in workers:
        lv = model.new_int_var(0, len(tasks), f"load_{w.id}")
        model.add(lv == sum(x[t.id, w.id] for t in tasks)); loads.append(lv)
    max_load = model.new_int_var(0, len(tasks), "max_load"); min_load = model.new_int_var(0, len(tasks), "min_load")
    model.add_max_equality(max_load, loads); model.add_min_equality(min_load, loads)

    shift_terms = [(10 + shift_cost(st, cfg)) * v for (_, _, st), v in begin_type.items()]
    movement_terms = [pair_transition[k[1], k[2]].cost_minutes * v for k, v in same.items() if pair_transition[k[1], k[2]].cost_minutes]
    companion_terms = [meta.extra_transfer_minutes * y[k] for k, meta in ride_meta.items() if meta.extra_transfer_minutes]
    shuttle_terms = [cfg.company_shuttle_mission_cost * v for v in group_used.values()]

    model.maximize(coverage)
    s1 = cp_model.CpSolver(); s1.parameters.max_time_in_seconds = max(1.0, time_limit_seconds * .75); s1.parameters.num_search_workers = search_workers; s1.parameters.random_seed = random_seed
    status1 = s1.solve(model)
    if status1 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return Solution(routes=routes, unassigned_task_ids=[t.id for t in tasks], solver_status=s1.status_name(status1))
    found = int(round(s1.objective_value)); bound = float(s1.best_objective_bound); gap = 0.0 if bound <= 0 else max(0.0, (bound-found)/bound)

    model.add(coverage == found)
    secondary = 1000 * (max_load-min_load)
    if shift_terms: secondary += sum(shift_terms)
    if movement_terms: secondary += sum(movement_terms)
    if companion_terms: secondary += sum(companion_terms)
    if shuttle_terms: secondary += sum(shuttle_terms)
    model.minimize(secondary)
    try: model.clear_hints()
    except AttributeError: pass
    for v in list(x.values())+list(begin.values())+list(finish.values())+list(same.values())+list(type_at.values())+list(begin_type.values())+list(y.values())+list(z.values())+list(group_used.values())+list(group_vehicle.values()): model.add_hint(v, s1.value(v))
    s2 = cp_model.CpSolver(); s2.parameters.max_time_in_seconds = max(1.0, time_limit_seconds*.25); s2.parameters.num_search_workers = search_workers; s2.parameters.random_seed = random_seed+1
    status2 = s2.solve(model); chosen = s2 if status2 in (cp_model.OPTIMAL, cp_model.FEASIBLE) else s1; final_status = s2.status_name(status2) if chosen is s2 else s1.status_name(status1)

    selected_same = {(k[0], k[2]): k for k,v in same.items() if chosen.value(v)}
    assigned = set(); shifts = []
    for w in workers:
        selected = [t for t in tasks if chosen.value(x[t.id,w.id])]; selected.sort(key=lambda t:(t.start_at,t.id)); routes[w.id].tasks.extend(selected)
        previous=None; block=[]; block_start=None; block_type=None
        for t in selected:
            if chosen.value(begin[t.id,w.id]):
                if block:
                    shifts.append(ShiftAssignment(w.id, operational_day(block_start,cfg), block_type, block_start, block[-1].end_at))
                st=next(st for st in allowed if chosen.value(begin_type[t.id,w.id,st]))
                routes[w.id].transitions[t.id]=Transition(previous.id if previous else None,t.id,"shift_start",True,previous.end_at if previous else None,t.start_at,0,reason=f"new_shift:{st}")
                block=[t]; block_start=t.start_at; block_type=st
            else:
                sk=selected_same[(w.id,t.id)]
                if sk in z and chosen.value(z[sk]):
                    routes[w.id].transitions[t.id]=Transition(previous.id,t.id,"company_shuttle",True,previous.end_at,t.start_at,cfg.company_shuttle_mission_cost,steps=(TransferStep("company_shuttle",previous.end_node,t.start_node,max(0,int((t.start_at-previous.end_at).total_seconds()//60))),))
                else:
                    routes[w.id].transitions[t.id]=build_transition(previous,t,cfg)
                block.append(t)
            previous=t; assigned.add(t.id)
        if block: shifts.append(ShiftAssignment(w.id,operational_day(block_start,cfg),block_type,block_start,block[-1].end_at))

    matches=[]
    for ck,v in y.items():
        if not chosen.value(v): continue
        rw,aid,bid,driver_task_id=ck; meta=ride_meta[ck]
        driver_worker_id=next(w.id for w in workers if chosen.value(x[driver_task_id,w.id]))
        match=CompanionMatch(rw,bid,driver_worker_id,driver_task_id,meta.direction,meta.depart_at,meta.vehicle_leg_arrive_at,meta.arrive_at,meta.steps); matches.append(match)
        base_tr=routes[rw].transitions[bid]
        routes[rw].transitions[bid]=Transition(base_tr.predecessor_task_id,bid,base_tr.kind,True,base_tr.ready_at,match.arrive_at,base_tr.cost_minutes,steps=match.steps,requires_companion=True,direction=match.direction)

    missions=[]
    for gi,(g,riders) in enumerate(groups.items()):
        if not chosen.value(group_used[g]): continue
        depart,ret,stops=group_data[g]; vi=next(v for v in range(cfg.company_shuttle_vehicle_count) if chosen.value(group_vehicle[g,v])); selected=[sk for sk,var in riders if chosen.value(var)]; selected.sort()
        missions.append(CompanyShuttleMission(vi,f"cp:horizon:{gi}",depart,ret,stops,tuple(sk[0] for sk in selected),tuple(sk[2] for sk in selected)))

    return Solution(routes=routes,unassigned_task_ids=[t.id for t in tasks if t.id not in assigned],companion_matches=matches,company_shuttle_missions=missions,shift_assignments=sorted(shifts,key=lambda s:(s.worker_id,s.start_at)),objective_value=int(round(chosen.objective_value)),solver_status=final_status,coverage_count=found,coverage_best_bound=bound,coverage_relative_gap=gap,operational_day_count=len({operational_day(t.start_at,cfg) for t in tasks}),day_diagnostics=[{"mode":"continuous_24x7_compact","task_count":len(tasks),"coverage_count":found,"coverage_best_bound":bound,"coverage_relative_gap":gap,"company_shuttle_mission_count":len(missions),"shift_count":len(shifts),"global_work_mode":cfg.global_work_mode}])
