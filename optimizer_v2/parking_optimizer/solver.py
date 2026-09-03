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
    intentionally resets only at the configured start of a new operational day.
    Companion movements are forbidden across that boundary by the validator.
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
        )

    by_day: dict[object, list[Task]] = defaultdict(list)
    for task in tasks:
        by_day[operational_day(task.start_at, cfg)].append(task)
    days = sorted(by_day)

    # Every operational day receives a real CP-SAT budget. This is the main
    # protection against a busy day consuming the entire horizon budget.
    per_day_seconds = max(5.0, time_limit_seconds / len(days))

    unassigned: list[str] = []
    companions = []
    shifts = []
    coverage = 0
    bound = 0.0
    objective = 0
    statuses: list[str] = []

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
        bound += day_solution.coverage_best_bound if day_solution.coverage_best_bound is not None else len(by_day[day])
        objective += day_solution.objective_value or 0

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
    )
