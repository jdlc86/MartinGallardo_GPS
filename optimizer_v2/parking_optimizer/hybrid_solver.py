from __future__ import annotations

from collections import defaultdict
from datetime import date
from typing import Iterable

from .daily_solver import solve_day
from .domain import OptimizerConfig, ShiftAssignment, Solution, Task, Worker, WorkerRoute
from .horizon_solver_compact import solve_horizon
from .shifts import operational_day, shift_window


def _seed_solution(
    tasks: list[Task],
    workers: list[Worker],
    cfg: OptimizerConfig,
    *,
    time_limit_seconds: float,
    random_seed: int,
    search_workers: int,
) -> Solution:
    """Build a fast, physically valid baseline using the proven daily solver.

    The daily solver is used only as a seed/fallback. Its shift assignments are
    normalized to the configured global mode so consecutive daily blocks satisfy
    the global mode's rest interval exactly (normal 12h, intensive 6h,
    max_effort 2h with the current defaults).
    """
    by_day: dict[date, list[Task]] = defaultdict(list)
    for task in tasks:
        by_day[operational_day(task.start_at, cfg)].append(task)

    routes = {worker.id: WorkerRoute(worker) for worker in workers}
    companions = []
    missions = []
    shifts: list[ShiftAssignment] = []
    assigned_ids: set[str] = set()
    diagnostics = []
    bound_total = 0.0
    has_bound = True

    days = sorted(by_day)
    per_day = max(1.0, time_limit_seconds / max(1, len(days)))
    for index, day in enumerate(days):
        day_solution = solve_day(
            by_day[day],
            workers,
            cfg,
            time_limit_seconds=per_day,
            random_seed=random_seed + index,
            search_workers=search_workers,
        )
        for worker in workers:
            src = day_solution.routes[worker.id]
            routes[worker.id].tasks.extend(src.tasks)
            routes[worker.id].transitions.update(src.transitions)
            assigned_ids.update(task.id for task in src.tasks)
        companions.extend(day_solution.companion_matches)
        missions.extend(day_solution.company_shuttle_missions)

        # Normalize every used worker/day block to the global mode. Any task that
        # fit a shorter allowed shift also fits the global mode's wider window.
        used_workers = {
            worker.id for worker in workers if day_solution.routes[worker.id].tasks
        }
        start_at, end_at = shift_window(day, cfg.global_work_mode, cfg)
        for worker_id in sorted(used_workers):
            shifts.append(
                ShiftAssignment(
                    worker_id=worker_id,
                    operational_day=day,
                    shift_type=cfg.global_work_mode,
                    start_at=start_at,
                    end_at=end_at,
                )
            )

        if day_solution.coverage_best_bound is None:
            has_bound = False
        else:
            bound_total += day_solution.coverage_best_bound
        diagnostics.append(
            {
                "operational_day": day.isoformat(),
                "mode": "daily_seed",
                "task_count": len(by_day[day]),
                "coverage_count": day_solution.coverage_count,
                "solver_status": day_solution.solver_status,
            }
        )

    for route in routes.values():
        route.tasks.sort(key=lambda task: (task.start_at, task.id))

    coverage = len(assigned_ids)
    bound = bound_total if has_bound else None
    gap = None if bound is None or bound <= 0 else max(0.0, (bound - coverage) / bound)
    return Solution(
        routes=routes,
        unassigned_task_ids=[task.id for task in tasks if task.id not in assigned_ids],
        companion_matches=companions,
        company_shuttle_missions=missions,
        shift_assignments=sorted(shifts, key=lambda shift: (shift.worker_id, shift.start_at)),
        solver_status="FEASIBLE",
        coverage_count=coverage,
        coverage_best_bound=bound,
        coverage_relative_gap=gap,
        operational_day_count=len(days),
        day_diagnostics=diagnostics,
    )


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

    # Spend at most 30% of the budget on a robust incumbent. The remainder goes
    # to the continuous model. This baseline also prevents a regression to 0
    # coverage when the global model cannot find an incumbent in time.
    seed_budget = max(6.0, min(time_limit_seconds * 0.30, 30.0))
    seed = _seed_solution(
        tasks,
        workers,
        cfg,
        time_limit_seconds=seed_budget,
        random_seed=random_seed,
        search_workers=search_workers,
    )

    global_budget = max(1.0, time_limit_seconds - seed_budget)
    global_solution = solve_horizon(
        tasks,
        workers,
        cfg,
        time_limit_seconds=global_budget,
        random_seed=random_seed + 1000,
        search_workers=search_workers,
    )

    if global_solution.solver_status in {"OPTIMAL", "FEASIBLE"} and global_solution.coverage_count >= seed.coverage_count:
        global_solution.day_diagnostics.insert(
            0,
            {
                "mode": "daily_seed_baseline",
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
