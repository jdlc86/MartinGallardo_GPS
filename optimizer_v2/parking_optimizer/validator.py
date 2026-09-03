from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from .domain import CompanionMatch, OptimizerConfig, Solution
from .shifts import allowed_shift_types, operational_day, shift_window
from .transitions import build_transition, terminal_transfer


@dataclass(frozen=True, slots=True)
class ValidationError:
    code: str
    worker_id: str | None = None
    task_id: str | None = None
    detail: str | None = None


def validate_solution(solution: Solution, cfg: OptimizerConfig) -> list[ValidationError]:
    """Independent physical, work-policy and company-shuttle validation."""
    errors: list[ValidationError] = []
    task_owner: dict[str, str] = {}
    task_index = {task.id: task for route in solution.routes.values() for task in route.tasks}

    shifts: dict[tuple[str, object], object] = {}
    allowed = set(allowed_shift_types(cfg))
    for shift in solution.shift_assignments:
        key = (shift.worker_id, shift.operational_day)
        if key in shifts:
            errors.append(ValidationError("duplicate_shift_assignment", shift.worker_id, detail=str(shift.operational_day)))
        shifts[key] = shift
        if shift.shift_type not in allowed:
            errors.append(ValidationError("shift_type_not_allowed", shift.worker_id, detail=shift.shift_type))
        canonical_start, canonical_end = shift_window(shift.operational_day, shift.shift_type, cfg)
        if shift.start_at != canonical_start or shift.end_at != canonical_end:
            errors.append(ValidationError("noncanonical_shift_window", shift.worker_id, detail=str(shift.operational_day)))

    matches_by_rider: dict[tuple[str, str], CompanionMatch] = {}
    matches_by_driver_task: dict[tuple[str, str], list[CompanionMatch]] = {}
    for match in solution.companion_matches:
        rider_key = (match.rider_worker_id, match.rider_task_id)
        if rider_key in matches_by_rider:
            errors.append(ValidationError("duplicate_companion_match", match.rider_worker_id, match.rider_task_id))
        matches_by_rider[rider_key] = match
        matches_by_driver_task.setdefault((match.driver_worker_id, match.driver_task_id), []).append(match)

    rescue_by_rider = {}
    missions_by_vehicle = {}
    for mission in solution.company_shuttle_missions:
        if mission.vehicle_index < 0 or mission.vehicle_index >= cfg.company_shuttle_vehicle_count:
            errors.append(ValidationError("company_shuttle_invalid_vehicle", detail=mission.mission_id))
        if len(mission.rider_worker_ids) != len(mission.rider_task_ids):
            errors.append(ValidationError("company_shuttle_rider_mapping_invalid", detail=mission.mission_id))
        if len(mission.rider_worker_ids) > cfg.company_shuttle_passenger_capacity:
            errors.append(ValidationError("company_shuttle_capacity_exceeded", detail=mission.mission_id))
        if mission.return_parking_at < mission.depart_parking_at:
            errors.append(ValidationError("company_shuttle_invalid_window", detail=mission.mission_id))
        missions_by_vehicle.setdefault(mission.vehicle_index, []).append(mission)
        for worker_id, task_id in zip(mission.rider_worker_ids, mission.rider_task_ids):
            key = (worker_id, task_id)
            if key in rescue_by_rider:
                errors.append(ValidationError("duplicate_company_shuttle_rider", worker_id, task_id))
            rescue_by_rider[key] = mission

    for vehicle_index, missions in missions_by_vehicle.items():
        missions.sort(key=lambda mission: mission.depart_parking_at)
        for previous, current in zip(missions, missions[1:]):
            if previous.return_parking_at > current.depart_parking_at:
                errors.append(
                    ValidationError(
                        "company_shuttle_vehicle_overlap",
                        detail=f"vehicle={vehicle_index}:{previous.mission_id}>{current.mission_id}",
                    )
                )

    for worker_id, route in solution.routes.items():
        ordered = sorted(route.tasks, key=lambda task: (task.start_at, task.id))
        if ordered != route.tasks:
            errors.append(ValidationError("route_not_chronological", worker_id))

        previous = None
        previous_day = None
        for task in ordered:
            day = operational_day(task.start_at, cfg)
            shift = shifts.get((worker_id, day))
            if shift is None:
                errors.append(ValidationError("missing_shift_assignment", worker_id, task.id, str(day)))
            elif task.start_at < shift.start_at or task.end_at > shift.end_at:
                errors.append(ValidationError("task_outside_shift", worker_id, task.id, shift.shift_type))

            if day != previous_day:
                previous = None

            owner = task_owner.setdefault(task.id, worker_id)
            if owner != worker_id:
                errors.append(ValidationError("task_assigned_twice", worker_id, task.id, f"also assigned to {owner}"))
            if task.fixed_worker_id and task.fixed_worker_id != worker_id:
                errors.append(ValidationError("manual_assignment_changed", worker_id, task.id, task.fixed_worker_id))

            canonical = build_transition(previous, task, cfg)
            stored = route.transitions.get(task.id)
            if not canonical.feasible:
                errors.append(ValidationError(canonical.reason or "transition_infeasible", worker_id, task.id))
            elif canonical.requires_companion:
                if stored is not None and stored.kind == "company_shuttle":
                    mission = rescue_by_rider.get((worker_id, task.id))
                    if mission is None:
                        errors.append(ValidationError("missing_company_shuttle_mission", worker_id, task.id))
                    elif mission.depart_parking_at > task.start_at:
                        errors.append(ValidationError("company_shuttle_arrives_late", worker_id, task.id))
                else:
                    match = matches_by_rider.get((worker_id, task.id))
                    if match is None:
                        errors.append(ValidationError("missing_companion", worker_id, task.id, canonical.kind))
                    elif previous is not None:
                        _validate_match(errors, solution, worker_id, previous, task, canonical, match, cfg, task_index)
            elif stored is not None and stored.kind == "company_shuttle":
                errors.append(ValidationError("unexpected_company_shuttle", worker_id, task.id, canonical.kind))
            elif (worker_id, task.id) in matches_by_rider:
                errors.append(ValidationError("unexpected_companion", worker_id, task.id, canonical.kind))

            previous = task
            previous_day = day

    assigned_ids = set(task_owner)
    for task_id in sorted(assigned_ids.intersection(solution.unassigned_task_ids)):
        errors.append(ValidationError("task_both_assigned_and_unassigned", task_id=task_id))

    for (driver_worker_id, driver_task_id), matches in matches_by_driver_task.items():
        driver_task = task_index.get(driver_task_id)
        driver_route = solution.routes.get(driver_worker_id)
        if driver_task is None or driver_route is None or driver_task not in driver_route.tasks:
            for match in matches:
                errors.append(ValidationError("companion_driver_task_missing", match.rider_worker_id, match.rider_task_id))
            continue
        if len(matches) > cfg.max_logistics_passengers:
            errors.append(
                ValidationError(
                    "companion_capacity_exceeded",
                    driver_worker_id,
                    driver_task_id,
                    f"{len(matches)}>{cfg.max_logistics_passengers}",
                )
            )

    return errors


def _validate_match(errors, solution, rider_worker_id, previous, current, transition, match, cfg, task_index):
    if match.driver_worker_id == rider_worker_id:
        errors.append(ValidationError("self_companion", rider_worker_id, current.id))
        return
    if match.direction != transition.direction:
        errors.append(ValidationError("companion_direction_mismatch", rider_worker_id, current.id))

    driver_task = task_index.get(match.driver_task_id)
    driver_route = solution.routes.get(match.driver_worker_id)
    if driver_task is None or driver_route is None or driver_task not in driver_route.tasks:
        errors.append(ValidationError("companion_driver_task_missing", rider_worker_id, current.id))
        return
    if operational_day(driver_task.start_at, cfg) != operational_day(current.start_at, cfg):
        errors.append(ValidationError("companion_crosses_operational_day", rider_worker_id, current.id))
        return

    expected_direction = "out" if driver_task.task_type == "delivery" else "in"
    if expected_direction != transition.direction:
        errors.append(ValidationError("driver_task_direction_mismatch", rider_worker_id, current.id))
        return

    if transition.direction == "out":
        if transition.ready_at is None or driver_task.vehicle_leg_depart_at < transition.ready_at:
            errors.append(ValidationError("companion_departs_before_ready", rider_worker_id, current.id))
            return
        transfer = terminal_transfer(driver_task.terminal, current.start_node, driver_task.vehicle_leg_arrive_at, cfg)
        if transfer is None:
            errors.append(ValidationError("companion_terminal_transfer_unsupported", rider_worker_id, current.id))
            return
        minutes, _ = transfer
        canonical_arrival = driver_task.vehicle_leg_arrive_at + timedelta(minutes=minutes)
        if canonical_arrival > current.start_at:
            errors.append(ValidationError("companion_arrives_late", rider_worker_id, current.id))
        if match.depart_at != driver_task.vehicle_leg_depart_at or match.vehicle_leg_arrive_at != driver_task.vehicle_leg_arrive_at:
            errors.append(ValidationError("companion_noncanonical_vehicle_times", rider_worker_id, current.id))
        if match.arrive_at != canonical_arrival:
            errors.append(ValidationError("companion_noncanonical_arrival", rider_worker_id, current.id))
        return

    if transition.ready_at is None:
        errors.append(ValidationError("missing_transition_ready", rider_worker_id, current.id))
        return
    transfer = terminal_transfer(previous.end_node, driver_task.terminal, transition.ready_at, cfg)
    if transfer is None:
        errors.append(ValidationError("companion_terminal_transfer_unsupported", rider_worker_id, current.id))
        return
    minutes, _ = transfer
    reach_vehicle = transition.ready_at + timedelta(minutes=minutes)
    if reach_vehicle > driver_task.vehicle_leg_depart_at:
        errors.append(ValidationError("companion_cannot_reach_driver_vehicle", rider_worker_id, current.id))
    if driver_task.vehicle_leg_arrive_at > current.start_at:
        errors.append(ValidationError("companion_arrives_late", rider_worker_id, current.id))
    if match.depart_at != driver_task.vehicle_leg_depart_at or match.vehicle_leg_arrive_at != driver_task.vehicle_leg_arrive_at:
        errors.append(ValidationError("companion_noncanonical_vehicle_times", rider_worker_id, current.id))
    if match.arrive_at != driver_task.vehicle_leg_arrive_at:
        errors.append(ValidationError("companion_noncanonical_arrival", rider_worker_id, current.id))
