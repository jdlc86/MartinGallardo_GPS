from __future__ import annotations

import json
import time
from dataclasses import asdict
from pathlib import Path

import httpx

from .domain import Worker
from .solver import solve
from .validator import validate_solution
from .worker import _config, _prepare_tasks, _task_json, _transition_json, _iso, _shift_json

BENCHMARK_URL = "https://mvexykcxnpaywkbnoxwu.supabase.co/functions/v1/reservation-optimizer-benchmark-v1"
ARTIFACT_PATH = Path("benchmark_plan.json")


def _serialize_solution(payload: dict, solution, errors, result: dict, cfg) -> dict:
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

    return {
        "contract": "optimizer_v2_benchmark_plan_v2_daily_shifts",
        "benchmark": payload["contract"],
        "metrics": result,
        "work_policy": {
            "global_work_mode": cfg.global_work_mode,
            "shift_start": f"{cfg.shift_start_hour:02d}:{cfg.shift_start_minute:02d}",
            "normal_shift_duration_minutes": cfg.normal_shift_duration_minutes,
            "intensive_shift_duration_minutes": cfg.intensive_shift_duration_minutes,
            "max_effort_shift_duration_minutes": cfg.max_effort_shift_duration_minutes,
        },
        "shift_assignments": [_shift_json(shift) for shift in solution.shift_assignments],
        "solver": {
            "status": solution.solver_status,
            "objective_value": solution.objective_value,
            "physical_feasible": len(errors) == 0,
        },
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

    solution = solve(tasks, workers, cfg, time_limit_seconds=180.0)
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
        "companion_count": len(solution.companion_matches),
        "global_work_mode": cfg.global_work_mode,
        "shift_counts": shift_counts,
        "validation_error_count": len(errors),
        "solver_status": solution.solver_status,
        "objective_value": solution.objective_value,
        "elapsed_seconds": round(elapsed, 3),
        "tasks_by_worker": by_worker,
        "validation_errors": [{
            "code": error.code,
            "worker_id": error.worker_id,
            "task_id": error.task_id,
            "detail": error.detail,
        } for error in errors[:20]],
    }

    artifact = _serialize_solution(payload, solution, errors, result, cfg)
    ARTIFACT_PATH.write_text(json.dumps(artifact, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")

    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    print(f"benchmark artifact written to {ARTIFACT_PATH}")

    if errors:
        raise SystemExit(2)
    if assigned < 119:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
