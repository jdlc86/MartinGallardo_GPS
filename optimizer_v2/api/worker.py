from __future__ import annotations

import os
import socket
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, Header, HTTPException

from parking_optimizer.job_processor import process_job
from parking_optimizer.worker import Backend

app = FastAPI()


def _authorize(authorization: str | None) -> None:
    secret = os.environ.get("CRON_SECRET")
    if not secret:
        raise HTTPException(status_code=503, detail="worker_not_configured")
    if authorization != f"Bearer {secret}":
        raise HTTPException(status_code=401, detail="unauthorized")


def _run_one() -> dict:
    backend = Backend()
    worker_id = os.getenv("OPTIMIZER_WORKER_ID") or f"vercel:{socket.gethostname()}"
    claimed = backend.rpc(
        "claim_next_optimization_job",
        {"p_worker_id": worker_id, "p_lease_seconds": 900},
    )
    if not claimed or not claimed.get("id"):
        return {"ok": True, "claimed": False, "at": datetime.now(timezone.utc).isoformat()}

    try:
        process_job(backend, claimed, worker_id)
        return {"ok": True, "claimed": True, "job_id": claimed["id"]}
    except Exception as exc:
        try:
            backend.rpc(
                "fail_optimization_job",
                {
                    "p_job_id": claimed["id"],
                    "p_worker_id": worker_id,
                    "p_error_code": type(exc).__name__,
                    "p_error_detail": str(exc),
                    "p_retryable": isinstance(exc, (httpx.TimeoutException, httpx.NetworkError)),
                    "p_metrics": {},
                },
            )
        finally:
            raise


@app.get("/api/worker")
def cron_worker(authorization: str | None = Header(default=None)):
    _authorize(authorization)
    return _run_one()


@app.post("/api/worker")
def manual_worker(authorization: str | None = Header(default=None)):
    _authorize(authorization)
    return _run_one()
