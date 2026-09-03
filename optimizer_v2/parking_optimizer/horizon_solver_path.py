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


def solve_horizon(tasks: Iterable[Task], workers: Iterable[Worker], cfg: OptimizerConfig, *, time_limit_seconds: float=180.0, random_seed: int=20260903, search_workers: int=8) -> Solution:
    tasks=_ordered_tasks(tasks); workers=list(workers); routes={w.id:WorkerRoute(w) for w in workers}
    if not tasks:
        return Solution(routes=routes,unassigned_task_ids=[],solver_status="OPTIMAL",coverage_count=0,coverage_best_bound=0.0,coverage_relative_gap=0.0)
    tb={t.id:t for t in tasks}; wb={w.id:w for w in workers}; allowed=allowed_shift_types(cfg)
    max_shift=max(shift_duration_minutes(st,cfg) for st in allowed); min_rest=min(shift_rest_minutes(st,cfg) for st in allowed)
    base=min(t.start_at for t in tasks)-timedelta(hours=24); horizon=max(1,_m(base,max(t.end_at for t in tasks)+timedelta(hours=24)))
    sm={t.id:_m(base,t.start_at) for t in tasks}; em={t.id:_m(base,t.end_at) for t in tasks}
    model=cp_model.CpModel()

    x={}; first={}; route_end={}; origin={}; type_at={}; start_marker={}; start_type={}
    for t in tasks:
        for w in workers:
            k=(t.id,w.id); x[k]=model.new_bool_var(f"x_{t.id}_{w.id}"); first[k]=model.new_bool_var(f"first_{t.id}_{w.id}"); route_end[k]=model.new_bool_var(f"end_{t.id}_{w.id}"); origin[k]=model.new_int_var(0,horizon,f"origin_{t.id}_{w.id}"); start_marker[k]=model.new_bool_var(f"block_start_{t.id}_{w.id}")
            tv=[]; sv=[]
            for st in allowed:
                typ=model.new_bool_var(f"type_{t.id}_{w.id}_{st}"); sta=model.new_bool_var(f"start_type_{t.id}_{w.id}_{st}")
                type_at[t.id,w.id,st]=typ; start_type[t.id,w.id,st]=sta; tv.append(typ); sv.append(sta)
                model.add(sta<=typ); model.add(sta<=start_marker[k]); model.add(sta>=typ+start_marker[k]-1)
                model.add(em[t.id]-origin[k] <= shift_duration_minutes(st,cfg)).only_enforce_if(typ)
                model.add(origin[k]==sm[t.id]).only_enforce_if(sta)
            model.add(sum(tv)==x[k]); model.add(sum(sv)==start_marker[k])
            if t.fixed_worker_id and t.fixed_worker_id!=w.id: model.add(x[k]==0)
        model.add(sum(x[t.id,w.id] for w in workers)<=1)
        if t.fixed_worker_id:
            if t.fixed_worker_id not in wb: raise ValueError(f"fixed worker is not active: {t.fixed_worker_id}")
            model.add(x[t.id,t.fixed_worker_id]==1)

    same={}; restart={}; incoming=defaultdict(list); outgoing=defaultdict(list); pair_tr={}; shuttle_windows={}
    for i,a in enumerate(tasks):
        for b in tasks[i+1:]:
            if b.start_at<a.end_at: continue
            gap=int((b.start_at-a.end_at).total_seconds()//60)
            tr=build_transition(a,b,cfg); sw=_shuttle_window(a,b,tasks,cfg)
            pair_tr[a.id,b.id]=tr
            if sw is not None: shuttle_windows[a.id,b.id]=sw
            same_possible=int((b.end_at-a.start_at).total_seconds()//60)<=max_shift and (tr.feasible or sw is not None)
            restart_possible=gap>=min_rest
            if not same_possible and not restart_possible: continue
            for w in workers:
                if same_possible:
                    sk=(w.id,a.id,b.id); sv=model.new_bool_var(f"same_{w.id}_{a.id}_{b.id}"); same[sk]=sv; model.add(sv<=x[a.id,w.id]); model.add(sv<=x[b.id,w.id]); incoming[b.id,w.id].append(sv); outgoing[a.id,w.id].append(sv); model.add(origin[b.id,w.id]==origin[a.id,w.id]).only_enforce_if(sv)
                    for st in allowed: model.add(type_at[b.id,w.id,st]==type_at[a.id,w.id,st]).only_enforce_if(sv)
                if restart_possible:
                    rk=(w.id,a.id,b.id); rv=model.new_bool_var(f"restart_{w.id}_{a.id}_{b.id}"); restart[rk]=rv; model.add(rv<=x[a.id,w.id]); model.add(rv<=x[b.id,w.id]); incoming[b.id,w.id].append(rv); outgoing[a.id,w.id].append(rv); model.add(origin[b.id,w.id]==sm[b.id]).only_enforce_if(rv)
                    for st in allowed:
                        if gap<shift_rest_minutes(st,cfg): model.add(rv+type_at[b.id,w.id,st]<=1)

    restart_in=defaultdict(list)
    for (w,a,b),v in restart.items(): restart_in[b,w].append(v)
    for w in workers:
        for t in tasks:
            model.add(sum(incoming[t.id,w.id])+first[t.id,w.id]==x[t.id,w.id]); model.add(sum(outgoing[t.id,w.id])+route_end[t.id,w.id]==x[t.id,w.id]); model.add(start_marker[t.id,w.id]==first[t.id,w.id]+sum(restart_in[t.id,w.id]))
        model.add(sum(first[t.id,w.id] for t in tasks)<=1); model.add(sum(route_end[t.id,w.id] for t in tasks)<=1)

    seats={"out":[],"in":[]}
    for t in tasks:
        s=_seat_task(t); seats[s.direction].append(s)
    for d in seats: seats[d].sort(key=lambda s:s.depart_at)
    times={d:[s.depart_at for s in seats[d]] for d in seats}

    y={}; ride_meta={}; rides_by_same=defaultdict(list); seat_usage=defaultdict(list)
    for sk,svar in same.items():
        rw,aid,bid=sk; a,b=tb[aid],tb[bid]; tr=pair_tr[aid,bid]
        if not tr.feasible or tr.kind not in ("ride_out","ride_in") or tr.direction is None or tr.ready_at is None: continue
        others=[w for w in workers if w.id!=rw]
        if not others: continue
        pool=seats[tr.direction]; ts=times[tr.direction]; lo,hi=bisect_left(ts,tr.ready_at),bisect_right(ts,b.start_at); dummy=others[0].id
        for seat in pool[lo:hi]:
            if seat.task.id in (aid,bid) or seat.arrive_at>b.start_at: continue
            c=_candidate_for_seat(rw,a,b,dummy,seat,cfg)
            if c is None: continue
            ck=(rw,aid,bid,seat.task.id); v=model.new_bool_var(f"ride_{rw}_{aid}_{bid}_{seat.task.id}"); y[ck]=v; ride_meta[ck]=c; rides_by_same[sk].append(v); model.add(v<=svar); model.add(v<=sum(x[seat.task.id,dw.id] for dw in others)); seat_usage[seat.task.id].append(v)
    for dtask,vs in seat_usage.items(): model.add(sum(vs)<=cfg.max_logistics_passengers*sum(x[dtask,w.id] for w in workers))

    z={}; groups=defaultdict(list); group_data={}
    for sk,svar in same.items():
        rw,aid,bid=sk; tr=pair_tr[aid,bid]; sw=shuttle_windows.get((aid,bid))
        if sw is None or (tr.feasible and not tr.requires_companion): continue
        depart,ret,stops=sw; g=(depart,ret,stops); group_data[g]=(depart,ret,stops); v=model.new_bool_var(f"shuttle_{rw}_{aid}_{bid}"); z[sk]=v; groups[g].append((sk,v)); model.add(v<=svar)
    for sk,svar in same.items():
        tr=pair_tr[sk[1],sk[2]]; modes=list(rides_by_same.get(sk,[]));
        if sk in z: modes.append(z[sk])
        if tr.feasible and tr.requires_companion: model.add(sum(modes)==svar) if modes else model.add(svar==0)
        elif not tr.feasible: model.add(z[sk]==svar) if sk in z else model.add(svar==0)

    group_used={}; group_vehicle={}; intervals=defaultdict(list)
    for gi,(g,riders) in enumerate(groups.items()):
        depart,ret,stops=group_data[g]; used=model.new_bool_var(f"group_used_{gi}"); group_used[g]=used; rv=[v for _,v in riders]; model.add(sum(rv)<=cfg.company_shuttle_passenger_capacity*used); model.add(sum(rv)>=used)
        byw=defaultdict(list)
        for sk,v in riders: byw[sk[0]].append(v)
        for vs in byw.values(): model.add(sum(vs)<=1)
        dur=max(1,int((ret-depart).total_seconds())); ss=int(depart.timestamp()); ee=ss+dur; qv=[]
        for vi in range(cfg.company_shuttle_vehicle_count):
            q=model.new_bool_var(f"group_{gi}_veh_{vi}"); group_vehicle[g,vi]=q; qv.append(q); intervals[vi].append(model.new_optional_interval_var(ss,dur,ee,q,f"int_{gi}_{vi}"))
        model.add(sum(qv)==used)
    for iv in intervals.values():
        if iv: model.add_no_overlap(iv)

    coverage=sum(x.values()); loads=[]
    for w in workers:
        lv=model.new_int_var(0,len(tasks),f"load_{w.id}"); model.add(lv==sum(x[t.id,w.id] for t in tasks)); loads.append(lv)
    max_load=model.new_int_var(0,len(tasks),"max_load"); min_load=model.new_int_var(0,len(tasks),"min_load"); model.add_max_equality(max_load,loads); model.add_min_equality(min_load,loads)
    shift_terms=[(10+shift_cost(st,cfg))*v for (_,_,st),v in start_type.items()]; movement=[pair_tr[k[1],k[2]].cost_minutes*v for k,v in same.items() if pair_tr[k[1],k[2]].cost_minutes]; companion=[ride_meta[k].extra_transfer_minutes*v for k,v in y.items() if ride_meta[k].extra_transfer_minutes]; shuttle=[cfg.company_shuttle_mission_cost*v for v in group_used.values()]

    # Cheap physically-valid greedy lower bound/hint: direct continuity first,
    # otherwise open a new block only after policy rest.
    gw={w.id:{"last":None,"block_start":None,"type":None,"block_end":None} for w in workers}; gx={}; gedges={}; gstart={}
    for t in tasks:
        candidates=[w for w in workers if not t.fixed_worker_id or t.fixed_worker_id==w.id]
        best=None
        for w in candidates:
            s=gw[w.id]; last=s["last"]
            if last is None:
                option=(0,"new","normal" if "normal" in allowed else allowed[0])
            else:
                tr=build_transition(last,t,cfg); duration=int((t.end_at-s["block_start"]).total_seconds()//60) if s["block_start"] else 10**9
                same_types=[st for st in allowed if duration<=shift_duration_minutes(st,cfg)]
                if tr.feasible and not tr.requires_companion and same_types:
                    option=(0,"same",same_types[0])
                else:
                    gap=int((t.start_at-s["block_end"]).total_seconds()//60) if s["block_end"] else -1
                    restart_types=[st for st in allowed if gap>=shift_rest_minutes(st,cfg)]
                    if not restart_types: continue
                    option=(1,"new",restart_types[0])
            rank=(option[0],len([1 for _,ww in gx.items() if ww==w.id]),w.id)
            if best is None or rank<best[0]: best=(rank,w,option)
        if best is None: continue
        _,w,option=best; gx[t.id]=w.id; state=gw[w.id]
        if option[1]=="new":
            gstart[t.id,w.id]=option[2]; state["block_start"]=t.start_at
        else:
            gedges[w.id,state["last"].id,t.id]=1
        state["last"]=t; state["block_end"]=t.end_at; state["type"]=option[2]
    greedy_count=len(gx)
    if greedy_count: model.add(coverage>=greedy_count)
    for t in tasks:
        if t.id in gx: model.add_hint(x[t.id,gx[t.id]],1)
    for k in gedges:
        if k in same: model.add_hint(same[k],1)
    for (tid,wid),st in gstart.items():
        model.add_hint(start_marker[tid,wid],1); model.add_hint(type_at[tid,wid,st],1)

    model.maximize(coverage); s1=cp_model.CpSolver(); s1.parameters.max_time_in_seconds=max(1.0,time_limit_seconds*.75); s1.parameters.num_search_workers=search_workers; s1.parameters.random_seed=random_seed; status1=s1.solve(model)
    if status1 not in (cp_model.OPTIMAL,cp_model.FEASIBLE): return Solution(routes=routes,unassigned_task_ids=[t.id for t in tasks],solver_status=s1.status_name(status1))
    found=int(round(s1.objective_value)); bound=float(s1.best_objective_bound); gap=0.0 if bound<=0 else max(0.0,(bound-found)/bound)
    model.add(coverage==found); secondary=1000*(max_load-min_load)
    if shift_terms: secondary+=sum(shift_terms)
    if movement: secondary+=sum(movement)
    if companion: secondary+=sum(companion)
    if shuttle: secondary+=sum(shuttle)
    model.minimize(secondary)
    try: model.clear_hints()
    except AttributeError: pass
    for v in list(x.values())+list(first.values())+list(route_end.values())+list(start_marker.values())+list(same.values())+list(restart.values())+list(type_at.values())+list(start_type.values())+list(y.values())+list(z.values())+list(group_used.values())+list(group_vehicle.values()): model.add_hint(v,s1.value(v))
    s2=cp_model.CpSolver(); s2.parameters.max_time_in_seconds=max(1.0,time_limit_seconds*.25); s2.parameters.num_search_workers=search_workers; s2.parameters.random_seed=random_seed+1; status2=s2.solve(model); chosen=s2 if status2 in (cp_model.OPTIMAL,cp_model.FEASIBLE) else s1; final=s2.status_name(status2) if chosen is s2 else s1.status_name(status1)

    selected_same={(k[0],k[2]):k for k,v in same.items() if chosen.value(v)}; selected_restart={(k[0],k[2]):k for k,v in restart.items() if chosen.value(v)}; assigned=set(); shifts=[]
    for w in workers:
        selected=[t for t in tasks if chosen.value(x[t.id,w.id])]; selected.sort(key=lambda t:(t.start_at,t.id)); routes[w.id].tasks.extend(selected); previous=None; block=[]; bs=None; bst=None
        for t in selected:
            rk=selected_restart.get((w.id,t.id)); is_start=previous is None or rk is not None
            if is_start:
                if block: shifts.append(ShiftAssignment(w.id,operational_day(bs,cfg),bst,bs,block[-1].end_at))
                st=next(st for st in allowed if chosen.value(type_at[t.id,w.id,st])); routes[w.id].transitions[t.id]=Transition(previous.id if previous else None,t.id,"shift_start",True,previous.end_at if previous else None,t.start_at,0,reason=f"new_shift:{st}"); block=[t]; bs=t.start_at; bst=st
            else:
                sk=selected_same[(w.id,t.id)]
                if sk in z and chosen.value(z[sk]): routes[w.id].transitions[t.id]=Transition(previous.id,t.id,"company_shuttle",True,previous.end_at,t.start_at,cfg.company_shuttle_mission_cost,steps=(TransferStep("company_shuttle",previous.end_node,t.start_node,max(0,int((t.start_at-previous.end_at).total_seconds()//60))),))
                else: routes[w.id].transitions[t.id]=build_transition(previous,t,cfg)
                block.append(t)
            previous=t; assigned.add(t.id)
        if block: shifts.append(ShiftAssignment(w.id,operational_day(bs,cfg),bst,bs,block[-1].end_at))

    matches=[]
    for ck,v in y.items():
        if not chosen.value(v): continue
        rw,aid,bid,dtask=ck; meta=ride_meta[ck]; dw=next(w.id for w in workers if chosen.value(x[dtask,w.id])); match=CompanionMatch(rw,bid,dw,dtask,meta.direction,meta.depart_at,meta.vehicle_leg_arrive_at,meta.arrive_at,meta.steps); matches.append(match); bt=routes[rw].transitions[bid]; routes[rw].transitions[bid]=Transition(bt.predecessor_task_id,bid,bt.kind,True,bt.ready_at,match.arrive_at,bt.cost_minutes,steps=match.steps,requires_companion=True,direction=match.direction)
    missions=[]
    for gi,(g,riders) in enumerate(groups.items()):
        if not chosen.value(group_used[g]): continue
        depart,ret,stops=group_data[g]; vi=next(v for v in range(cfg.company_shuttle_vehicle_count) if chosen.value(group_vehicle[g,v])); sr=[sk for sk,var in riders if chosen.value(var)]; sr.sort(); missions.append(CompanyShuttleMission(vi,f"cp:horizon:{gi}",depart,ret,stops,tuple(sk[0] for sk in sr),tuple(sk[2] for sk in sr)))
    return Solution(routes=routes,unassigned_task_ids=[t.id for t in tasks if t.id not in assigned],companion_matches=matches,company_shuttle_missions=missions,shift_assignments=sorted(shifts,key=lambda s:(s.worker_id,s.start_at)),objective_value=int(round(chosen.objective_value)),solver_status=final,coverage_count=found,coverage_best_bound=bound,coverage_relative_gap=gap,operational_day_count=len({operational_day(t.start_at,cfg) for t in tasks}),day_diagnostics=[{"mode":"continuous_24x7_path","task_count":len(tasks),"coverage_count":found,"coverage_best_bound":bound,"coverage_relative_gap":gap,"greedy_lower_bound":greedy_count,"company_shuttle_mission_count":len(missions),"shift_count":len(shifts),"global_work_mode":cfg.global_work_mode}])
