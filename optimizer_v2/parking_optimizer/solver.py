from __future__ import annotations

from collections import defaultdict
from typing import Iterable

from .daily_solver import solve_day
from .domain import OptimizerConfig, Solution, Task, Worker, WorkerRoute
from .shifts import operational_day


def solve(
    tasks: Iterable[Task],
    workers: Iterable[Worker],
    cfg: OptimizerConfig,
    *,
    time_limit_seconds: float = 60.0,
    random_seed: int = 20260903,
    search_workers: int = 8,
) -> Solution:
    """Solve independently per operational day, then merge the plans.

    Daily decomposition is exact for the current domain because physical continuity
    resets only at the configured start of a new operational day and companion
    movements cannot cross that boundary.

    ``time_limit_seconds`` is a quality budget for one daily subproblem, not a
    horizon-wide budget to divide among all days. The asynchronous worker owns the
    horizon runtime, so adding days must not starve each CP-SAT subproblem.
    """
    tasks = list(tasks)
    workers = list(workers)
    routes = {worker.id: WorkerRoute(worker) for worker in workers}
    if not tasks:
        return Solution(
            routes=routes,
            unassigned_task_ids=[],
            solver_status="OPTIMAL",
            coverage_count=0,
            coverage_best_bound=0.0,
            coverage_relative_gap=0.0,
            operational_day_count=0,
            day_diagnostics=[],
        )

    by_day: dict[object, list[Task]] = defaultdict(list)
    for task in tasks:
        by_day[operational_day(task.start_at, cfg)].append(task)
    days = sorted(by_day)

    # Never starve a daily model because the requested horizon is longer.
    # 60 s/day is the quality floor; callers may explicitly request more.
    per_day_seconds = max(60.0, float(time_limit_seconds))

    unassigned: list[str] = []
    companions = []
    shifts = []
    coverage = 0
    bound = 0.0
    objective = 0
    statuses: list[str] = []
    day_diagnostics: list[dict[str, object]] = []

    for index, day in enumerate(days):
        day_solution = solve_day(
            by_day[day],
            workers,
            cfg,
            time_limit_seconds=per_day_seconds,
            random_seed=random_seed + index * 101,
            search_workers=search_workers,
        )
        statuses.append(day_solution.solver_status)
        unassigned.extend(day_solution.unassigned_task_ids)
        companions.extend(day_solution.companion_matches)
        shifts.extend(day_solution.shift_assignments)
        coverage += day_solution.coverage_count
        day_bound = (
            day_solution.coverage_best_bound
            if day_solution.coverage_best_bound is not None
            else float(len(by_day[day]))
        )
        bound += day_bound
        objective += day_solution.objective_value or 0

        day_diagnostics.append({
            "operational_day": str(day),
            "task_count": len(by_day[day]),
            "coverage_count": day_solution.coverage_count,
            "unassigned_count": len(day_solution.unassigned_task_ids),
            "coverage_best_bound": day_bound,
            "coverage_relative_gap": day_solution.coverage_relative_gap,
            "solver_status": day_solution.solver_status,
            "shift_count": len(day_solution.shift_assignments),
            "companion_count": len(day_solution.companion_matches),
            "time_budget_seconds": per_day_seconds,
        })

        for worker_id, day_route in day_solution.routes.items():
            routes[worker_id].tasks.extend(day_route.tasks)
            routes[worker_id].transitions.update(day_route.transitions)

    for route in routes.values():
        route.tasks.sort(key=lambda task: (task.start_at, task.id))

    if all(status == "OPTIMAL" for status in statuses):
        status = "OPTIMAL"
    elif all(status in {"OPTIMAL", "FEASIBLE"} for status in statuses):
        status = "FEASIBLE"
    else:
        status = "PARTIAL"

    gap = 0.0 if bound <= 0 else max(0.0, (bound - coverage) / bound)
    return Solution(
        routes=routes,
        unassigned_task_ids=unassigned,
        companion_matches=companions,
        shift_assignments=shifts,
        objective_value=objective,
        solver_status=status,
        coverage_count=coverage,
        coverage_best_bound=bound,
        coverage_relative_gap=gap,
        operational_day_count=len(days),
        day_diagnostics=day_diagnostics,
    )
