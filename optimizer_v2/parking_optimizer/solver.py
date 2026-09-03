from __future__ import annotations

from collections import defaultdict
from typing import Iterable

from .daily_solver import solve_day
from .domain import OptimizerConfig, Solution, Task, Worker, WorkerRoute
from .rescue_augment import augment_with_company_shuttles
from .shifts import operational_day
from .transitions import build_transition


def _mobility_diagnostics(day_tasks: list[Task], cfg: OptimizerConfig) -> dict[str, object]:
    ordered=sorted(day_tasks,key=lambda t:(t.start_at,t.end_at,t.id)); p=sum(t.task_type=="pickup" for t in ordered); d=len(ordered)-p
    direct=out=inn=0
    for i,a in enumerate(ordered):
        for b in ordered[i+1:]:
            tr=build_transition(a,b,cfg)
            if not tr.feasible: continue
            if tr.kind=="ride_out": out+=1
            elif tr.kind=="ride_in": inn+=1
            elif not tr.requires_companion: direct+=1
    bottleneck="none"; detail=None
    if ordered and d==len(ordered) and direct==0:
        bottleneck="airport_stranding_no_return_vehicle"; detail="All tasks are deliveries; rescue fleet is required to return operators to PARKING."
    elif ordered and p==len(ordered) and direct==0:
        bottleneck="parking_stranding_no_outbound_vehicle"; detail="All tasks are pickups; rescue fleet is required to send operators from PARKING to airport."
    elif p and d and max(p,d)>=4*min(p,d):
        bottleneck="strong_directional_imbalance"; detail=f"Strong directional imbalance ({p} pickups / {d} deliveries)."
    return {"pickup_count":p,"delivery_count":d,"direct_non_companion_pair_count":direct,"ride_out_pair_count":out,"ride_in_pair_count":inn,"mobility_bottleneck":bottleneck,"mobility_bottleneck_detail":detail}


def solve(tasks: Iterable[Task], workers: Iterable[Worker], cfg: OptimizerConfig, *, time_limit_seconds: float=60.0, random_seed:int=20260903, search_workers:int=8) -> Solution:
    tasks=list(tasks); workers=list(workers); routes={w.id:WorkerRoute(w) for w in workers}
    if not tasks:
        return Solution(routes=routes,unassigned_task_ids=[],solver_status="OPTIMAL",coverage_count=0,coverage_best_bound=0.0,coverage_relative_gap=0.0,operational_day_count=0,day_diagnostics=[])
    by_day=defaultdict(list)
    for task in tasks: by_day[operational_day(task.start_at,cfg)].append(task)
    days=sorted(by_day); per_day_seconds=max(60.0,float(time_limit_seconds))
    unassigned=[]; companions=[]; missions=[]; shifts=[]; coverage=0; bound=0.0; objective=0; statuses=[]; diagnostics=[]
    for index,day in enumerate(days):
        day_tasks=by_day[day]; mobility=_mobility_diagnostics(day_tasks,cfg)
        base=solve_day(day_tasks,workers,cfg,time_limit_seconds=per_day_seconds,random_seed=random_seed+index*101,search_workers=search_workers)
        before=base.coverage_count
        day_solution=augment_with_company_shuttles(base,day_tasks,workers,cfg)
        rescued=day_solution.coverage_count-before
        # The CP-SAT bound belongs to the pre-rescue graph and ceases to be a valid bound after augmentation.
        day_bound=None if rescued else day_solution.coverage_best_bound
        statuses.append("FEASIBLE_RESCUE" if rescued else day_solution.solver_status)
        unassigned.extend(day_solution.unassigned_task_ids); companions.extend(day_solution.companion_matches); missions.extend(day_solution.company_shuttle_missions); shifts.extend(day_solution.shift_assignments)
        coverage+=day_solution.coverage_count; objective+=day_solution.objective_value or 0
        if day_bound is not None: bound+=day_bound
        diagnostics.append({"operational_day":str(day),"task_count":len(day_tasks),"coverage_count":day_solution.coverage_count,"coverage_before_rescue":before,"rescued_task_count":rescued,"unassigned_count":len(day_solution.unassigned_task_ids),"coverage_best_bound":day_bound,"coverage_relative_gap":None if rescued else day_solution.coverage_relative_gap,"solver_status":statuses[-1],"shift_count":len(day_solution.shift_assignments),"companion_count":len(day_solution.companion_matches),"company_shuttle_mission_count":len(day_solution.company_shuttle_missions),"company_shuttle_vehicle_count":cfg.company_shuttle_vehicle_count,"time_budget_seconds":per_day_seconds,**mobility})
        for wid,r in day_solution.routes.items(): routes[wid].tasks.extend(r.tasks); routes[wid].transitions.update(r.transitions)
    for r in routes.values(): r.tasks.sort(key=lambda t:(t.start_at,t.id))
    status="FEASIBLE_RESCUE" if any(s=="FEASIBLE_RESCUE" for s in statuses) else ("OPTIMAL" if all(s=="OPTIMAL" for s in statuses) else "FEASIBLE" if all(s in {"OPTIMAL","FEASIBLE"} for s in statuses) else "PARTIAL")
    # A horizon bound is only meaningful when no rescue augmentation changed the graph.
    has_rescue=bool(missions); horizon_bound=None if has_rescue else bound; gap=None if has_rescue else (0.0 if bound<=0 else max(0.0,(bound-coverage)/bound))
    return Solution(routes=routes,unassigned_task_ids=unassigned,companion_matches=companions,company_shuttle_missions=missions,shift_assignments=shifts,objective_value=objective,solver_status=status,coverage_count=coverage,coverage_best_bound=horizon_bound,coverage_relative_gap=gap,operational_day_count=len(days),day_diagnostics=diagnostics)
