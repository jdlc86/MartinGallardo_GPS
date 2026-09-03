from __future__ import annotations

from typing import Iterable

from .continuous_seed import build_continuous_seed
from .domain import OptimizerConfig, Solution, Task, Worker, WorkerRoute
from .horizon_solver_compact import solve_horizon


def solve_hybrid(
    tasks: Iterable[Task],
    workers: Iterable[Worker],
    cfg: OptimizerConfig,
    *,
    time_limit_seconds: float = 180.0,
    random_seed: int = 20260903,
    search_workers: int = 8,
) -> Solution:
    tasks = list(tasks)
    workers = list(workers)
    if not tasks:
        return Solution(
            routes={worker.id: WorkerRoute(worker) for worker in workers},
            unassigned_task_ids=[],
            solver_status="OPTIMAL",
            coverage_count=0,
            coverage_best_bound=0.0,
            coverage_relative_gap=0.0,
        )

    # Deterministic 24/7 baseline. It is independent of calendar-day cuts and
    # therefore already obeys the same work/rest paradigm as the global model.
    seed = build_continuous_seed(tasks, workers, cfg)

    # The seed is effectively free compared with CP-SAT, so the complete solver
    # budget remains available to the global continuous model.
    global_solution = solve_horizon(
        tasks,
        workers,
        cfg,
        time_limit_seconds=max(1.0, time_limit_seconds),
        random_seed=random_seed + 1000,
        search_workers=search_workers,
    )

    if (
        global_solution.solver_status in {"OPTIMAL", "FEASIBLE"}
        and global_solution.coverage_count >= seed.coverage_count
    ):
        global_solution.day_diagnostics.insert(
            0,
            {
                "mode": "continuous_seed_baseline",
                "coverage_count": seed.coverage_count,
                "global_improvement": global_solution.coverage_count - seed.coverage_count,
            },
        )
        return global_solution

    seed.day_diagnostics.append(
        {
            "mode": "continuous_fallback",
            "continuous_status": global_solution.solver_status,
            "continuous_coverage": global_solution.coverage_count,
            "baseline_retained": True,
        }
    )
    return seed
