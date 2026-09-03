from __future__ import annotations

from datetime import timedelta
from zoneinfo import ZoneInfo

from .domain import OptimizerConfig, Task, TransferStep, Transition

_MADRID = ZoneInfo("Europe/Madrid")

_DIRECT = {
    ("T1", "T2"): 2,
    ("T1", "T4"): 10,
    ("T2", "T1"): 5,
    ("T2", "T4"): 8,
    ("T3", "T2"): 2,
    ("T3", "T1"): 7,
    ("T4", "T3"): 8,
    ("T4", "T2"): 10,
    ("T4", "T1"): 15,
}


def _wait_minutes(at, cfg: OptimizerConfig) -> int:
    h = at.astimezone(_MADRID).hour
    inside = cfg.terminal_shuttle_day_start_hour <= h < cfg.terminal_shuttle_day_end_hour
    return cfg.terminal_shuttle_wait_day_minutes if inside else cfg.terminal_shuttle_wait_night_minutes


def terminal_transfer(origin: str, destination: str, ready_at, cfg: OptimizerConfig):
    if origin == destination:
        return 0, ()
    ride = _DIRECT.get((origin, destination))
    if ride is None:
        return None
    wait = _wait_minutes(ready_at, cfg)
    total = cfg.terminal_shuttle_access_minutes + wait + ride
    return total, (TransferStep("shuttle", origin, destination, total),)


def build_transition(previous: Task | None, current: Task, cfg: OptimizerConfig) -> Transition:
    if previous is None:
        return Transition(None, current.id, "shift_start", True, None, current.start_at)

    ready = previous.end_at
    if current.start_at < ready:
        return Transition(previous.id, current.id, "same_location", False, ready, None, reason="time_overlap")

    gap_minutes = int((current.start_at - ready).total_seconds() // 60)
    if gap_minutes >= cfg.operator_shift_reset_minutes:
        return Transition(previous.id, current.id, "shift_reset", True, ready, current.start_at)

    if previous.end_node == current.start_node:
        return Transition(previous.id, current.id, "same_location", True, ready, ready)

    if previous.end_node != "PARKING" and current.start_node != "PARKING":
        transfer = terminal_transfer(previous.end_node, current.start_node, ready, cfg)
        if transfer is None:
            return Transition(previous.id, current.id, "terminal_transfer", False, ready, None, reason="unsupported_terminal_transfer")
        minutes, steps = transfer
        arrive = ready + timedelta(minutes=minutes)
        return Transition(
            previous.id,
            current.id,
            "terminal_transfer",
            arrive <= current.start_at,
            ready,
            arrive,
            cost_minutes=minutes,
            reason=None if arrive <= current.start_at else "terminal_transfer_too_late",
            steps=steps,
        )

    if previous.end_node == "PARKING" and current.start_node != "PARKING":
        return Transition(
            previous.id,
            current.id,
            "ride_out",
            True,
            ready,
            current.start_at,
            cost_minutes=100,
            requires_companion=True,
            direction="out",
        )

    if previous.end_node != "PARKING" and current.start_node == "PARKING":
        return Transition(
            previous.id,
            current.id,
            "ride_in",
            True,
            ready,
            current.start_at,
            cost_minutes=100,
            requires_companion=True,
            direction="in",
        )

    return Transition(previous.id, current.id, "same_location", True, ready, ready)
