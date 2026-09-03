from __future__ import annotations

from dataclasses import dataclass

from .domain import CompanionMatch, OptimizerConfig, Solution
from .transitions import build_transition


@dataclass(frozen=True, slots=True)
class ValidationError:
    code: str
    worker_id: str | None = None
    task_id: str | None = None
    detail: str | None = None


def validate_solution(solution: Solution, cfg: OptimizerConfig) -> list[ValidationError]:
    """Validate a proposed plan without trusting solver-produced movement fields.

    The validator reconstructs every transition from canonical task state. It is
    intentionally separate from the CP-SAT model and must remain usable against
    any future solver implementation.
    """

    errors: list[ValidationError] = []
    task_owner: dict[str, str] = {}

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
                else:
                    if match.direction != transition.direction:
                        errors.append(ValidationError("companion_direction_mismatch", worker_id, task.id))
                    if match.arrive_at > task.start_at:
                        errors.append(ValidationError("companion_arrives_late", worker_id, task.id))
                    if transition.ready_at and match.depart_at < transition.ready_at:
                        errors.append(ValidationError("companion_departs_before_ready", worker_id, task.id))
                    if match.driver_worker_id == worker_id:
                        errors.append(ValidationError("self_companion", worker_id, task.id))
            previous = task

    assigned_ids = set(task_owner)
    overlap = assigned_ids.intersection(solution.unassigned_task_ids)
    for task_id in sorted(overlap):
        errors.append(ValidationError("task_both_assigned_and_unassigned", task_id=task_id))

    task_index = {
        task.id: task
        for route in solution.routes.values()
        for task in route.tasks
    }
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
        expected_direction = "out" if driver_task.task_type == "delivery" else "in"
        for match in matches:
            if match.direction != expected_direction:
                errors.append(ValidationError("driver_task_direction_mismatch", match.rider_worker_id, match.rider_task_id))

    return errors
