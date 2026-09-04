from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta
from typing import Iterable, Literal

from .continuous_seed import build_continuous_seed
from .domain import OptimizerConfig, Solution, Task, Worker
from .horizon_solver_path import solve_horizon
from .validator import validate_solution

BackForwardMode = Literal["fast", "optimal"]


def _ordered(tasks: Iterable[Task]) -> list[Task]:
    return sorted(tasks, key=lambda t: (t.start_at, t.end_at, t.id))


def _window_tasks(tasks: list[Task], start: datetime, minutes: int) -> list[Task]:
    end = start + timedelta(minutes=minutes)
    return [t for t in tasks if start <= t.start_at < end]


def _candidate_starts(tasks: list[Task], cfg: OptimizerConfig) -> list[datetime]:
    """Candidate 24h-like windows on a continuous timeline, never calendar days."""
    if not tasks:
        return []
    step = max(1, cfg.back_forward_candidate_step_minutes)
    first = tasks[0].start_at.replace(second=0, microsecond=0)
    last = tasks[-1].start_at
    starts: list[datetime] = []
    cur = first
    while cur <= last:
        starts.append(cur)
        cur += timedelta(minutes=step)
    # Task starts matter when the densest interval begins between grid points.
    starts.extend(t.start_at for t in tasks)
    return sorted(set(starts))


def _density(tasks: list[Task], start: datetime, window_minutes: int) -> int:
    end = start + timedelta(minutes=window_minutes)
    return sum(start <= t.start_at < end for t in tasks)


def _boundary_quality(solution: Solution, start: datetime, window_minutes: int, cfg: OptimizerConfig) -> float:
    """Prefer anchors that cover well without exhausting workers at both edges."""
    if not solution.coverage_count:
        return 0.0
    end = start + timedelta(minutes=window_minutes)
    margin = timedelta(minutes=max(30, cfg.back_forward_overlap_minutes))
    edge_tasks = 0
    for route in solution.routes.values():
        for task in route.tasks:
            if task.start_at < start + margin or task.end_at > end - margin:
                edge_tasks += 1
    # A soft score only; physical validity is handled independently.
    return max(0.25, 1.0 - (edge_tasks / max(1, solution.coverage_count)) * 0.25)


def _solve_window(
    tasks: list[Task],
    workers: list[Worker],
    cfg: OptimizerConfig,
    start: datetime,
    *,
    seconds: float,
    random_seed: int,
    search_workers: int,
) -> Solution:
    subset = _window_tasks(tasks, start, cfg.back_forward_window_minutes)
    seed = build_continuous_seed(subset, workers, cfg)
    seed_valid = not validate_solution(seed, cfg)
    solved = solve_horizon(
        subset,
        workers,
        cfg,
        time_limit_seconds=max(0.25, seconds),
        random_seed=random_seed,
        search_workers=search_workers,
        seed_solution=seed if seed_valid else None,
    )
    solved_valid = solved.solver_status in {"OPTIMAL", "FEASIBLE"} and not validate_solution(solved, cfg)
    if solved_valid and (not seed_valid or solved.coverage_count >= seed.coverage_count):
        return solved
    if seed_valid:
        seed.day_diagnostics.append({
            "mode": "window_seed_fallback",
            "cp_status": solved.solver_status,
            "cp_coverage": solved.coverage_count,
        })
        return seed
    return solved


def _select_anchor(
    tasks: list[Task],
    workers: list[Worker],
    cfg: OptimizerConfig,
    *,
    mode: BackForwardMode,
    time_budget: float,
    random_seed: int,
    search_workers: int,
):
    starts = _candidate_starts(tasks, cfg)
    ranked = sorted(
        starts,
        key=lambda s: (_density(tasks, s, cfg.back_forward_window_minutes), -s.timestamp()),
        reverse=True,
    )
    if mode == "fast":
        start = ranked[0]
        sol = _solve_window(
            tasks, workers, cfg, start,
            seconds=max(1.0, time_budget),
            random_seed=random_seed,
            search_workers=search_workers,
        )
        return start, sol, [{
            "phase": "anchor_probe",
            "mode": "fast",
            "start_at": start.isoformat(),
            "operation_count": _density(tasks, start, cfg.back_forward_window_minutes),
            "coverage_count": sol.coverage_count,
        }]

    # OPTIMAL sees the whole timeline first with a cheap continuous feasibility
    # probe. This prevents density from biasing anchor selection (e.g. 5/50).
    pre_ranked = []
    diagnostics = []
    for start in starts:
        subset = _window_tasks(tasks, start, cfg.back_forward_window_minutes)
        seed = build_continuous_seed(subset, workers, cfg)
        valid = not validate_solution(seed, cfg)
        operations = len(subset)
        quality = _boundary_quality(seed, start, cfg.back_forward_window_minutes, cfg) if valid else 0.0
        pre_score = float(seed.coverage_count) * quality if valid else 0.0
        pre_ranked.append(((pre_score, seed.coverage_count, operations, -start.timestamp()), start))
        diagnostics.append({
            "phase": "anchor_prescan",
            "mode": "optimal",
            "start_at": start.isoformat(),
            "operation_count": operations,
            "estimated_coverage_count": seed.coverage_count,
            "boundary_quality": round(quality, 4),
            "estimated_score": round(pre_score, 4),
            "valid": valid,
        })

    pre_ranked.sort(key=lambda item: item[0], reverse=True)
    limit = cfg.back_forward_max_anchor_candidates
    selected = pre_ranked if limit <= 0 else pre_ranked[:limit]
    candidates = [start for _, start in selected]
    per_candidate = max(0.5, time_budget / max(1, len(candidates)))

    best = None
    for index, start in enumerate(candidates):
        sol = _solve_window(
            tasks, workers, cfg, start,
            seconds=per_candidate,
            random_seed=random_seed + index,
            search_workers=search_workers,
        )
        operations = _density(tasks, start, cfg.back_forward_window_minutes)
        quality = _boundary_quality(sol, start, cfg.back_forward_window_minutes, cfg)
        score = float(sol.coverage_count) * quality
        diagnostics.append({
            "phase": "anchor_probe",
            "mode": "optimal",
            "start_at": start.isoformat(),
            "operation_count": operations,
            "coverage_count": sol.coverage_count,
            "boundary_quality": round(quality, 4),
            "score": round(score, 4),
        })
        key = (score, sol.coverage_count, operations, -start.timestamp())
        if best is None or key > best[0]:
            best = (key, start, sol)

    assert best is not None
    return best[1], best[2], diagnostics


def _record_preferences(solution: Solution, preferences: dict[str, str], weight: dict[str, int], bonus: int) -> None:
    for worker_id, route in solution.routes.items():
        for task in route.tasks:
            current = weight.get(task.id, -1)
            if bonus > current:
                preferences[task.id] = worker_id
                weight[task.id] = bonus


def solve_back_forward(
    tasks: Iterable[Task],
    workers: Iterable[Worker],
    cfg: OptimizerConfig,
    *,
    mode: BackForwardMode | None = None,
    time_limit_seconds: float = 180.0,
    random_seed: int = 20260903,
    search_workers: int = 8,
) -> Solution:
    """Adaptive rolling-horizon solver on a continuous 24/7 timeline.

    FAST chooses the densest window as anchor. OPTIMAL first evaluates candidate
    windows and chooses the best solved anchor. Both then use the same forward /
    backward expansion and the same continuous stitching pass.
    """
    tasks = _ordered(tasks)
    workers = list(workers)
    if not tasks:
        return Solution(routes={}, unassigned_task_ids=[], solver_status="OPTIMAL", coverage_count=0)

    selected_mode: BackForwardMode = mode or cfg.back_forward_mode
    if selected_mode not in ("fast", "optimal"):
        raise ValueError(f"invalid back_forward_mode: {selected_mode}")

    window = cfg.back_forward_window_minutes
    total_span = int((tasks[-1].end_at - tasks[0].start_at).total_seconds() // 60)
    base_seed = build_continuous_seed(tasks, workers, cfg)

    # For a horizon that already fits in one window, there are no boundaries to
    # manage; use the exact local CP-SAT formulation directly.
    if total_span <= window:
        local = solve_horizon(
            tasks, workers, cfg,
            time_limit_seconds=max(1.0, time_limit_seconds),
            random_seed=random_seed,
            search_workers=search_workers,
            seed_solution=base_seed if not validate_solution(base_seed, cfg) else None,
        )
        if local.solver_status in {"OPTIMAL", "FEASIBLE"} and not validate_solution(local, cfg):
            local.day_diagnostics.insert(0, {
                "mode": f"back_forward_{selected_mode}",
                "single_window": True,
                "window_minutes": window,
            })
            return local
        return base_seed

    # Reserve part of the budget for a final global CP-SAT logistics closure.
    # The rolling-horizon phase discovers a strong assignment/stitching incumbent;
    # the closure is responsible for preserving/rebuilding companion and company-
    # shuttle decisions on the final continuous 24/7 plan.
    closure_ratio = 0.25
    rolling_budget = max(1.0, time_limit_seconds * (1.0 - closure_ratio))
    explore_ratio = cfg.back_forward_optimal_explore_ratio if selected_mode == "optimal" else 0.12
    anchor_budget = max(1.0, rolling_budget * explore_ratio)
    anchor_start, anchor_solution, diagnostics = _select_anchor(
        tasks, workers, cfg,
        mode=selected_mode,
        time_budget=anchor_budget,
        random_seed=random_seed,
        search_workers=search_workers,
    )

    preferences: dict[str, str] = {}
    preference_weight: dict[str, int] = {}
    _record_preferences(anchor_solution, preferences, preference_weight, 1000)

    overlap = max(0, min(cfg.back_forward_overlap_minutes, window // 2))
    stride = max(1, window - overlap)
    horizon_start, horizon_end = tasks[0].start_at, tasks[-1].end_at

    # Same expansion engine for FAST and OPTIMAL.
    starts: list[tuple[str, datetime]] = []
    cur = anchor_start + timedelta(minutes=stride)
    while cur < horizon_end:
        starts.append(("forward", cur))
        cur += timedelta(minutes=stride)
    cur = anchor_start - timedelta(minutes=stride)
    while cur + timedelta(minutes=window) > horizon_start:
        starts.append(("backward", cur))
        cur -= timedelta(minutes=stride)

    remaining = max(1.0, rolling_budget - anchor_budget)
    per_window = max(0.5, remaining / max(1, len(starts)))
    for index, (direction, start) in enumerate(starts):
        subset = _window_tasks(tasks, start, window)
        if not subset:
            continue
        sol = _solve_window(
            tasks, workers, cfg, start,
            seconds=per_window,
            random_seed=random_seed + 100 + index,
            search_workers=search_workers,
        )
        valid = not validate_solution(sol, cfg)
        diagnostics.append({
            "phase": direction,
            "start_at": start.isoformat(),
            "task_count": len(subset),
            "coverage_count": sol.coverage_count,
            "solver_status": sol.solver_status,
            "valid": valid,
        })
        if valid:
            _record_preferences(sol, preferences, preference_weight, 500)

    # Stitch all window proposals on one continuous timeline. This is the
    # continuity barrier: every worker route is rebuilt chronologically and a
    # new shift may start only after policy rest.
    stitched = build_continuous_seed(
        tasks,
        workers,
        cfg,
        preferred_worker_by_task=preferences,
    )
    stitched_errors = validate_solution(stitched, cfg)

    # Never regress from the independent continuous baseline.
    chosen = stitched if not stitched_errors and stitched.coverage_count >= base_seed.coverage_count else base_seed
    pre_closure_coverage = chosen.coverage_count

    # Final global logistics closure.
    #
    # Window solutions may contain companion/company-shuttle decisions, but the
    # deterministic stitcher only rebuilds worker continuity. Run the canonical
    # CP-SAT path model once over the complete continuous timeline, warm-started
    # from the stitched assignment and with a hard coverage floor. Therefore:
    #   * coverage can improve but can never decrease;
    #   * company-shuttle fleet capacity is enforced globally;
    #   * companion seats are coupled globally;
    #   * the result remains a single 24/7 plan, not a set of day plans.
    closure_seconds = max(1.0, time_limit_seconds * closure_ratio)
    closure = solve_horizon(
        tasks,
        workers,
        cfg,
        time_limit_seconds=closure_seconds,
        random_seed=random_seed + 10000,
        search_workers=search_workers,
        seed_solution=chosen,
        minimum_coverage=pre_closure_coverage,
    )
    closure_errors = validate_solution(closure, cfg)
    closure_valid = (
        closure.solver_status in {"OPTIMAL", "FEASIBLE"}
        and not closure_errors
        and closure.coverage_count >= pre_closure_coverage
    )
    final = closure if closure_valid else chosen
    final.day_diagnostics = [{
        "mode": f"back_forward_{selected_mode}",
        "window_minutes": window,
        "overlap_minutes": overlap,
        "anchor_start_at": anchor_start.isoformat(),
        "anchor_operation_count": _density(tasks, anchor_start, window),
        "anchor_coverage_count": anchor_solution.coverage_count,
        "stitched_coverage_count": stitched.coverage_count,
        "baseline_coverage_count": base_seed.coverage_count,
        "pre_closure_coverage_count": pre_closure_coverage,
        "closure_coverage_count": closure.coverage_count,
        "closure_valid": closure_valid,
        "closure_validation_error_count": len(closure_errors),
        "closure_companion_count": len(closure.companion_matches),
        "closure_company_shuttle_mission_count": len(closure.company_shuttle_missions),
        "window_count": 1 + len(starts),
    }, *diagnostics, *closure.day_diagnostics]
    return final
