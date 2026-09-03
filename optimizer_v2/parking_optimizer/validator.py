from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from .domain import CompanionMatch, OptimizerConfig, Solution
from .transitions import build_transition, terminal_transfer


@dataclass(frozen=True, slots=True)
class ValidationError:
    code: str
    worker_id: str | None = None
    task_id: str | None = None
    detail: str | None = None


def validate_solution(solution: Solution, cfg: OptimizerConfig) -> list[ValidationError]:
    """Validate a plan without trusting solver-produced movement timestamps.

    All physical transitions and companion compatibility are reconstructed from
    canonical task data. This module is intentionally independent from CP-SAT.
    """

    errors: list[ValidationError] = []
    task_owner: dict[str, str] = {}
    task_index = {task.id: task for route in solution.routes.values() for task in route.tasks}

    matches_by_rider: dict[tuple[str, str], CompanionMatch] = {}
    matches_by_driver_task: dict[tuple[str, str], list[CompanionMatch]] = {}
    for match in solution.companion_matches:
        rider_key = (match.rider_worker_id, match.rider_task_id)
        if rider_key in matches_by_rider:
            errors.append(ValidationError("duplicate_companion_match", match.rider_worker_id, match.rider_task_id))
        matches_by_rider[rider_key] = match
        matches_by_driver_task.setdefault((match.driver_worker_id, match.driver_task_id), []).append(match)

    for worker_id, route in solution.routes.items():
        ordered = sorted(route.tasks, key=lambda task: (task.start_at, task.id))
        if ordered != route.tasks:
            errors.append(ValidationError("route_not_chronological", worker_id))

        previous = None
        for task in ordered:
            owner = task_owner.setdefault(task.id, worker_id)
            if owner != worker_id:
                errors.append(ValidationError("task_assigned_twice", worker_id, task.id, f"also assigned to {owner}"))

            if task.fixed_worker_id and task.fixed_worker_id != worker_id:
                errors.append(ValidationError("manual_assignment_changed", worker_id, task.id, task.fixed_worker_id))

            transition = build_transition(previous, task, cfg)
            if not transition.feasible:
                errors.append(ValidationError(transition.reason or "transition_infeasible", worker_id, task.id))
            elif transition.requires_companion:
                match = matches_by_rider.get((worker_id, task.id))
                if match is None:
                    errors.append(ValidationError("missing_companion", worker_id, task.id, transition.kind))
                elif previous is not None:
                    _validate_match(errors, solution, worker_id, previous, task, transition, match, cfg, task_index)
            elif (worker_id, task.id) in matches_by_rider:
                errors.append(ValidationError("unexpected_companion", worker_id, task.id, transition.kind))
            previous = task

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
