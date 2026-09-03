from __future__ import annotations

from collections import Counter
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
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
    if current is None or previous is None:
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
    return gap >= shift_rest_minutes(following.shift_type, cfg)


def _worker_audit(task: Task, worker_id: str, solution: Solution, cfg: OptimizerConfig) -> dict[str, object]:
    route = solution.routes[worker_id]
    overlaps = [existing.id for existing in route.tasks if _overlaps(task, existing)]
    if overlaps:
        return {
            "worker_id": worker_id,
            "available": False,
            "resolved": True,
            "reason": "time_overlap",
            "conflicts": overlaps,
        }

    shifts = sorted(
        (shift for shift in solution.shift_assignments if shift.worker_id == worker_id),
        key=lambda shift: shift.start_at,
    )
    unresolved_logistics = False
    blockers: list[str] = []

    for index, shift in enumerate(shifts):
        tasks = sorted(_shift_tasks(solution, shift), key=lambda t: (t.start_at, t.end_at, t.id))
        before = [t for t in tasks if t.end_at <= task.start_at]
        after = [t for t in tasks if t.start_at >= task.end_at]
        previous_task = before[-1] if before else None
        next_task = after[0] if after else None

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
            "shift_start_at": new_start.isoformat(),
            "shift_end_at": new_end.isoformat(),
        }

    overlapping_shifts = [
        shift for shift in shifts
        if task.start_at < shift.end_at and shift.start_at < task.end_at
    ]
    if overlapping_shifts:
        blockers.append("existing_shift_overlap")
    else:
        previous_shift = None
        next_shift = None
        for shift in shifts:
            if shift.end_at <= task.start_at:
                previous_shift = shift
            elif shift.start_at >= task.end_at:
                next_shift = shift
                break

        duration = int((task.end_at - task.start_at).total_seconds() // 60)
        for shift_type in allowed_shift_types(cfg):
            if duration > shift_duration_minutes(shift_type, cfg):
                blockers.append("task_exceeds_shift_duration")
                continue
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


def _insert_into_existing_shift(solution: Solution, task: Task, check: dict[str, object], cfg: OptimizerConfig) -> None:
    worker_id = str(check["worker_id"])
    route = solution.routes[worker_id]
    worker_shifts = sorted(
        (shift for shift in solution.shift_assignments if shift.worker_id == worker_id),
        key=lambda shift: shift.start_at,
    )
    target = worker_shifts[int(check["shift_index"])]
    shift_tasks = sorted(_shift_tasks(solution, target), key=lambda t: (t.start_at, t.end_at, t.id))
    previous = next((t for t in reversed(shift_tasks) if t.end_at <= task.start_at), None)
    following = next((t for t in shift_tasks if t.start_at >= task.end_at), None)

    route.tasks.append(task)
    route.tasks.sort(key=lambda t: (t.start_at, t.id))

    if previous is None:
        previous_route = [t for t in route.tasks if t.id != task.id and t.end_at <= task.start_at]
        predecessor = previous_route[-1] if previous_route else None
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

    replacement = replace(
        target,
        start_at=min(target.start_at, task.start_at),
        end_at=max(target.end_at, task.end_at),
    )
    rebuilt: list[ShiftAssignment] = []
    done = False
    for shift in solution.shift_assignments:
        if (
            not done
            and shift.worker_id == target.worker_id
            and shift.start_at == target.start_at
            and shift.end_at == target.end_at
            and shift.shift_type == target.shift_type
        ):
            rebuilt.append(replacement)
            done = True
        else:
            rebuilt.append(shift)
    solution.shift_assignments = sorted(rebuilt, key=lambda s: (s.worker_id, s.start_at))


def _insert_as_new_shift(solution: Solution, task: Task, check: dict[str, object], cfg: OptimizerConfig) -> None:
    worker_id = str(check["worker_id"])
    shift_type = str(check["shift_type"])
    route = solution.routes[worker_id]
    previous_tasks = [t for t in route.tasks if t.end_at <= task.start_at]
    predecessor = previous_tasks[-1] if previous_tasks else None

    route.tasks.append(task)
    route.tasks.sort(key=lambda t: (t.start_at, t.id))
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


def _trial_insert(solution: Solution, task: Task, check: dict[str, object], cfg: OptimizerConfig) -> tuple[Solution | None, list[str]]:
    trial = deepcopy(solution)
    if check["reason"] == "insertable_existing_shift":
        _insert_into_existing_shift(trial, task, check, cfg)
    elif check["reason"] == "insertable_new_shift":
        _insert_as_new_shift(trial, task, check, cfg)
    else:
        return None, ["unsupported_insert_reason"]

    trial.unassigned_task_ids = [tid for tid in trial.unassigned_task_ids if tid != task.id]
    trial.coverage_count += 1

    from .validator import validate_solution
    errors = validate_solution(trial, cfg)
    if errors:
        return None, [error.code for error in errors[:20]]
    return trial, []


def audit_unassigned(tasks: Iterable[Task], solution: Solution, cfg: OptimizerConfig) -> list[dict[str, object]]:
    """Explain every unassigned task against the accepted plan.

    available_in_current_plan is emitted only after a simulated insertion
    passes the independent physical validator.
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
        checks: list[dict[str, object]] = []
        for worker_id in worker_ids:
            if worker_id not in solution.routes:
                continue
            check = _worker_audit(task, worker_id, solution, cfg)
            if check["available"]:
                trial, errors = _trial_insert(solution, task, check, cfg)
                if trial is None:
                    check = {
                        **check,
                        "available": False,
                        "resolved": False,
                        "reason": "candidate_insertion_failed_validation",
                        "validation_errors": errors,
                    }
            checks.append(check)

        available = [check for check in checks if check["available"]]
        unresolved = [check for check in checks if not check["resolved"]]
        if available:
            status = "available_in_current_plan"
            reason = "validated_direct_insertion_exists"
        elif unresolved:
            status = "not_proven"
            reason = "reoptimization_or_logistics_required"
        else:
            status = "proven_unavailable_in_current_plan"
            reason = "all_workers_blocked_by_current_plan"

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


def repair_audited_insertions(
    tasks: Iterable[Task],
    solution: Solution,
    cfg: OptimizerConfig,
    *,
    max_passes: int = 500,
) -> tuple[Solution, list[dict[str, object]]]:
    """Insert every audit-proven task one at a time and re-audit after each."""
    task_by_id = {task.id: task for task in tasks}
    current = deepcopy(solution)
    repairs: list[dict[str, object]] = []
    rejected: set[str] = set()

    for _ in range(max_passes):
        audits = audit_unassigned(task_by_id.values(), current, cfg)
        candidate = next(
            (
                row for row in audits
                if row["status"] == "available_in_current_plan"
                and row["task_id"] not in rejected
            ),
            None,
        )
        if candidate is None:
            current.unassigned_audit = audits
            return current, repairs

        task = task_by_id[str(candidate["task_id"])]
        check = next(check for check in candidate["worker_checks"] if check["available"])
        trial, errors = _trial_insert(current, task, check, cfg)
        if trial is None:
            rejected.add(task.id)
            repairs.append({
                "task_id": task.id,
                "status": "repair_rejected",
                "worker_id": check["worker_id"],
                "validation_errors": errors,
            })
            continue

        current = trial
        repairs.append({
            "task_id": task.id,
            "status": "inserted",
            "worker_id": check["worker_id"],
            "reason": check["reason"],
        })

    current.unassigned_audit = audit_unassigned(task_by_id.values(), current, cfg)
    return current, repairs


def audit_summary(audits: Iterable[dict[str, object]]) -> dict[str, int]:
    counts = Counter(str(row.get("status")) for row in audits)
    return {
        "total": sum(counts.values()),
        "proven_unavailable_in_current_plan": counts["proven_unavailable_in_current_plan"],
        "available_in_current_plan": counts["available_in_current_plan"],
        "not_proven": counts["not_proven"],
    }



def reoptimize_not_proven(
    tasks: Iterable[Task],
    workers,
    solution: Solution,
    cfg: OptimizerConfig,
    *,
    random_seed: int = 20260903,
    search_workers: int = 8,
) -> tuple[Solution, list[dict[str, object]]]:
    """Try local CP-SAT repairs for unresolved audit rows without score regression.

    Each candidate task is forced into a local rolling window. The local model
    must cover at least the number of currently assigned local tasks plus one.
    A proposal is accepted only after rebuilding a global continuous plan and
    passing the independent validator with coverage >= the current score.
    """
    from .continuous_seed import build_continuous_seed
    from .horizon_solver_path import solve_horizon
    from .validator import validate_solution

    tasks = sorted(tasks, key=lambda t: (t.start_at, t.end_at, t.id))
    workers = list(workers)
    task_by_id = {task.id: task for task in tasks}
    current = deepcopy(solution)
    events: list[dict[str, object]] = []
    max_candidates = max(0, int(cfg.audit_max_reoptimization_candidates))
    attempts = 0

    while attempts < max_candidates:
        audits = audit_unassigned(tasks, current, cfg)
        unresolved = [row for row in audits if row["status"] == "not_proven"]
        if not unresolved:
            current.unassigned_audit = audits
            return current, events

        improved = False
        for row in unresolved:
            if attempts >= max_candidates:
                break
            attempts += 1
            target = task_by_id[str(row["task_id"])]
            half = timedelta(minutes=max(60, cfg.audit_local_window_minutes // 2))
            start = target.start_at - half
            end = target.end_at + half
            local_tasks = [task for task in tasks if task.start_at < end and task.end_at > start]
            local_ids = {task.id for task in local_tasks}
            current_assigned = {
                task.id
                for route in current.routes.values()
                for task in route.tasks
                if task.id in local_ids
            }
            required_floor = min(len(local_tasks), len(current_assigned) + 1)

            current_owner = {
                task.id: worker_id
                for worker_id, route in current.routes.items()
                for task in route.tasks
            }
            local_seed = build_continuous_seed(
                local_tasks,
                workers,
                cfg,
                preferred_worker_by_task=current_owner,
            )

            local = solve_horizon(
                local_tasks,
                workers,
                cfg,
                time_limit_seconds=max(0.5, float(cfg.audit_local_time_limit_seconds)),
                random_seed=random_seed + attempts,
                search_workers=search_workers,
                seed_solution=local_seed,
                required_task_ids={target.id},
                minimum_coverage=required_floor,
            )

            local_valid = (
                local.solver_status in {"OPTIMAL", "FEASIBLE"}
                and not validate_solution(local, cfg)
                and target.id not in local.unassigned_task_ids
                and local.coverage_count >= required_floor
            )
            if not local_valid:
                events.append({
                    "task_id": target.id,
                    "status": "local_reoptimization_no_solution",
                    "local_task_count": len(local_tasks),
                    "required_local_coverage": required_floor,
                    "solver_status": local.solver_status,
                    "local_coverage": local.coverage_count,
                })
                continue

            preferences = dict(current_owner)
            for worker_id, route in local.routes.items():
                for task in route.tasks:
                    preferences[task.id] = worker_id

            candidate = build_continuous_seed(
                tasks,
                workers,
                cfg,
                preferred_worker_by_task=preferences,
            )
            errors = validate_solution(candidate, cfg)
            candidate_assigned = {
                task.id for route in candidate.routes.values() for task in route.tasks
            }
            target_kept = target.id in candidate_assigned
            non_regression = candidate.coverage_count >= current.coverage_count

            if errors or not target_kept or not non_regression:
                events.append({
                    "task_id": target.id,
                    "status": "global_rebuild_rejected",
                    "previous_coverage": current.coverage_count,
                    "candidate_coverage": candidate.coverage_count,
                    "target_kept": target_kept,
                    "validation_error_count": len(errors),
                })
                continue

            delta = candidate.coverage_count - current.coverage_count
            candidate.day_diagnostics = list(current.day_diagnostics)
            candidate.day_diagnostics.append({
                "mode": "audit_local_reoptimization",
                "task_id": target.id,
                "previous_coverage": current.coverage_count,
                "new_coverage": candidate.coverage_count,
                "delta": delta,
                "local_task_count": len(local_tasks),
            })
            current = candidate
            events.append({
                "task_id": target.id,
                "status": "improved" if delta > 0 else "safe_swap",
                "previous_coverage": current.coverage_count - delta,
                "new_coverage": current.coverage_count,
                "delta": delta,
            })
            improved = True
            break

        if not improved:
            current.unassigned_audit = audit_unassigned(tasks, current, cfg)
            return current, events

    current.unassigned_audit = audit_unassigned(tasks, current, cfg)
    return current, events
