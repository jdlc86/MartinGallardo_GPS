from __future__ import annotations

import json
import time
from dataclasses import asdict
from datetime import datetime, timezone

from .domain import Worker
from .reporting import build_reports
from .solver import solve
from .validator import validate_solution
from .worker import Backend, _config, _iso, _prepare_tasks, _shift_json, _task_json, _transition_json


def process_job(backend: Backend, job: dict, worker_id: str) -> None:
    """Execute one durable optimizer job with the canonical V2 model."""
    job_id = job["id"]
    started = time.monotonic()
    backend.rpc("heartbeat_optimization_job", {
        "p_job_id": job_id, "p_worker_id": worker_id, "p_lease_seconds": 900,
        "p_progress": {"stage": "snapshot", "percent": 5},
    })

    current = backend.select("optimization_jobs", {"id": f"eq.{job_id}", "select": "status", "limit": "1"})[0]
    if current["status"] == "cancel_requested":
        backend.patch("optimization_jobs", {"id": f"eq.{job_id}", "claimed_by": f"eq.{worker_id}"}, {
            "status": "cancelled", "finished_at": datetime.now(timezone.utc).isoformat(), "lease_until": None,
        })
        return

    cfg_raw = backend.select("ai_dispatch_config", {"id": "eq.1", "select": "*", "limit": "1"})[0]
    cfg = _config(cfg_raw)
    workers_raw = backend.select("workers", {
        "active": "eq.true", "role": "eq.operator", "select": "id,telegram_user_id,full_name", "order": "full_name.asc",
    })
    workers = [Worker(str(worker["id"]), worker["full_name"], worker.get("telegram_user_id")) for worker in workers_raw]
    if not workers:
        raise RuntimeError("no_active_workers")

    matrix_rows = backend.select("ai_dispatch_route_matrix", {
        "origin": "neq.T4S", "destination": "neq.T4S",
        "select": "origin,destination,time_band,current_duration_s,distance_m,is_anomaly,fetched_at",
    })
    matrix = {(row["origin"], row["destination"], row["time_band"]): row for row in matrix_rows}
    raw_tasks = backend.select("reservation_tasks", {
        "status": "in.(unassigned,assigned)",
        "scheduled_at": f"gte.{job['horizon_start']}", "and": f"(scheduled_at.lt.{job['horizon_end']})",
        "select": "id,booking_id,task_type,scheduled_at,assigned_worker_id,status,version,parking_bookings!inner(id,pickup_terminal,return_terminal,vehicle_plate,customer_name,deleted_at),workers(id,telegram_user_id,full_name)",
        "parking_bookings.deleted_at": "is.null", "order": "scheduled_at.asc",
    })
    tasks = _prepare_tasks(raw_tasks, matrix, cfg)
    fixed_task_ids = [task.id for task in tasks if task.fixed_worker_id]

    snapshot = {
        "contract": "optimizer_v2_snapshot_v3_daily_shifts",
        "task_versions": {task.id: task.version for task in tasks},
        "active_worker_ids": [worker.id for worker in workers],
        "config": asdict(cfg),
        "route_matrix_fetched_at": max((row.get("fetched_at") or "" for row in matrix_rows), default=None),
        "task_count": len(tasks), "fixed_task_ids": fixed_task_ids,
    }
    backend.patch("optimization_jobs", {"id": f"eq.{job_id}", "claimed_by": f"eq.{worker_id}"}, {
        "input_snapshot": snapshot, "progress": {"stage": "cp_sat", "percent": 20},
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })

    solution = solve(tasks, workers, cfg, time_limit_seconds=180.0)
    validation_errors = validate_solution(solution, cfg)
    assigned_count = len(tasks) - len(solution.unassigned_task_ids)
    coverage_complete = not solution.unassigned_task_ids
    physical_feasible = not validation_errors
    elapsed = time.monotonic() - started
    shift_counts = {"normal": 0, "intensive": 0, "max_effort": 0}
    for shift in solution.shift_assignments:
        shift_counts[shift.shift_type] += 1
    metrics = {
        "task_count": len(tasks), "assigned_count": assigned_count,
        "unassigned_count": len(solution.unassigned_task_ids),
        "coverage_pct": round(assigned_count * 100 / len(tasks), 2) if tasks else 100.0,
        "coverage_complete": coverage_complete, "physical_feasible": physical_feasible,
        "companion_count": len(solution.companion_matches), "shift_counts": shift_counts,
        "global_work_mode": cfg.global_work_mode, "solver_status": solution.solver_status,
        "objective_value": solution.objective_value, "validation_error_count": len(validation_errors),
        "elapsed_seconds": round(elapsed, 3),
    }

    if validation_errors:
        backend.rpc("fail_optimization_job", {
            "p_job_id": job_id, "p_worker_id": worker_id, "p_error_code": "physical_validation_failed",
            "p_error_detail": json.dumps([asdict(error) for error in validation_errors[:100]], ensure_ascii=False),
            "p_retryable": False, "p_metrics": metrics,
        })
        return

    reports = build_reports(solution)
    assignments: list[dict] = []
    routes_json: dict[str, dict] = {}
    for wid, route in solution.routes.items():
        routes_json[wid] = {
            "worker": asdict(route.worker), "tasks": [_task_json(task) for task in route.tasks],
            "transitions": {task_id: _transition_json(transition) for task_id, transition in route.transitions.items()},
        }
        for task in route.tasks:
            if not task.fixed_worker_id:
                assignments.append({"task_id": task.id, "version": task.version, "worker_id": wid})
        if wid in reports:
            reports[wid]["items"] = [_task_json(task) for task in route.tasks]

    companions = [{
        "rider_worker_id": match.rider_worker_id, "rider_task_id": match.rider_task_id,
        "driver_worker_id": match.driver_worker_id, "driver_task_id": match.driver_task_id,
        "direction": match.direction, "depart_at": _iso(match.depart_at),
        "vehicle_leg_arrive_at": _iso(match.vehicle_leg_arrive_at), "arrive_at": _iso(match.arrive_at),
        "steps": [asdict(step) for step in match.steps],
    } for match in solution.companion_matches]

    plan = {
        "contract": "optimizer_v2_plan_v3_daily_shifts", "physical_feasible": physical_feasible,
        "coverage_complete": coverage_complete, "assignments": assignments, "fixed_task_ids": fixed_task_ids,
        "unassigned": [{"task_id": task_id, "reason": "not_selected_by_optimizer"} for task_id in solution.unassigned_task_ids],
        "unmatched_needs": [], "routes": routes_json, "companion_matches": companions,
        "shift_assignments": [_shift_json(shift) for shift in solution.shift_assignments],
        "work_policy": {
            "global_work_mode": cfg.global_work_mode,
            "shift_start": f"{cfg.shift_start_hour:02d}:{cfg.shift_start_minute:02d}",
            "normal_duration_minutes": cfg.normal_shift_duration_minutes,
            "intensive_duration_minutes": cfg.intensive_shift_duration_minutes,
            "max_effort_duration_minutes": cfg.max_effort_shift_duration_minutes,
        },
        "validator": {"contract": "physical_validator_v2_daily_shifts", "errors": []},
        "solver_status": solution.solver_status, "objective_value": solution.objective_value,
    }
    rows = backend.insert("ai_dispatch_plans", {
        "created_by_telegram_user_id": job["created_by_telegram_user_id"], "writer_epoch": job["writer_epoch"],
        "horizon_start": job["horizon_start"], "horizon_end": job["horizon_end"], "status": "proposal",
        "solver_engine": "optimizer_v2_cp_sat_daily_shifts_v3", "input_snapshot": snapshot,
        "plan": plan, "reports": reports,
    })
    plan_id = rows[0]["id"]
    backend.rpc("complete_optimization_job", {
        "p_job_id": job_id, "p_worker_id": worker_id, "p_result_plan_id": plan_id,
        "p_metrics": metrics, "p_progress": {"stage": "completed", "percent": 100},
    })
