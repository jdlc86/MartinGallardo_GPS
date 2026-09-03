from __future__ import annotations

import json
import time

import httpx

from .domain import Worker
from .solver import solve
from .validator import validate_solution
from .worker import _config, _prepare_tasks

BENCHMARK_URL = "https://mvexykcxnpaywkbnoxwu.supabase.co/functions/v1/reservation-optimizer-benchmark-v1"


def main() -> None:
    started = time.monotonic()
    response = httpx.get(BENCHMARK_URL, timeout=60)
    response.raise_for_status()
    payload = response.json()
    if payload.get("contract") != "optimizer_v2_benchmark_150_v1":
        raise RuntimeError(f"unexpected benchmark contract: {payload.get('contract')!r}")

    cfg = _config(payload["config"])
    matrix = {
        (row["origin"], row["destination"], row["time_band"]): row
        for row in payload["matrix"]
    }
    tasks = _prepare_tasks(payload["tasks"], matrix, cfg)
    workers = [
        Worker(str(worker["id"]), worker["full_name"], worker.get("telegram_user_id"))
        for worker in payload["workers"]
    ]

    if len(tasks) != 300:
        raise RuntimeError(f"expected 300 tasks, got {len(tasks)}")
    if len(workers) != 5:
        raise RuntimeError(f"expected 5 workers, got {len(workers)}")

    solution = solve(tasks, workers, cfg, time_limit_seconds=180.0)
    errors = validate_solution(solution, cfg)
    elapsed = time.monotonic() - started
    assigned = len(tasks) - len(solution.unassigned_task_ids)
    by_worker = {
        route.worker.full_name: len(route.tasks)
        for route in solution.routes.values()
    }
    result = {
        "benchmark": payload["contract"],
        "task_count": len(tasks),
        "worker_count": len(workers),
        "assigned_count": assigned,
        "unassigned_count": len(solution.unassigned_task_ids),
        "coverage_pct": round(assigned * 100 / len(tasks), 2),
        "companion_count": len(solution.companion_matches),
        "validation_error_count": len(errors),
        "solver_status": solution.solver_status,
        "objective_value": solution.objective_value,
        "elapsed_seconds": round(elapsed, 3),
        "tasks_by_worker": by_worker,
        "validation_errors": [
            {
                "code": error.code,
                "worker_id": error.worker_id,
                "task_id": error.task_id,
                "detail": error.detail,
            }
            for error in errors[:20]
        ],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))

    if errors:
        raise SystemExit(2)
    if assigned < 119:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
