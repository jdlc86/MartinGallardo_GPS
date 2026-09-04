from __future__ import annotations

import time
from typing import Iterable

from .back_forward_solver import solve_back_forward
from .domain import OptimizerConfig, Solution, Task, Worker
from .unassigned_audit import (
    audit_summary,
    audit_unassigned,
    repair_audited_insertions,
    reoptimize_not_proven,
)


def solve_phase1(
    tasks: Iterable[Task],
    workers: Iterable[Worker],
    cfg: OptimizerConfig,
    *,
    time_limit_seconds: float = 180.0,
    random_seed: int = 20260903,
    search_workers: int = 8,
) -> Solution:
    """Completed Back-Forward planner: FAST/OPTIMAL on a continuous 24/7 timeline.

    Phase 1 owns the production planning algorithm. FAST and OPTIMAL differ only
    in anchor selection; both use the same forward/backward rolling-horizon
    engine and the same continuity stitching. The mandatory conservative audit
    may directly insert only operations proven valid in the accepted plan.

    Local CP-SAT reoptimization of unresolved audit rows is deliberately NOT
    part of this phase.
    """
    tasks = list(tasks)
    workers = list(workers)

    solution = solve_back_forward(
        tasks,
        workers,
        cfg,
        time_limit_seconds=time_limit_seconds,
        random_seed=random_seed,
        search_workers=search_workers,
    )
    final, repairs = repair_audited_insertions(tasks, solution, cfg)
    final.unassigned_audit = audit_unassigned(tasks, final, cfg)
    summary = audit_summary(final.unassigned_audit)
    final.day_diagnostics.append({
        "mode": "phase1_completed_back_forward",
        "back_forward_mode": cfg.back_forward_mode,
        "direct_audit_inserted_count": sum(
            1 for row in repairs if row.get("status") == "inserted"
        ),
        "direct_audit_repair_event_count": len(repairs),
        "unassigned_audit": summary,
    })
    return final


def run_phase2_reoptimization(
    tasks: Iterable[Task],
    workers: Iterable[Worker],
    phase1_solution: Solution,
    cfg: OptimizerConfig,
    *,
    random_seed: int = 20265903,
    search_workers: int = 8,
) -> Solution:
    """Experimental Phase 2: non-regressive local reoptimization of NOT_PROVEN.

    The accepted Phase 1 solution is the immutable score baseline. A local
    proposal is accepted only when the rebuilt global plan passes the physical
    validator and global coverage does not decrease.
    """
    tasks = list(tasks)
    workers = list(workers)

    baseline = phase1_solution
    pre_audit = audit_unassigned(tasks, baseline, cfg)
    pre_summary = audit_summary(pre_audit)
    started = time.monotonic()

    reoptimized, events = reoptimize_not_proven(
        tasks,
        workers,
        baseline,
        cfg,
        random_seed=random_seed,
        search_workers=search_workers,
    )
    reopt_seconds = time.monotonic() - started

    final, post_repairs = repair_audited_insertions(tasks, reoptimized, cfg)
    final.unassigned_audit = audit_unassigned(tasks, final, cfg)
    post_summary = audit_summary(final.unassigned_audit)
    final.day_diagnostics.append({
        "mode": "phase2_local_reoptimization_experimental",
        "coverage_before": baseline.coverage_count,
        "coverage_after": final.coverage_count,
        "not_proven_before": pre_summary["not_proven"],
        "not_proven_after": post_summary["not_proven"],
        "proven_unavailable_before": pre_summary["proven_unavailable_in_current_plan"],
        "proven_unavailable_after": post_summary["proven_unavailable_in_current_plan"],
        "local_reoptimization_event_count": len(events),
        "local_reoptimization_improvements": sum(
            1 for row in events if row.get("status") == "improved"
        ),
        "local_reoptimization_safe_swaps": sum(
            1 for row in events if row.get("status") == "safe_swap"
        ),
        "post_reoptimization_direct_insertions": sum(
            1 for row in post_repairs if row.get("status") == "inserted"
        ),
        "elapsed_seconds": round(reopt_seconds, 3),
    })
    return final


def solve(
    tasks: Iterable[Task],
    workers: Iterable[Worker],
    cfg: OptimizerConfig,
    *,
    time_limit_seconds: float = 180.0,
    random_seed: int = 20260903,
    search_workers: int = 8,
) -> Solution:
    """Stable public entry point for the completed Phase 1 planner.

    Phase 2 must be invoked explicitly with run_phase2_reoptimization().
    """
    return solve_phase1(
        tasks,
        workers,
        cfg,
        time_limit_seconds=time_limit_seconds,
        random_seed=random_seed,
        search_workers=search_workers,
    )
