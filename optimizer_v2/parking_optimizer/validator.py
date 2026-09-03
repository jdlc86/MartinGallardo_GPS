from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from .domain import CompanionMatch, OptimizerConfig, Solution
from .shifts import allowed_shift_types, operational_day, shift_window
from .transitions import build_transition, terminal_transfer

@dataclass(frozen=True, slots=True)
class ValidationError:
    code:str; worker_id:str|None=None; task_id:str|None=None; detail:str|None=None

def validate_solution(solution:Solution,cfg:OptimizerConfig)->list[ValidationError]:
    errors=[]; task_owner={}; task_index={t.id:t for r in solution.routes.values() for t in r.tasks}
    shifts={}; allowed=set(allowed_shift_types(cfg))
    for s in solution.shift_assignments:
        key=(s.worker_id,s.operational_day)
        if key in shifts: errors.append(ValidationError("duplicate_shift_assignment",s.worker_id,detail=str(s.operational_day)))
        shifts[key]=s
        if s.shift_type not in allowed: errors.append(ValidationError("shift_type_not_allowed",s.worker_id,detail=s.shift_type))
        a,b=shift_window(s.operational_day,s.shift_type,cfg)
        if s.start_at!=a or s.end_at!=b: errors.append(ValidationError("noncanonical_shift_window",s.worker_id,detail=str(s.operational_day)))
    matches_by_rider={}; matches_by_driver={}
    for m in solution.companion_matches:
        key=(m.rider_worker_id,m.rider_task_id)
        if key in matches_by_rider: errors.append(ValidationError("duplicate_companion_match",m.rider_worker_id,m.rider_task_id))
        matches_by_rider[key]=m; matches_by_driver.setdefault((m.driver_worker_id,m.driver_task_id),[]).append(m)
    rescue_by_rider={}
    by_vehicle={}
    for m in solution.company_shuttle_missions:
        if m.vehicle_index<0 or m.vehicle_index>=cfg.company_shuttle_vehicle_count: errors.append(ValidationError("company_shuttle_invalid_vehicle",detail=m.mission_id))
        if len(m.rider_worker_ids)!=len(m.rider_task_ids) or len(m.rider_worker_ids)>cfg.company_shuttle_passenger_capacity: errors.append(ValidationError("company_shuttle_capacity_exceeded",detail=m.mission_id))
        if m.return_parking_at<m.depart_parking_at: errors.append(ValidationError("company_shuttle_invalid_window",detail=m.mission_id))
        by_vehicle.setdefault(m.vehicle_index,[]).append(m)
        for wid,tid in zip(m.rider_worker_ids,m.rider_task_ids):
            key=(wid,tid)
            if key in rescue_by_rider: errors.append(ValidationError("duplicate_company_shuttle_rider",wid,tid))
            rescue_by_rider[key]=m
    for vehicle,missions in by_vehicle.items():
        missions.sort(key=lambda m:m.depart_parking_at)
        for a,b in zip(missions,missions[1:]):
            if a.return_parking_at>b.depart_parking_at: errors.append(ValidationError("company_shuttle_vehicle_overlap",detail=f"vehicle={vehicle}:{a.mission_id}>{b.mission_id}"))
    for wid,route in solution.routes.items():
        ordered=sorted(route.tasks,key=lambda t:(t.start_at,t.id))
        if ordered!=route.tasks: errors.append(ValidationError("route_not_chronological",wid))
        previous=None; previous_day=None
        for task in ordered:
            day=operational_day(task.start_at,cfg); shift=shifts.get((wid,day))
            if shift is None: errors.append(ValidationError("missing_shift_assignment",wid,task.id,str(day)))
            elif task.start_at<shift.start_at or task.end_at>shift.end_at: errors.append(ValidationError("task_outside_shift",wid,task.id,shift.shift_type))
            if day!=previous_day: previous=None
            owner=task_owner.setdefault(task.id,wid)
            if owner!=wid: errors.append(ValidationError("task_assigned_twice",wid,task.id,f"also assigned to {owner}"))
            if task.fixed_worker_id and task.fixed_worker_id!=wid: errors.append(ValidationError("manual_assignment_changed",wid,task.id,task.fixed_worker_id))
            canonical=build_transition(previous,task,cfg); stored=route.transitions.get(task.id)
            if not canonical.feasible: errors.append(ValidationError(canonical.reason or "transition_infeasible",wid,task.id))
            elif canonical.requires_companion:
                rescue=rescue_by_rider.get((wid,task.id))
                if stored is not None and stored.kind=="company_shuttle":
                    if rescue is None: errors.append(ValidationError("missing_company_shuttle_mission",wid,task.id))
                    elif stored.ready_at is not None and rescue.depart_parking_at>task.start_at: errors.append(ValidationError("company_shuttle_arrives_late",wid,task.id))
                else:
                    match=matches_by_rider.get((wid,task.id))
                    if match is None: errors.append(ValidationError("missing_companion",wid,task.id,canonical.kind))
                    elif previous is not None: _validate_match(errors,solution,wid,previous,task,canonical,match,cfg,task_index)
            elif (wid,task.id) in matches_by_rider: errors.append(ValidationError("unexpected_companion",wid,task.id,canonical.kind))
            previous=task; previous_day=day
    for tid in sorted(set(task_owner).intersection(solution.unassigned_task_ids)): errors.append(ValidationError("task_both_assigned_and_unassigned",task_id=tid))
    for (dw,dt),matches in matches_by_driver.items():
        driver=task_index.get(dt); route=solution.routes.get(dw)
        if driver is None or route is None or driver not in route.tasks:
            for m in matches: errors.append(ValidationError("companion_driver_task_missing",m.rider_worker_id,m.rider_task_id))
        elif len(matches)>cfg.max_logistics_passengers: errors.append(ValidationError("companion_capacity_exceeded",dw,dt,f"{len(matches)}>{cfg.max_logistics_passengers}"))
    return errors

def _validate_match(errors,solution,rider_worker_id,previous,current,transition,match,cfg,task_index):
    if match.driver_worker_id==rider_worker_id: errors.append(ValidationError("self_companion",rider_worker_id,current.id)); return
    if match.direction!=transition.direction: errors.append(ValidationError("companion_direction_mismatch",rider_worker_id,current.id))
    driver=task_index.get(match.driver_task_id); route=solution.routes.get(match.driver_worker_id)
    if driver is None or route is None or driver not in route.tasks: errors.append(ValidationError("companion_driver_task_missing",rider_worker_id,current.id)); return
    if operational_day(driver.start_at,cfg)!=operational_day(current.start_at,cfg): errors.append(ValidationError("companion_crosses_operational_day",rider_worker_id,current.id)); return
    expected="out" if driver.task_type=="delivery" else "in"
    if expected!=transition.direction: errors.append(ValidationError("driver_task_direction_mismatch",rider_worker_id,current.id)); return
    if transition.direction=="out":
        if transition.ready_at is None or driver.vehicle_leg_depart_at<transition.ready_at: errors.append(ValidationError("companion_departs_before_ready",rider_worker_id,current.id)); return
        transfer=terminal_transfer(driver.terminal,current.start_node,driver.vehicle_leg_arrive_at,cfg)
        if transfer is None: errors.append(ValidationError("companion_terminal_transfer_unsupported",rider_worker_id,current.id)); return
        minutes,_=transfer; arrival=driver.vehicle_leg_arrive_at+timedelta(minutes=minutes)
        if arrival>current.start_at: errors.append(ValidationError("companion_arrives_late",rider_worker_id,current.id))
        if match.depart_at!=driver.vehicle_leg_depart_at or match.vehicle_leg_arrive_at!=driver.vehicle_leg_arrive_at: errors.append(ValidationError("companion_noncanonical_vehicle_times",rider_worker_id,current.id))
        if match.arrive_at!=arrival: errors.append(ValidationError("companion_noncanonical_arrival",rider_worker_id,current.id)); return
    if transition.ready_at is None: errors.append(ValidationError("missing_transition_ready",rider_worker_id,current.id)); return
    transfer=terminal_transfer(previous.end_node,driver.terminal,transition.ready_at,cfg)
    if transfer is None: errors.append(ValidationError("companion_terminal_transfer_unsupported",rider_worker_id,current.id)); return
    minutes,_=transfer; reach=transition.ready_at+timedelta(minutes=minutes)
    if reach>driver.vehicle_leg_depart_at: errors.append(ValidationError("companion_cannot_reach_driver_vehicle",rider_worker_id,current.id))
    if driver.vehicle_leg_arrive_at>current.start_at: errors.append(ValidationError("companion_arrives_late",rider_worker_id,current.id))
