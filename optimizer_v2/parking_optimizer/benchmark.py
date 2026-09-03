from __future__ import annotations

import json
import time
from collections import defaultdict
from dataclasses import asdict
from pathlib import Path

import httpx

from .domain import Worker
from .shifts import operational_day
from .solver import solve
from .transitions import build_transition
from .validator import validate_solution
from .worker import _config, _prepare_tasks, _task_json, _transition_json, _iso, _shift_json

BENCHMARK_URL = "https://mvexykcxnpaywkbnoxwu.supabase.co/functions/v1/reservation-optimizer-benchmark-v1"
ARTIFACT_PATH = Path("benchmark_plan.json")


def _graph_diagnostics(tasks, cfg):
    by_day = defaultdict(list)
    for task in tasks:
        by_day[operational_day(task.start_at, cfg)].append(task)

    result = []
    for day in sorted(by_day):
        day_tasks = sorted(by_day[day], key=lambda task: (task.start_at, task.end_at, task.id))
        counts = defaultdict(int)
        direct_pairs = []
        for i, previous in enumerate(day_tasks):
            for current in day_tasks[i + 1:]:
                transition = build_transition(previous, current, cfg)
                if not transition.feasible:
                    continue
                counts[transition.kind] += 1
                if not transition.requires_companion and len(direct_pairs) < 100:
                    direct_pairs.append({
                        "previous_task_id": previous.id,
                        "current_task_id": current.id,
                        "previous_type": previous.task_type,
                        "current_type": current.task_type,
                        "previous_terminal": previous.terminal,
                        "current_terminal": current.terminal,
                        "previous_end_at": _iso(previous.end_at),
                        "current_start_at": _iso(current.start_at),
                        "kind": transition.kind,
                    })
        result.append({
            "operational_day": day.isoformat(),
            "task_count": len(day_tasks),
            "pickup_count": sum(task.task_type == "pickup" for task in day_tasks),
            "delivery_count": sum(task.task_type == "delivery" for task in day_tasks),
            "feasible_pair_counts": dict(sorted(counts.items())),
            "direct_non_companion_pair_count": sum(count for kind, count in counts.items() if kind not in {"ride_out", "ride_in"}),
            "direct_pair_samples": direct_pairs,
        })
    return result


def _serialize_solution(payload: dict, tasks, solution, errors, result: dict, cfg, graph_diagnostics) -> dict:
    routes = {}
    for worker_id, route in solution.routes.items():
        routes[worker_id] = {
            "worker": asdict(route.worker),
            "tasks": [_task_json(task) for task in route.tasks],
            "transitions": {task_id: _transition_json(transition) for task_id, transition in route.transitions.items()},
        }

    companions = [{
        "rider_worker_id": match.rider_worker_id,
        "rider_task_id": match.rider_task_id,
        "driver_worker_id": match.driver_worker_id,
        "driver_task_id": match.driver_task_id,
        "direction": match.direction,
        "depart_at": _iso(match.depart_at),
        "vehicle_leg_arrive_at": _iso(match.vehicle_leg_arrive_at),
        "arrive_at": _iso(match.arrive_at),
        "steps": [asdict(step) for step in match.steps],
    } for match in solution.companion_matches]

    assigned_ids = {task.id for route in solution.routes.values() for task in route.tasks}
    return {
        "contract": "optimizer_v2_benchmark_plan_v5_full_input_graph_audit",
        "benchmark": payload["contract"],
        "metrics": result,
        "work_policy": {
            "global_work_mode": cfg.global_work_mode,
            "shift_start": f"{cfg.shift_start_hour:02d}:{cfg.shift_start_minute:02d}",
            "normal_shift_duration_minutes": cfg.normal_shift_duration_minutes,
            "intensive_shift_duration_minutes": cfg.intensive_shift_duration_minutes,
            "max_effort_shift_duration_minutes": cfg.max_effort_shift_duration_minutes,
        },
        "input_tasks": [{**_task_json(task), "selected": task.id in assigned_ids} for task in tasks],
        "transition_graph_diagnostics": graph_diagnostics,
        "shift_assignments": [_shift_json(shift) for shift in solution.shift_assignments],
        "solver": {
            "status": solution.solver_status,
            "secondary_objective_value": solution.objective_value,
            "coverage_count": solution.coverage_count,
            "coverage_best_bound": solution.coverage_best_bound,
            "coverage_relative_gap": solution.coverage_relative_gap,
            "operational_day_count": solution.operational_day_count,
            "physical_feasible": len(errors) == 0,
        },
        "day_diagnostics": solution.day_diagnostics,
        "routes": routes,
        "companion_matches": companions,
        "unassigned_task_ids": list(solution.unassigned_task_ids),
        "validation_errors": [{
            "code": error.code,
            "worker_id": error.worker_id,
            "task_id": error.task_id,
            "detail": error.detail,
        } for error in errors],
    }


def main() -> None:
    started = time.monotonic()
    response = httpx.get(BENCHMARK_URL, timeout=60)
    response.raise_for_status()
    payload = response.json()
    if payload.get("contract") != "optimizer_v2_benchmark_150_v1":
        raise RuntimeError(f"unexpected benchmark contract: {payload.get('contract')!r}")

    cfg = _config(payload["config"])
    matrix = {(row["origin"], row["destination"], row["time_band"]): row for row in payload["matrix"]}
    tasks = _prepare_tasks(payload["tasks"], matrix, cfg)
    workers = [Worker(str(worker["id"]), worker["full_name"], worker.get("telegram_user_id")) for worker in payload["workers"]]

    if len(tasks) != 300:
        raise RuntimeError(f"expected 300 tasks, got {len(tasks)}")
    if len(workers) != 5:
        raise RuntimeError(f"expected 5 workers, got {len(workers)}")

    graph_diagnostics = _graph_diagnostics(tasks, cfg)
    solution = solve(tasks, workers, cfg, time_limit_seconds=60.0)
    errors = validate_solution(solution, cfg)
    elapsed = time.monotonic() - started
    assigned = len(tasks) - len(solution.unassigned_task_ids)
    by_worker = {route.worker.full_name: len(route.tasks) for route in solution.routes.values()}
    shift_counts = {"normal": 0, "intensive": 0, "max_effort": 0}
    for shift in solution.shift_assignments:
        shift_counts[shift.shift_type] += 1

    result = {
        "benchmark": payload["contract"],
        "task_count": len(tasks),
        "worker_count": len(workers),
        "assigned_count": assigned,
        "unassigned_count": len(solution.unassigned_task_ids),
        "coverage_pct": round(assigned * 100 / len(tasks), 2),
        "coverage_best_bound": solution.coverage_best_bound,
        "coverage_relative_gap_pct": None if solution.coverage_relative_gap is None else round(solution.coverage_relative_gap * 100, 3),
        "operational_day_count": solution.operational_day_count,
        "companion_count": len(solution.companion_matches),
        "global_work_mode": cfg.global_work_mode,
        "shift_counts": shift_counts,
        "validation_error_count": len(errors),
        "solver_status": solution.solver_status,
        "secondary_objective_value": solution.objective_value,
        "elapsed_seconds": round(elapsed, 3),
        "tasks_by_worker": by_worker,
        "day_diagnostics": solution.day_diagnostics,
        "graph_summary": [{key: value for key, value in row.items() if key != "direct_pair_samples"} for row in graph_diagnostics],
        "validation_errors": [{
            "code": error.code,
            "worker_id": error.worker_id,
            "task_id": error.task_id,
            "detail": error.detail,
        } for error in errors[:20]],
    }

    artifact = _serialize_solution(payload, tasks, solution, errors, result, cfg, graph_diagnostics)
    ARTIFACT_PATH.write_text(json.dumps(artifact, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")

    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    print(f"benchmark artifact written to {ARTIFACT_PATH}")

    if errors:
        raise SystemExit(2)
    if assigned < 119:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
