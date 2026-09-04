from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from .domain import CompanionMatch, OptimizerConfig, Solution
from .shifts import allowed_shift_types, shift_duration_minutes, shift_rest_minutes
from .transitions import build_transition, terminal_transfer


@dataclass(frozen=True, slots=True)
class ValidationError:
    code: str
    worker_id: str | None = None
    task_id: str | None = None
    detail: str | None = None


def _validate_company_shuttle_link(errors, worker_id, previous, current, stored, mission):
    if previous is None:
        errors.append(ValidationError("company_shuttle_without_predecessor", worker_id, current.id))
        return
    if mission is None:
        errors.append(ValidationError("missing_company_shuttle_mission", worker_id, current.id))
        return
    if stored.predecessor_task_id != previous.id:
        errors.append(ValidationError("company_shuttle_wrong_predecessor", worker_id, current.id))
    expected_stops = tuple(node for node in (previous.end_node, current.start_node) if node != "PARKING")
    if mission.stops != expected_stops:
        errors.append(ValidationError("company_shuttle_wrong_stops", worker_id, current.id, f"{mission.stops}!={expected_stops}"))
    if current.start_at < previous.end_at:
        errors.append(ValidationError("time_overlap", worker_id, current.id))
        return
    if previous.end_node == "PARKING" and mission.depart_parking_at < previous.end_at:
        errors.append(ValidationError("company_shuttle_departs_before_ready", worker_id, current.id))
    if current.start_node == "PARKING" and mission.return_parking_at > current.start_at:
        errors.append(ValidationError("company_shuttle_arrives_late", worker_id, current.id))
    if mission.depart_parking_at > current.start_at:
        errors.append(ValidationError("company_shuttle_starts_after_successor", worker_id, current.id))


def validate_solution(solution: Solution, cfg: OptimizerConfig) -> list[ValidationError]:
    """Independent physical and continuous-work-policy validation."""
    errors: list[ValidationError] = []
    task_owner: dict[str, str] = {}
    task_index = {task.id: task for route in solution.routes.values() for task in route.tasks}
    allowed = set(allowed_shift_types(cfg))

    # Flexible shift blocks: validate type, duration, overlap and policy-specific rest.
    shifts_by_worker = {}
    for shift in solution.shift_assignments:
        shifts_by_worker.setdefault(shift.worker_id, []).append(shift)
        if shift.shift_type not in allowed:
            errors.append(ValidationError("shift_type_not_allowed", shift.worker_id, detail=shift.shift_type))
            continue
        if shift.end_at < shift.start_at:
            errors.append(ValidationError("shift_negative_duration", shift.worker_id, detail=shift.shift_type))
            continue
        duration = int((shift.end_at - shift.start_at).total_seconds() // 60)
        maximum = shift_duration_minutes(shift.shift_type, cfg)
        if duration > maximum:
            errors.append(ValidationError("shift_duration_exceeded", shift.worker_id, detail=f"{duration}>{maximum}:{shift.shift_type}"))

    for worker_id, shifts in shifts_by_worker.items():
        shifts.sort(key=lambda s: (s.start_at, s.end_at))
        for previous, current in zip(shifts, shifts[1:]):
            if current.start_at < previous.end_at:
                errors.append(ValidationError("shift_overlap", worker_id, detail=f"{previous.end_at.isoformat()}>{current.start_at.isoformat()}"))
                continue
            rest = int((current.start_at - previous.end_at).total_seconds() // 60)
            required = shift_rest_minutes(current.shift_type, cfg)
            if rest < required:
                errors.append(ValidationError("insufficient_rest_before_shift", worker_id, detail=f"{rest}<{required}:{current.shift_type}"))

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
        if any(stop == "PARKING" for stop in mission.stops):
            errors.append(ValidationError("company_shuttle_parking_as_airport_stop", detail=mission.mission_id))
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
                errors.append(ValidationError("company_shuttle_vehicle_overlap", detail=f"vehicle={vehicle_index}:{previous.mission_id}>{current.mission_id}"))

    # Map each assigned task to exactly one flexible shift block.
    shift_for_task = {}
    for worker_id, route in solution.routes.items():
        worker_shifts = shifts_by_worker.get(worker_id, [])
        ordered = sorted(route.tasks, key=lambda task: (task.start_at, task.id))
        if ordered != route.tasks:
            errors.append(ValidationError("route_not_chronological", worker_id))
        for task in ordered:
            containing = [s for s in worker_shifts if task.start_at >= s.start_at and task.end_at <= s.end_at]
            if len(containing) != 1:
                errors.append(ValidationError("task_shift_membership_invalid", worker_id, task.id, f"count={len(containing)}"))
            else:
                shift_for_task[worker_id, task.id] = containing[0]

    for worker_id, route in solution.routes.items():
        ordered = route.tasks
        previous = None
        previous_shift = None
        for task in ordered:
            owner = task_owner.setdefault(task.id, worker_id)
            if owner != worker_id:
                errors.append(ValidationError("task_assigned_twice", worker_id, task.id, f"also assigned to {owner}"))
            if task.fixed_worker_id and task.fixed_worker_id != worker_id:
                errors.append(ValidationError("manual_assignment_changed", worker_id, task.id, task.fixed_worker_id))

            current_shift = shift_for_task.get((worker_id, task.id))
            stored = route.transitions.get(task.id)
            starts_new_shift = previous is None or (current_shift is not None and current_shift is not previous_shift)

            if starts_new_shift:
                # After the required rest this is a new work block. The worker may
                # reach the first task's terminal/PARKING by personal means.
                if stored is None or stored.kind != "shift_start":
                    errors.append(ValidationError("missing_shift_start_transition", worker_id, task.id))
                if previous is not None and current_shift is not None:
                    rest = int((current_shift.start_at - previous_shift.end_at).total_seconds() // 60) if previous_shift is not None else 0
                    required = shift_rest_minutes(current_shift.shift_type, cfg)
                    if rest < required:
                        errors.append(ValidationError("insufficient_rest_before_shift", worker_id, task.id, f"{rest}<{required}"))
                if (worker_id, task.id) in matches_by_rider:
                    errors.append(ValidationError("unexpected_companion_on_shift_start", worker_id, task.id))
                if (worker_id, task.id) in rescue_by_rider:
                    errors.append(ValidationError("unexpected_company_shuttle_on_shift_start", worker_id, task.id))
            else:
                canonical = build_transition(previous, task, cfg)
                if stored is not None and stored.kind == "company_shuttle":
                    mission = rescue_by_rider.get((worker_id, task.id))
                    _validate_company_shuttle_link(errors, worker_id, previous, task, stored, mission)
                elif not canonical.feasible:
                    errors.append(ValidationError(canonical.reason or "transition_infeasible", worker_id, task.id))
                elif canonical.requires_companion:
                    match = matches_by_rider.get((worker_id, task.id))
                    if match is None:
                        errors.append(ValidationError("missing_companion", worker_id, task.id, canonical.kind))
                    else:
                        _validate_match(errors, solution, worker_id, previous, task, canonical, match, cfg, task_index)
                elif (worker_id, task.id) in matches_by_rider:
                    errors.append(ValidationError("unexpected_companion", worker_id, task.id, canonical.kind))

            previous = task
            previous_shift = current_shift

    assigned_ids = set(task_owner)
    for task_id in sorted(assigned_ids.intersection(solution.unassigned_task_ids)):
        errors.append(ValidationError("task_both_assigned_and_unassigned", task_id=task_id))

    for (worker_id, task_id), mission in rescue_by_rider.items():
        route = solution.routes.get(worker_id)
        if route is None or task_id not in task_index or task_index[task_id] not in route.tasks:
            errors.append(ValidationError("company_shuttle_rider_task_missing", worker_id, task_id, mission.mission_id))
            continue
        stored = route.transitions.get(task_id)
        if stored is None or stored.kind != "company_shuttle":
            errors.append(ValidationError("company_shuttle_orphan_rider", worker_id, task_id, mission.mission_id))

    for (driver_worker_id, driver_task_id), matches in matches_by_driver_task.items():
        driver_task = task_index.get(driver_task_id)
        driver_route = solution.routes.get(driver_worker_id)
        if driver_task is None or driver_route is None or driver_task not in driver_route.tasks:
            for match in matches:
                errors.append(ValidationError("companion_driver_task_missing", match.rider_worker_id, match.rider_task_id))
            continue
        if len(matches) > cfg.max_logistics_passengers:
            errors.append(ValidationError("companion_capacity_exceeded", driver_worker_id, driver_task_id, f"{len(matches)}>{cfg.max_logistics_passengers}"))

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
