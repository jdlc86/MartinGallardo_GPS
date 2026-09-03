from __future__ import annotations

from typing import Iterable

from .domain import OptimizerConfig, Solution, Task, Worker
from .hybrid_solver import solve_hybrid


def solve(
    tasks: Iterable[Task],
    workers: Iterable[Worker],
    cfg: OptimizerConfig,
    *,
    time_limit_seconds: float = 180.0,
    random_seed: int = 20260903,
    search_workers: int = 8,
) -> Solution:
    """Public optimizer entry point: robust continuous 24/7 planning.

    A proven daily CP-SAT solution is first built as a safe incumbent/fallback.
    The continuous-horizon CP-SAT model then receives the remaining budget to
    improve coverage while respecting policy rest and physical continuity.
    """
    return solve_hybrid(
        tasks,
        workers,
        cfg,
        time_limit_seconds=time_limit_seconds,
        random_seed=random_seed,
        search_workers=search_workers,
    )
