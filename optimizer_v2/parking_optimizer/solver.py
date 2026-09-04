from __future__ import annotations

import time
from typing import Iterable

from .back_forward_solver import solve_back_forward
from .domain import OptimizerConfig, Solution, Task, Worker
from .unassigned_audit import audit_summary, audit_unassigned, repair_audited_insertions, reoptimize_not_proven


def solve(
    tasks: Iterable[Task],
    workers: Iterable[Worker],
    cfg: OptimizerConfig,
    *,
    time_limit_seconds: float = 180.0,
    random_seed: int = 20260903,
    search_workers: int = 8,
) -> Solution:
    """Public optimizer entry point: adaptive Back-Forward rolling horizon.

    The parking is modeled as a continuous 24/7 timeline. FAST and OPTIMAL
    differ only in anchor selection; both share the same forward/backward
    expansion and continuity stitching.
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
    repaired, repairs = repair_audited_insertions(tasks, solution, cfg)
    pre_reopt_audit = audit_unassigned(tasks, repaired, cfg)
    pre_reopt_summary = audit_summary(pre_reopt_audit)
    reopt_started = time.monotonic()
    reoptimized, reopt_events = reoptimize_not_proven(
        tasks,
        workers,
        repaired,
        cfg,
        random_seed=random_seed + 5000,
        search_workers=search_workers,
    )
    reopt_seconds = time.monotonic() - reopt_started
    final, post_repairs = repair_audited_insertions(tasks, reoptimized, cfg)
    final.unassigned_audit = audit_unassigned(tasks, final, cfg)
    post_reopt_summary = audit_summary(final.unassigned_audit)
    final.day_diagnostics.append({
        "mode": "unassigned_audit_repair",
        "inserted_count": sum(1 for row in repairs + post_repairs if row.get("status") == "inserted"),
        "repair_event_count": len(repairs) + len(post_repairs),
        "local_reoptimization_event_count": len(reopt_events),
        "local_reoptimization_improvements": sum(1 for row in reopt_events if row.get("status") == "improved"),
        "local_reoptimization_safe_swaps": sum(1 for row in reopt_events if row.get("status") == "safe_swap"),
        "local_reoptimization_seconds": round(reopt_seconds, 3),
        "coverage_before_local_reoptimization": repaired.coverage_count,
        "coverage_after_local_reoptimization": final.coverage_count,
        "not_proven_before_local_reoptimization": pre_reopt_summary["not_proven"],
        "not_proven_after_local_reoptimization": post_reopt_summary["not_proven"],
        "proven_unavailable_before_local_reoptimization": pre_reopt_summary["proven_unavailable_in_current_plan"],
        "proven_unavailable_after_local_reoptimization": post_reopt_summary["proven_unavailable_in_current_plan"],
    })
    return final
