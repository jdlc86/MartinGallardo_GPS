from __future__ import annotations

from collections import defaultdict
from typing import Iterable

from .daily_solver import solve_day
from .domain import OptimizerConfig, Solution, Task, Worker, WorkerRoute
from .shifts import operational_day
from .transitions import build_transition


def _mobility_diagnostics(day_tasks: list[Task], cfg: OptimizerConfig) -> dict[str, object]:
    """Describe structural transport limits without changing feasibility rules.

    The diagnostic deliberately uses the same canonical transition builder as the
    solver/validator.  It is therefore an explanation of the current domain model,
    not a second approximation of physical feasibility.
    """
    ordered = sorted(day_tasks, key=lambda task: (task.start_at, task.end_at, task.id))
    pickup_count = sum(task.task_type == "pickup" for task in ordered)
    delivery_count = len(ordered) - pickup_count
    direct_pairs = 0
    ride_out_pairs = 0
    ride_in_pairs = 0

    for index, previous in enumerate(ordered):
        for current in ordered[index + 1 :]:
            transition = build_transition(previous, current, cfg)
            if not transition.feasible:
                continue
            if transition.kind == "ride_out":
                ride_out_pairs += 1
            elif transition.kind == "ride_in":
                ride_in_pairs += 1
            elif not transition.requires_companion:
                direct_pairs += 1

    bottleneck = "none"
    detail = None
    if ordered and delivery_count == len(ordered) and direct_pairs == 0:
        bottleneck = "airport_stranding_no_return_vehicle"
        detail = (
            "All tasks are deliveries. After a worker reaches the airport, the current "
            "model has no pickup vehicle that can return that worker to PARKING."
        )
    elif ordered and pickup_count == len(ordered) and direct_pairs == 0:
        bottleneck = "parking_stranding_no_outbound_vehicle"
        detail = (
            "All tasks are pickups. After a worker reaches PARKING, the current model "
            "has no delivery vehicle that can take that worker back to the airport."
        )
    elif pickup_count > 0 and delivery_count > 0:
        larger = max(pickup_count, delivery_count)
        smaller = min(pickup_count, delivery_count)
        if smaller > 0 and larger >= 4 * smaller:
            bottleneck = "strong_directional_imbalance"
            scarce = "deliveries" if pickup_count > delivery_count else "pickups"
            detail = (
                f"Task flow is strongly directional ({pickup_count} pickups / "
                f"{delivery_count} deliveries); {scarce} are the scarce vehicle flow "
                "needed to reposition workers."
            )

    return {
        "pickup_count": pickup_count,
        "delivery_count": delivery_count,
        "direct_non_companion_pair_count": direct_pairs,
        "ride_out_pair_count": ride_out_pairs,
        "ride_in_pair_count": ride_in_pairs,
        "mobility_bottleneck": bottleneck,
        "mobility_bottleneck_detail": detail,
    }


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
        day_tasks = by_day[day]
        mobility = _mobility_diagnostics(day_tasks, cfg)
        day_solution = solve_day(
            day_tasks,
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
            else float(len(day_tasks))
        )
        bound += day_bound
        objective += day_solution.objective_value or 0

        day_diagnostics.append({
            "operational_day": str(day),
            "task_count": len(day_tasks),
            "coverage_count": day_solution.coverage_count,
            "unassigned_count": len(day_solution.unassigned_task_ids),
            "coverage_best_bound": day_bound,
            "coverage_relative_gap": day_solution.coverage_relative_gap,
            "solver_status": day_solution.solver_status,
            "shift_count": len(day_solution.shift_assignments),
            "companion_count": len(day_solution.companion_matches),
            "time_budget_seconds": per_day_seconds,
            **mobility,
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
