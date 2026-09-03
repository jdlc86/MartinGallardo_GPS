from __future__ import annotations

from typing import Iterable

from .back_forward_solver import solve_back_forward
from .domain import OptimizerConfig, Solution, Task, Worker
from .unassigned_audit import audit_unassigned


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
    solution.unassigned_audit = audit_unassigned(tasks, solution, cfg)
    return solution
