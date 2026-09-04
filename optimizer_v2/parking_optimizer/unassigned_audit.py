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

        worker_ids = [task.fixed_worker_id] if task.fixed_worker_id else sorted(
            worker_id
            for worker_id, route in solution.routes.items()
            if route.worker.auto_assignable
        )
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



def _local_reoptimization_ids(
    tasks: list[Task],
    solution: Solution,
    target: Task,
    cfg: OptimizerConfig,
) -> set[str]:
    """Return a conservative local closure around the audited task.

    The initial time window is expanded to whole current shift blocks and to
    every task participating in a companion/company-shuttle dependency touched
    by that window. This prevents the local solve from cutting a live logistics
    edge or only half of an existing work block.
    """
    half = timedelta(minutes=max(60, int(cfg.audit_local_window_minutes) // 2))
    start = target.start_at - half
    end = target.end_at + half
    ids = {
        task.id
        for task in tasks
        if task.start_at < end and task.end_at > start
    }
    ids.add(target.id)

    changed = True
    while changed:
        changed = False

        for shift in solution.shift_assignments:
            shift_ids = {task.id for task in _shift_tasks(solution, shift)}
            if ids.intersection(shift_ids):
                before = len(ids)
                ids.update(shift_ids)
                changed = changed or len(ids) != before

        for match in solution.companion_matches:
            pair = {match.rider_task_id, match.driver_task_id}
            if ids.intersection(pair):
                before = len(ids)
                ids.update(pair)
                changed = changed or len(ids) != before

        for mission in solution.company_shuttle_missions:
            mission_ids = set(mission.rider_task_ids)
            if ids.intersection(mission_ids):
                before = len(ids)
                ids.update(mission_ids)
                changed = changed or len(ids) != before

    return ids


def _merge_local_solution(
    all_tasks: list[Task],
    current: Solution,
    local: Solution,
    local_ids: set[str],
) -> Solution:
    """Splice an exact local CP-SAT result into the accepted global plan.

    Assignments, shifts and logistics outside local_ids are frozen. Whole
    touched shift/logistics components have already been included in the local
    closure, so removing and replacing them cannot silently mutate the exterior.
    The caller must still run validate_solution() on the resulting global plan.
    """
    candidate = deepcopy(current)

    for route in candidate.routes.values():
        route.tasks = [task for task in route.tasks if task.id not in local_ids]
        route.transitions = {
            task_id: transition
            for task_id, transition in route.transitions.items()
            if task_id not in local_ids
        }

    kept_shifts = []
    for shift in current.shift_assignments:
        shift_ids = {task.id for task in _shift_tasks(current, shift)}
        if shift_ids.intersection(local_ids):
            continue
        kept_shifts.append(shift)
    candidate.shift_assignments = kept_shifts

    candidate.companion_matches = [
        match
        for match in current.companion_matches
        if match.rider_task_id not in local_ids and match.driver_task_id not in local_ids
    ]
    candidate.company_shuttle_missions = [
        mission
        for mission in current.company_shuttle_missions
        if not set(mission.rider_task_ids).intersection(local_ids)
    ]

    for worker_id, local_route in local.routes.items():
        route = candidate.routes[worker_id]
        route.tasks.extend(local_route.tasks)
        route.tasks.sort(key=lambda task: (task.start_at, task.end_at, task.id))
        for task in local_route.tasks:
            if task.id in local_route.transitions:
                route.transitions[task.id] = local_route.transitions[task.id]

    candidate.shift_assignments.extend(local.shift_assignments)
    candidate.shift_assignments.sort(key=lambda shift: (shift.worker_id, shift.start_at, shift.end_at))
    candidate.companion_matches.extend(local.companion_matches)
    candidate.company_shuttle_missions.extend(local.company_shuttle_missions)

    assigned_ids = {
        task.id
        for route in candidate.routes.values()
        for task in route.tasks
    }
    candidate.unassigned_task_ids = [
        task.id for task in all_tasks if task.id not in assigned_ids
    ]
    candidate.coverage_count = len(assigned_ids)
    candidate.solver_status = "FEASIBLE"
    return candidate


def reoptimize_not_proven(
    tasks: Iterable[Task],
    workers,
    solution: Solution,
    cfg: OptimizerConfig,
    *,
    random_seed: int = 20260903,
    search_workers: int = 8,
) -> tuple[Solution, list[dict[str, object]]]:
    """Try exact local CP-SAT repairs for unresolved audit rows without regression.

    The exterior of the local closure is frozen from the accepted global plan.
    The audited task is mandatory. Local coverage may stay equal (safe swap) or
    increase, but it may never drop. Every merged global candidate must pass the
    independent validator and global coverage may never decrease.
    """
    from .horizon_solver_path import solve_horizon
    from .validator import validate_solution

    tasks = sorted(tasks, key=lambda t: (t.start_at, t.end_at, t.id))
    workers = list(workers)
    task_by_id = {task.id: task for task in tasks}
    current = deepcopy(solution)
    events: list[dict[str, object]] = []
    max_candidates = max(0, int(cfg.audit_max_reoptimization_candidates))
    attempts = 0
    seen_signatures = {
        frozenset(
            task.id
            for route in current.routes.values()
            for task in route.tasks
        )
    }

    while attempts < max_candidates:
        audits = audit_unassigned(tasks, current, cfg)
        unresolved = [row for row in audits if row["status"] == "not_proven"]
        if not unresolved:
            current.unassigned_audit = audits
            return current, events

        accepted = False
        for row in unresolved:
            if attempts >= max_candidates:
                break
            attempts += 1
            target = task_by_id[str(row["task_id"])]
            local_ids = _local_reoptimization_ids(tasks, current, target, cfg)
            local_tasks = [task for task in tasks if task.id in local_ids]
            current_assigned = {
                task.id
                for route in current.routes.values()
                for task in route.tasks
                if task.id in local_ids
            }

            required_floor = len(current_assigned)

            local = solve_horizon(
                local_tasks,
                workers,
                cfg,
                time_limit_seconds=max(0.5, float(cfg.audit_local_time_limit_seconds)),
                random_seed=random_seed + attempts,
                search_workers=search_workers,
                seed_solution=None,
                required_task_ids={target.id},
                minimum_coverage=required_floor,
            )

            local_errors = validate_solution(local, cfg) if local.solver_status in {"OPTIMAL", "FEASIBLE"} else []
            local_valid = (
                local.solver_status in {"OPTIMAL", "FEASIBLE"}
                and not local_errors
                and target.id not in local.unassigned_task_ids
                and local.coverage_count >= required_floor
            )
            if not local_valid:
                events.append({
                    "task_id": target.id,
                    "status": "local_reoptimization_no_solution",
                    "local_task_count": len(local_tasks),
                    "current_local_coverage": len(current_assigned),
                    "required_local_coverage": required_floor,
                    "solver_status": local.solver_status,
                    "local_coverage": local.coverage_count,
                    "local_validation_error_count": len(local_errors),
                })
                continue

            candidate = _merge_local_solution(tasks, current, local, local_ids)
            errors = validate_solution(candidate, cfg)
            candidate_assigned = frozenset(
                task.id
                for route in candidate.routes.values()
                for task in route.tasks
            )
            target_kept = target.id in candidate_assigned
            non_regression = candidate.coverage_count >= current.coverage_count
            repeated = candidate_assigned in seen_signatures

            if errors or not target_kept or not non_regression or repeated:
                events.append({
                    "task_id": target.id,
                    "status": "global_merge_rejected",
                    "previous_coverage": current.coverage_count,
                    "candidate_coverage": candidate.coverage_count,
                    "target_kept": target_kept,
                    "validation_error_count": len(errors),
                    "validation_errors": [error.code for error in errors[:20]],
                    "repeated_assignment_signature": repeated,
                    "local_task_count": len(local_tasks),
                })
                continue

            previous_coverage = current.coverage_count
            delta = candidate.coverage_count - previous_coverage
            candidate.day_diagnostics = list(current.day_diagnostics)
            candidate.day_diagnostics.append({
                "mode": "audit_local_reoptimization",
                "task_id": target.id,
                "previous_coverage": previous_coverage,
                "new_coverage": candidate.coverage_count,
                "delta": delta,
                "local_task_count": len(local_tasks),
                "current_local_coverage": len(current_assigned),
                "new_local_coverage": local.coverage_count,
            })
            current = candidate
            seen_signatures.add(candidate_assigned)
            events.append({
                "task_id": target.id,
                "status": "improved" if delta > 0 else "safe_swap",
                "previous_coverage": previous_coverage,
                "new_coverage": current.coverage_count,
                "delta": delta,
                "local_task_count": len(local_tasks),
            })
            accepted = True
            break

        if not accepted:
            current.unassigned_audit = audit_unassigned(tasks, current, cfg)
            return current, events

    current.unassigned_audit = audit_unassigned(tasks, current, cfg)
    return current, events
