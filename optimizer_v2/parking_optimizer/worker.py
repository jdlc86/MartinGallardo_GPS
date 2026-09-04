from __future__ import annotations

import json
import os
import socket
import time
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx

from .domain import OptimizerConfig, Task, Worker
from .solver import solve
from .reporting import build_reports
from .validator import validate_solution
from .unassigned_audit import audit_summary

_MADRID = ZoneInfo("Europe/Madrid")


class Backend:
    def __init__(self) -> None:
        self.url = os.environ["SUPABASE_URL"].rstrip("/")
        self.key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        self.client = httpx.Client(timeout=30, headers={"apikey": self.key, "Authorization": f"Bearer {self.key}"})

    def rpc(self, name: str, payload: dict):
        res = self.client.post(f"{self.url}/rest/v1/rpc/{name}", json=payload)
        res.raise_for_status()
        if not res.text:
            return None
        return res.json()

    def select(self, table: str, params: dict[str, str]):
        res = self.client.get(f"{self.url}/rest/v1/{table}", params=params)
        res.raise_for_status()
        return res.json()

    def insert(self, table: str, payload: dict):
        res = self.client.post(f"{self.url}/rest/v1/{table}", json=payload, headers={"Prefer": "return=representation"})
        res.raise_for_status()
        return res.json()

    def patch(self, table: str, params: dict[str, str], payload: dict):
        res = self.client.patch(f"{self.url}/rest/v1/{table}", params=params, json=payload)
        res.raise_for_status()


class MatrixMissing(RuntimeError):
    pass


def _parse(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _terminal(value: object) -> str:
    text = str(value or "").upper().replace(" ", "")
    if "4S" in text or "T4" in text or "TERMINAL4" in text:
        return "T4"
    for terminal in ("T3", "T2", "T1"):
        if terminal in text or f"TERMINAL{terminal[1:]}" in text:
            return terminal
    raise ValueError(f"unsupported terminal: {value!r}")


def _band(at: datetime) -> str:
    hour = at.astimezone(_MADRID).hour
    if hour < 6:
        return "MADRUGADA"
    if hour < 10:
        return "PUNTA_MANANA"
    if hour < 16:
        return "VALLE_DIA"
    if hour < 20:
        return "PUNTA_TARDE"
    return "NOCHE"


def _road_minutes(matrix: dict[tuple[str, str, str], dict], origin: str, destination: str, at: datetime, cfg: OptimizerConfig) -> int:
    if origin == destination:
        return 0
    row = matrix.get((origin, destination, _band(at)))
    if not row or not row.get("current_duration_s"):
        raise MatrixMissing(f"route matrix missing: {origin}>{destination}@{_band(at)}")
    base = (int(row["current_duration_s"]) + 59) // 60
    uncertainty = max(cfg.road_uncertainty_min_minutes, int(base * cfg.road_uncertainty_pct + 0.999999))
    return base + uncertainty


def _config(raw: dict) -> OptimizerConfig:
    mode = str(raw.get("global_work_mode", "max_effort"))
    if mode not in ("normal", "intensive", "max_effort"):
        raise ValueError(f"invalid global_work_mode: {mode}")
    back_forward_mode = str(raw.get("back_forward_mode", "fast"))
    if back_forward_mode not in ("fast", "optimal"):
        raise ValueError(f"invalid back_forward_mode: {back_forward_mode}")
    return OptimizerConfig(
        operation_minutes=int(raw.get("operation_minutes", 10)),
        target_early_minutes=int(raw.get("target_early_minutes", 5)),
        road_uncertainty_pct=float(raw.get("road_uncertainty_pct", 0.10)),
        road_uncertainty_min_minutes=int(raw.get("road_uncertainty_min_minutes", 2)),
        terminal_shuttle_access_minutes=int(raw.get("terminal_shuttle_access_minutes", 5)),
        terminal_shuttle_wait_day_minutes=int(raw.get("terminal_shuttle_wait_day_minutes", 5)),
        terminal_shuttle_wait_night_minutes=int(raw.get("terminal_shuttle_wait_night_minutes", 20)),
        terminal_shuttle_day_start_hour=int(raw.get("terminal_shuttle_day_start_hour", 6)),
        terminal_shuttle_day_end_hour=int(raw.get("terminal_shuttle_day_end_hour", 22)),
        max_logistics_passengers=int(raw.get("max_logistics_passengers", 1)),
        global_work_mode=mode,
        shift_start_hour=int(raw.get("shift_start_hour", 6)),
        shift_start_minute=int(raw.get("shift_start_minute", 0)),
        normal_shift_duration_minutes=int(raw.get("normal_shift_duration_minutes", 720)),
        intensive_shift_duration_minutes=int(raw.get("intensive_shift_duration_minutes", 1080)),
        max_effort_shift_duration_minutes=int(raw.get("max_effort_shift_duration_minutes", 1320)),
        normal_rest_minutes=int(raw.get("normal_rest_minutes", 720)),
        intensive_rest_minutes=int(raw.get("intensive_rest_minutes", 360)),
        max_effort_rest_minutes=int(raw.get("max_effort_rest_minutes", 120)),
        normal_shift_cost=int(raw.get("normal_shift_cost", 0)),
        intensive_shift_cost=int(raw.get("intensive_shift_cost", 120)),
        max_effort_shift_cost=int(raw.get("max_effort_shift_cost", 300)),
        company_shuttle_vehicle_count=int(raw.get("company_shuttle_vehicle_count", 1)),
        company_shuttle_passenger_capacity=int(raw.get("company_shuttle_passenger_capacity", 4)),
        company_shuttle_mission_cost=int(raw.get("company_shuttle_mission_cost", 500)),
        back_forward_mode=back_forward_mode,
        back_forward_window_minutes=int(raw.get("back_forward_window_minutes", 1440)),
        back_forward_overlap_minutes=int(raw.get("back_forward_overlap_minutes", 360)),
        back_forward_candidate_step_minutes=int(raw.get("back_forward_candidate_step_minutes", 60)),
        back_forward_max_anchor_candidates=int(raw.get("back_forward_max_anchor_candidates", 12)),
        back_forward_optimal_explore_ratio=float(raw.get("back_forward_optimal_explore_ratio", 0.35)),
        audit_local_window_minutes=int(raw.get("audit_local_window_minutes", 1440)),
        audit_local_time_limit_seconds=float(raw.get("audit_local_time_limit_seconds", 2.0)),
        audit_max_reoptimization_candidates=int(raw.get("audit_max_reoptimization_candidates", 64)),
    )

def _prepare_tasks(raw_tasks: list[dict], matrix: dict, cfg: OptimizerConfig) -> list[Task]:
    tasks: list[Task] = []
    for raw in raw_tasks:
        booking = raw.get("parking_bookings") or {}
        task_type = raw["task_type"]
        terminal = _terminal(booking.get("pickup_terminal") if task_type == "pickup" else booking.get("return_terminal"))
        scheduled = _parse(raw["scheduled_at"])
        target = scheduled - timedelta(minutes=cfg.target_early_minutes)
        worker = raw.get("workers") or None
        fixed_worker_id = str(worker["id"]) if worker else None
        if task_type == "delivery":
            road = _road_minutes(matrix, "PARKING", terminal, target, cfg)
            vehicle_depart = target - timedelta(minutes=road)
            vehicle_arrive = target
            start_at = vehicle_depart
            end_at = scheduled + timedelta(minutes=cfg.operation_minutes)
            start_node, end_node = "PARKING", terminal
        else:
            start_at = target
            vehicle_depart = scheduled + timedelta(minutes=cfg.operation_minutes)
            road = _road_minutes(matrix, terminal, "PARKING", vehicle_depart, cfg)
            vehicle_arrive = vehicle_depart + timedelta(minutes=road)
            end_at = vehicle_arrive
            start_node, end_node = terminal, "PARKING"
        tasks.append(Task(
            id=str(raw["id"]), booking_id=str(raw["booking_id"]), task_type=task_type,
            scheduled_at=scheduled, start_at=start_at, end_at=end_at, start_node=start_node,
            end_node=end_node, terminal=terminal, version=int(raw["version"]),
            vehicle_leg_depart_at=vehicle_depart, vehicle_leg_arrive_at=vehicle_arrive,
            plate=booking.get("vehicle_plate"), customer_name=booking.get("customer_name"),
            fixed_worker_id=fixed_worker_id,
        ))
    return tasks


def _iso(value: datetime | None):
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if value else None


def _task_json(task: Task) -> dict:
    return {
        "id": task.id, "booking_id": task.booking_id, "type": task.task_type,
        "scheduled_at": _iso(task.scheduled_at), "start_at": _iso(task.start_at), "end_at": _iso(task.end_at),
        "start_node": task.start_node, "end_node": task.end_node, "terminal": task.terminal,
        "version": task.version, "vehicle_leg_depart_at": _iso(task.vehicle_leg_depart_at),
        "vehicle_leg_arrive_at": _iso(task.vehicle_leg_arrive_at), "plate": task.plate,
        "customer_name": task.customer_name, "fixed_worker_id": task.fixed_worker_id,
    }


def _transition_json(transition) -> dict:
    return {
        "predecessor_task_id": transition.predecessor_task_id,
        "successor_task_id": transition.successor_task_id,
        "kind": transition.kind,
        "ready_at": _iso(transition.ready_at),
        "arrive_at": _iso(transition.arrive_at),
        "cost_minutes": transition.cost_minutes,
        "steps": [asdict(step) for step in transition.steps],
    }


def _shift_json(shift) -> dict:
    return {
        "worker_id": shift.worker_id,
        "operational_day": shift.operational_day.isoformat(),
        "shift_type": shift.shift_type,
        "start_at": _iso(shift.start_at),
        "end_at": _iso(shift.end_at),
    }


def process_job(backend: Backend, job: dict, worker_id: str) -> None:
    job_id = job["id"]
    started = time.monotonic()
    backend.rpc("heartbeat_optimization_job", {"p_job_id": job_id, "p_worker_id": worker_id, "p_lease_seconds": 900, "p_progress": {"stage": "snapshot", "percent": 5}})
    current = backend.select("optimization_jobs", {"id": f"eq.{job_id}", "select": "status", "limit": "1"})[0]
    if current["status"] == "cancel_requested":
        backend.patch("optimization_jobs", {"id": f"eq.{job_id}", "claimed_by": f"eq.{worker_id}"}, {"status": "cancelled", "finished_at": datetime.now(timezone.utc).isoformat(), "lease_until": None})
        return

    cfg_raw = backend.select("ai_dispatch_config", {"id": "eq.1", "select": "*", "limit": "1"})[0]
    cfg = _config(cfg_raw)
    workers_raw = backend.select("workers", {"active": "eq.true", "role": "eq.operator", "select": "id,telegram_user_id,full_name", "order": "full_name.asc"})
    workers = [Worker(str(w["id"]), w["full_name"], w.get("telegram_user_id")) for w in workers_raw]
    if not workers:
        raise RuntimeError("no_active_workers")

    matrix_rows = backend.select("ai_dispatch_route_matrix", {"origin": "neq.T4S", "destination": "neq.T4S", "select": "origin,destination,time_band,current_duration_s,distance_m,is_anomaly,fetched_at"})
    matrix = {(r["origin"], r["destination"], r["time_band"]): r for r in matrix_rows}
    raw_tasks = backend.select("reservation_tasks", {
        "status": "in.(unassigned,assigned)", "scheduled_at": f"gte.{job['horizon_start']}",
        "and": f"(scheduled_at.lt.{job['horizon_end']})",
        "select": "id,booking_id,task_type,scheduled_at,assigned_worker_id,status,version,parking_bookings!inner(id,pickup_terminal,return_terminal,vehicle_plate,customer_name,deleted_at),workers(id,telegram_user_id,full_name)",
        "parking_bookings.deleted_at": "is.null", "order": "scheduled_at.asc",
    })
    tasks = _prepare_tasks(raw_tasks, matrix, cfg)

    snapshot = {
        "contract": "optimizer_v2_snapshot_v2_shifts",
        "task_versions": {task.id: task.version for task in tasks},
        "active_worker_ids": [worker.id for worker in workers],
        "config": asdict(cfg),
        "route_matrix_fetched_at": max((r.get("fetched_at") or "" for r in matrix_rows), default=None),
        "task_count": len(tasks),
    }
    backend.patch("optimization_jobs", {"id": f"eq.{job_id}", "claimed_by": f"eq.{worker_id}"}, {"input_snapshot": snapshot, "progress": {"stage": "cp_sat", "percent": 20}, "updated_at": datetime.now(timezone.utc).isoformat()})

    solve_limit_seconds = float(os.getenv("OPTIMIZER_TIME_LIMIT_SECONDS", "120"))
    solution = solve(tasks, workers, cfg, time_limit_seconds=solve_limit_seconds)
    validation_errors = validate_solution(solution, cfg)
    solve_seconds = time.monotonic() - started
    shift_counts = {"normal": 0, "intensive": 0, "max_effort": 0}
    for shift in solution.shift_assignments:
        shift_counts[shift.shift_type] += 1
    unassigned_summary = audit_summary(solution.unassigned_audit)
    metrics = {
        "task_count": len(tasks), "assigned_count": len(tasks) - len(solution.unassigned_task_ids),
        "unassigned_count": len(solution.unassigned_task_ids), "companion_count": len(solution.companion_matches),
        "shift_counts": shift_counts, "global_work_mode": cfg.global_work_mode,
        "solver_status": solution.solver_status, "objective_value": solution.objective_value,
        "validation_error_count": len(validation_errors), "elapsed_seconds": round(solve_seconds, 3),
        "unassigned_audit": unassigned_summary,
    }
    if validation_errors:
        backend.rpc("fail_optimization_job", {"p_job_id": job_id, "p_worker_id": worker_id, "p_error_code": "physical_validation_failed", "p_error_detail": json.dumps([asdict(e) for e in validation_errors[:100]], ensure_ascii=False), "p_retryable": False, "p_metrics": metrics})
        return

    reports = build_reports(solution)
    routes_json = {}
    assignments = []
    for wid, route in solution.routes.items():
        routes_json[wid] = {"worker": asdict(route.worker), "tasks": [_task_json(task) for task in route.tasks], "transitions": {task_id: _transition_json(t) for task_id, t in route.transitions.items()}}
        for task in route.tasks:
            if not task.fixed_worker_id:
                assignments.append({"task_id": task.id, "version": task.version, "worker_id": wid})
        if wid in reports:
            reports[wid]["items"] = [_task_json(task) for task in route.tasks]
    companions = [{
        "rider_worker_id": m.rider_worker_id, "rider_task_id": m.rider_task_id,
        "driver_worker_id": m.driver_worker_id, "driver_task_id": m.driver_task_id,
        "direction": m.direction, "depart_at": _iso(m.depart_at),
        "vehicle_leg_arrive_at": _iso(m.vehicle_leg_arrive_at), "arrive_at": _iso(m.arrive_at),
        "steps": [asdict(step) for step in m.steps],
    } for m in solution.companion_matches]

    plan = {
        "contract": "optimizer_v2_plan_v2_shifts", "physical_feasible": True,
        "assignments": assignments,
        "unassigned": solution.unassigned_audit,
        "routes": routes_json, "companion_matches": companions,
        "company_shuttle_missions": [{
            "vehicle_index": mission.vehicle_index,
            "mission_id": mission.mission_id,
            "depart_parking_at": _iso(mission.depart_parking_at),
            "return_parking_at": _iso(mission.return_parking_at),
            "stops": list(mission.stops),
            "rider_worker_ids": list(mission.rider_worker_ids),
            "rider_task_ids": list(mission.rider_task_ids),
        } for mission in solution.company_shuttle_missions],
        "shift_assignments": [_shift_json(shift) for shift in solution.shift_assignments],
        "work_policy": {"global_work_mode": cfg.global_work_mode, "shift_start": f"{cfg.shift_start_hour:02d}:{cfg.shift_start_minute:02d}"},
        "validator": {"contract": "physical_validator_v2_shifts", "errors": []},
        "unassigned_audit_summary": unassigned_summary,
        "solver_status": solution.solver_status, "objective_value": solution.objective_value,
    }
    plan_rows = backend.insert("ai_dispatch_plans", {
        "created_by_telegram_user_id": job["created_by_telegram_user_id"], "writer_epoch": job["writer_epoch"],
        "horizon_start": job["horizon_start"], "horizon_end": job["horizon_end"], "status": "proposal",
        "solver_engine": "optimizer_v2_back_forward_v1", "input_snapshot": snapshot, "plan": plan, "reports": reports,
    })
    plan_id = plan_rows[0]["id"]
    backend.rpc("complete_optimization_job", {"p_job_id": job_id, "p_worker_id": worker_id, "p_result_plan_id": plan_id, "p_metrics": metrics, "p_progress": {"stage": "completed", "percent": 100}})


def run_forever() -> None:
    backend = Backend()
    worker_id = os.getenv("OPTIMIZER_WORKER_ID") or f"{socket.gethostname()}:{os.getpid()}"
    idle_seconds = float(os.getenv("OPTIMIZER_IDLE_SECONDS", "2"))
    while True:
        claimed = backend.rpc("claim_next_optimization_job", {"p_worker_id": worker_id, "p_lease_seconds": 900})
        if not claimed or not claimed.get("id"):
            time.sleep(idle_seconds)
            continue
        try:
            process_job(backend, claimed, worker_id)
        except Exception as exc:
            try:
                backend.rpc("fail_optimization_job", {"p_job_id": claimed["id"], "p_worker_id": worker_id, "p_error_code": type(exc).__name__, "p_error_detail": str(exc), "p_retryable": isinstance(exc, (httpx.TimeoutException, httpx.NetworkError)), "p_metrics": {}})
            finally:
                print(f"job {claimed['id']} failed: {exc}", flush=True)


if __name__ == "__main__":
    run_forever()
