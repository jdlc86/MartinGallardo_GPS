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

