from __future__ import annotations

from collections import defaultdict
from typing import Iterable

from .daily_solver import solve_day
from .domain import OptimizerConfig, Solution, Task, Worker, WorkerRoute
from .shifts import operational_day
from .transitions import build_transition


def _mobility_diagnostics(day_tasks: list[Task], cfg: OptimizerConfig) -> dict[str, object]:
    ordered = sorted(day_tasks, key=lambda t: (t.start_at, t.end_at, t.id))
    pickups = sum(t.task_type == "pickup" for t in ordered)
    deliveries = len(ordered) - pickups
    direct = ride_out = ride_in = 0
    for i, previous in enumerate(ordered):
        for current in ordered[i + 1 :]:
            transition = build_transition(previous, current, cfg)
            if not transition.feasible:
                continue
            if transition.kind == "ride_out":
                ride_out += 1
            elif transition.kind == "ride_in":
                ride_in += 1
            elif not transition.requires_companion:
                direct += 1

    bottleneck = "none"
    detail = None
    if ordered and deliveries == len(ordered) and direct == 0:
        bottleneck = "airport_stranding_without_repositioning"
        detail = "All tasks are deliveries; company shuttle capacity is needed to return operators to PARKING."
    elif ordered and pickups == len(ordered) and direct == 0:
        bottleneck = "parking_stranding_without_repositioning"
        detail = "All tasks are pickups; company shuttle capacity is needed to send operators from PARKING to airport."
    elif pickups and deliveries and max(pickups, deliveries) >= 4 * min(pickups, deliveries):
        bottleneck = "strong_directional_imbalance"
        detail = f"Strong directional imbalance ({pickups} pickups / {deliveries} deliveries)."

    return {
        "pickup_count": pickups,
        "delivery_count": deliveries,
        "direct_non_companion_pair_count": direct,
        "ride_out_pair_count": ride_out,
        "ride_in_pair_count": ride_in,
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

    by_day = defaultdict(list)
    for task in tasks:
        by_day[operational_day(task.start_at, cfg)].append(task)
    days = sorted(by_day)
    per_day_seconds = max(60.0, float(time_limit_seconds))

    unassigned = []
    companions = []
    missions = []
    shifts = []
    coverage = 0
    bound = 0.0
    objective = 0
    statuses = []
    diagnostics = []

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
        missions.extend(day_solution.company_shuttle_missions)
        shifts.extend(day_solution.shift_assignments)
        coverage += day_solution.coverage_count
        objective += day_solution.objective_value or 0
        day_bound = day_solution.coverage_best_bound if day_solution.coverage_best_bound is not None else float(len(day_tasks))
        bound += day_bound

        diagnostics.append({
            "operational_day": str(day),
            "task_count": len(day_tasks),
            "coverage_count": day_solution.coverage_count,
            "unassigned_count": len(day_solution.unassigned_task_ids),
            "coverage_best_bound": day_bound,
            "coverage_relative_gap": day_solution.coverage_relative_gap,
            "solver_status": day_solution.solver_status,
            "shift_count": len(day_solution.shift_assignments),
            "companion_count": len(day_solution.companion_matches),
            "company_shuttle_mission_count": len(day_solution.company_shuttle_missions),
            "company_shuttle_vehicle_count": cfg.company_shuttle_vehicle_count,
            "company_shuttle_native_cp_sat": True,
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
        company_shuttle_missions=missions,
        shift_assignments=shifts,
        objective_value=objective,
        solver_status=status,
        coverage_count=coverage,
        coverage_best_bound=bound,
        coverage_relative_gap=gap,
        operational_day_count=len(days),
        day_diagnostics=diagnostics,
    )
