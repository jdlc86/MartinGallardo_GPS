from __future__ import annotations

from typing import Iterable

from .domain import OptimizerConfig, Solution, Task, Worker
from .horizon_solver import solve_horizon


def solve(
    tasks: Iterable[Task],
    workers: Iterable[Worker],
    cfg: OptimizerConfig,
    *,
    time_limit_seconds: float = 180.0,
    random_seed: int = 20260903,
    search_workers: int = 8,
) -> Solution:
    """Public optimizer entry point: continuous 24/7 workforce planning.

    Calendar-day boundaries no longer constrain worker availability. A worker
    may start a new shift at any task location after satisfying the rest period
    of the policy chosen for that new shift.
    """
    return solve_horizon(
        tasks,
        workers,
        cfg,
        time_limit_seconds=time_limit_seconds,
        random_seed=random_seed,
        search_workers=search_workers,
    )
