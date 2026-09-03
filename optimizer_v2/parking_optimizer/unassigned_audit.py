from __future__ import annotations

from collections import Counter
from copy import deepcopy
from dataclasses import replace
from typing import Iterable

from .domain import OptimizerConfig, ShiftAssignment, Solution, Task, Transition
from .shifts import allowed_shift_types, operational_day, shift_duration_minutes, shift_rest_minutes
from .transitions import build_transition


def _overlaps(a: Task, b: Task) -> bool:
    return a.start_at < b.end_at and b.start_at < a.end_at


def _shift_tasks(solution: Solution, shift: ShiftAssignment) -> list[Task]:
    route = solution.routes[shift.worker_id]
    return [
        task for task in route.tasks
        if task.start_at >= shift.start_at and task.end_at <= shift.end_at
    ]


def _transition_state(previous: Task | None, current: Task | None, cfg: OptimizerConfig) -> tuple[bool, bool, str | None]:
    if current is None:
        return True, False, None
    if previous is None:
        return True, False, None
    tr = build_transition(previous, current, cfg)
    if not tr.feasible:
        return False, False, tr.reason or "physical_transition"
    if tr.requires_companion:
        return False, True, "requires_companion_or_shuttle"
    return True, False, None


def _rest_ok_before(previous: ShiftAssignment | None, start_at, new_type: str, cfg: OptimizerConfig) -> bool:
    if previous is None:
        return True
    gap = int((start_at - previous.end_at).total_seconds() // 60)
    return gap >= shift_rest_minutes(new_type, cfg)


def _rest_ok_after(end_at, following: ShiftAssignment | None, cfg: OptimizerConfig) -> bool:
    if following is None:
        return True
    gap = int((following.start_at - end_at).total_seconds() // 60)
    # Rest required before the following shift is determined by that shift type.
    return gap >= shift_rest_minutes(following.shift_type, cfg)


def _worker_audit(task: Task, worker_id: str, solution: Solution, cfg: OptimizerConfig) -> dict[str, object]:
    route = solution.routes[worker_id]
    if any(_overlaps(task, existing) for existing in route.tasks):
        overlaps = [existing.id for existing in route.tasks if _overlaps(task, existing)]
        return {"worker_id": worker_id, "available": False, "resolved": True, "reason": "time_overlap", "conflicts": overlaps}

    shifts = sorted(
        (shift for shift in solution.shift_assignments if shift.worker_id == worker_id),
        key=lambda shift: shift.start_at,
    )
    unresolved_logistics = False
    blockers: list[str] = []

    # 1) Can the task be inserted into / extend one existing shift?
    for index, shift in enumerate(shifts):
        tasks = sorted(_shift_tasks(solution, shift), key=lambda t: (t.start_at, t.end_at, t.id))
        before = [t for t in tasks if t.end_at <= task.start_at]
        after = [t for t in tasks if t.start_at >= task.end_at]
        previous_task = before[-1] if before else None
        next_task = after[0] if after else None

        # If there is an existing task between previous and next that overlaps the
        # candidate, the overlap check above would already have rejected it.
        new_start = min(shift.start_at, task.start_at)
        new_end = max(shift.end_at, task.end_at)
        duration = int((new_end - new_start).total_seconds() // 60)
        if duration > shift_duration_minutes(shift.shift_type, cfg):
            blockers.append("shift_duration")
            continue

        previous_shift = shifts[index - 1] if index > 0 else None
        next_shift = shifts[index + 1] if index + 1 < len(shifts) else None
        if not _rest_ok_before(previous_shift, new_start, shift.shift_type, cfg):
            blockers.append("rest_before")
            continue
        if not _rest_ok_after(new_end, next_shift, cfg):
            blockers.append("rest_after")
            continue

        left_ok, left_logistics, left_reason = _transition_state(previous_task, task, cfg)
        right_ok, right_logistics, right_reason = _transition_state(task, next_task, cfg)
        if left_logistics or right_logistics:
            unresolved_logistics = True
            blockers.append("requires_logistics_reoptimization")
            continue
        if not left_ok:
            blockers.append(left_reason or "physical_transition_before")
            continue
        if not right_ok:
            blockers.append(right_reason or "physical_transition_after")
            continue

        return {
            "worker_id": worker_id,
            "available": True,
            "resolved": True,
            "reason": "insertable_existing_shift",
            "shift_type": shift.shift_type,
            "shift_index": index,
            "original_shift_start_at": shift.start_at.isoformat(),
            "original_shift_end_at": shift.end_at.isoformat(),
            "shift_start_at": new_start.isoformat(),
            "shift_end_at": new_end.isoformat(),
        }

    # 2) Can it be a new standalone work block? At a new shift start the worker
    # may travel by their own means to PARKING or any terminal. A new block can
    # never be opened inside/overlapping an already active work block.
    overlapping_shifts = [
        shift for shift in shifts
        if task.start_at < shift.end_at and shift.start_at < task.end_at
    ]
    if overlapping_shifts:
        blockers.append("existing_shift_overlap")
    else:
        for shift_type in allowed_shift_types(cfg):
        duration = int((task.end_at - task.start_at).total_seconds() // 60)
        if duration > shift_duration_minutes(shift_type, cfg):
            blockers.append("task_exceeds_shift_duration")
            continue

        previous_shift = None
        next_shift = None
        for shift in shifts:
            if shift.end_at <= task.start_at:
                previous_shift = shift
            elif shift.start_at >= task.end_at:
                next_shift = shift
                break

        if not _rest_ok_before(previous_shift, task.start_at, shift_type, cfg):
            blockers.append(f"rest_before:{shift_type}")
            continue
        if not _rest_ok_after(task.end_at, next_shift, cfg):
            blockers.append(f"rest_after:{next_shift.shift_type}" if next_shift else "rest_after")
            continue

        return {
            "worker_id": worker_id,
            "available": True,
            "resolved": True,
            "reason": "insertable_new_shift",
            "shift_type": shift_type,
            "shift_start_at": task.start_at.isoformat(),
            "shift_end_at": task.end_at.isoformat(),
        }

    if unresolved_logistics:
        return {
            "worker_id": worker_id,
            "available": False,
            "resolved": False,
            "reason": "requires_logistics_reoptimization",
            "blockers": sorted(set(blockers)),
        }

    return {
        "worker_id": worker_id,
        "available": False,
        "resolved": True,
        "reason": "constraints_block",
        "blockers": sorted(set(blockers)) or ["no_valid_shift_or_transition"],
    }


def audit_unassigned(
    tasks: Iterable[Task],
    solution: Solution,
    cfg: OptimizerConfig,
) -> list[dict[str, object]]:
    """Explain every unassigned task against the final accepted plan.

    This audits *availability in the accepted plan*. It deliberately does not
    claim global mathematical impossibility unless a separate proof exists.
    """
    task_by_id = {task.id: task for task in tasks}
    audits: list[dict[str, object]] = []

    for task_id in solution.unassigned_task_ids:
        task = task_by_id.get(task_id)
        if task is None:
            audits.append({
                "task_id": task_id,
                "status": "not_proven",
                "reason": "task_missing_from_audit_input",
                "worker_checks": [],
            })
            continue

        worker_ids = [task.fixed_worker_id] if task.fixed_worker_id else sorted(solution.routes)
        checks = [
            _worker_audit(task, worker_id, solution, cfg)
            for worker_id in worker_ids
            if worker_id in solution.routes
        ]

        available = [check for check in checks if check["available"]]
        unresolved = [check for check in checks if not check["resolved"]]
        if available:
            status = "available_in_current_plan"
            reason = "at_least_one_worker_can_accept_task"
        elif unresolved:
            status = "not_proven"
            reason = "logistics_reoptimization_required"
        else:
            status = "proven_unavailable_in_current_plan"
            reasons = Counter(check["reason"] for check in checks)
            reason = reasons.most_common(1)[0][0] if reasons else "no_eligible_worker"

        audits.append({
            "task_id": task.id,
            "booking_id": task.booking_id,
            "scheduled_at": task.scheduled_at.isoformat(),
            "task_type": task.task_type,
            "terminal": task.terminal,
            "status": status,
            "reason": reason,
            "worker_checks": checks,
        })

    return audits


def audit_summary(audits: Iterable[dict[str, object]]) -> dict[str, int]:
    counts = Counter(str(row.get("status")) for row in audits)
    return {
        "total": sum(counts.values()),
        "proven_unavailable_in_current_plan": counts["proven_unavailable_in_current_plan"],
        "available_in_current_plan": counts["available_in_current_plan"],
        "not_proven": counts["not_proven"],
    }



def _insert_into_existing_shift(
    solution: Solution,
    task: Task,
    check: dict[str, object],
    cfg: OptimizerConfig,
) -> None:
    worker_id = str(check["worker_id"])
    route = solution.routes[worker_id]
    worker_shifts = sorted(
        (shift for shift in solution.shift_assignments if shift.worker_id == worker_id),
        key=lambda shift: shift.start_at,
    )
    shift_index = int(check["shift_index"])
    target = worker_shifts[shift_index]
    old_start, old_end = target.start_at, target.end_at
    new_start = min(old_start, task.start_at)
    new_end = max(old_end, task.end_at)

    shift_tasks_before = sorted(
        _shift_tasks(solution, target),
        key=lambda t: (t.start_at, t.end_at, t.id),
    )
    previous = next((t for t in reversed(shift_tasks_before) if t.end_at <= task.start_at), None)
    following = next((t for t in shift_tasks_before if t.start_at >= task.end_at), None)

    route.tasks.append(task)
    route.tasks.sort(key=lambda t: (t.start_at, t.end_at, t.id))

    if previous is None:
        previous_route_tasks = [t for t in route.tasks if t.end_at <= task.start_at and t.id != task.id]
        predecessor = previous_route_tasks[-1] if previous_route_tasks else None
        route.transitions[task.id] = Transition(
            predecessor.id if predecessor else None,
            task.id,
            "shift_start",
            True,
            predecessor.end_at if predecessor else None,
            task.start_at,
            0,
            reason=f"new_shift:{target.shift_type}",
        )
    else:
        route.transitions[task.id] = build_transition(previous, task, cfg)

    if following is not None:
        route.transitions[following.id] = build_transition(task, following, cfg)

    replacement = replace(target, start_at=new_start, end_at=new_end)
    rebuilt: list[ShiftAssignment] = []
    replaced = False
    for shift in solution.shift_assignments:
        if (
            not replaced
            and shift.worker_id == target.worker_id
            and shift.start_at == target.start_at
            and shift.end_at == target.end_at
            and shift.shift_type == target.shift_type
        ):
            rebuilt.append(replacement)
            replaced = True
        else:
            rebuilt.append(shift)
    solution.shift_assignments = sorted(rebuilt, key=lambda s: (s.worker_id, s.start_at))


def _insert_as_new_shift(
    solution: Solution,
    task: Task,
    check: dict[str, object],
    cfg: OptimizerConfig,
) -> None:
    worker_id = str(check["worker_id"])
    shift_type = str(check["shift_type"])
    route = solution.routes[worker_id]
    previous_tasks = [t for t in route.tasks if t.end_at <= task.start_at]
    predecessor = previous_tasks[-1] if previous_tasks else None

    route.tasks.append(task)
    route.tasks.sort(key=lambda t: (t.start_at, t.end_at, t.id))
    route.transitions[task.id] = Transition(
        predecessor.id if predecessor else None,
        task.id,
        "shift_start",
        True,
        predecessor.end_at if predecessor else None,
        task.start_at,
        0,
        reason=f"new_shift:{shift_type}",
    )
    solution.shift_assignments.append(
        ShiftAssignment(
            worker_id,
            operational_day(task.start_at, cfg),
            shift_type,
            task.start_at,
            task.end_at,
        )
    )
    solution.shift_assignments.sort(key=lambda s: (s.worker_id, s.start_at))


def repair_audited_insertions(
    tasks: Iterable[Task],
    solution: Solution,
    cfg: OptimizerConfig,
    *,
    max_passes: int = 500,
) -> tuple[Solution, list[dict[str, object]]]:
    """Apply only insertions the audit has already proven safe.

    Every accepted insertion is independently validated. If a mutation fails
    validation it is discarded. The audit is then recomputed because one
    insertion can change availability for the remaining tasks.
    """
    task_by_id = {task.id: task for task in tasks}
    current = deepcopy(solution)
    repairs: list[dict[str, object]] = []

    for _ in range(max_passes):
        audits = audit_unassigned(task_by_id.values(), current, cfg)
        candidate = next(
            (row for row in audits if row["status"] == "available_in_current_plan"),
            None,
        )
        if candidate is None:
            current.unassigned_audit = audits
            return current, repairs

        task = task_by_id[str(candidate["task_id"])]
        check = next(
            check for check in candidate["worker_checks"]
            if check["available"]
        )
        trial = deepcopy(current)

        if check["reason"] == "insertable_existing_shift":
            _insert_into_existing_shift(trial, task, check, cfg)
        elif check["reason"] == "insertable_new_shift":
            _insert_as_new_shift(trial, task, check, cfg)
        else:
            break

        trial.unassigned_task_ids = [
            task_id for task_id in trial.unassigned_task_ids if task_id != task.id
        ]
        trial.coverage_count += 1

        # Local mutation must not invalidate companion/shuttle resources or any
        # existing route. The independent validator is the final authority.
        from .validator import validate_solution
        errors = validate_solution(trial, cfg)
        if errors:
            # Mark this insertion as unresolved rather than repeatedly retrying.
            repairs.append({
                "task_id": task.id,
                "status": "repair_rejected",
                "worker_id": check["worker_id"],
                "reason": check["reason"],
                "validation_errors": [error.code for error in errors[:10]],
            })
            # Remove this worker from consideration by returning; a later CP-SAT
            # repair phase can handle more complex alternatives safely.
            current.unassigned_audit = audits
            return current, repairs

        current = trial
        repairs.append({
            "task_id": task.id,
            "status": "inserted",
            "worker_id": check["worker_id"],
            "reason": check["reason"],
        })

    current.unassigned_audit = audit_unassigned(task_by_id.values(), current, cfg)
    return current, repairs
