from __future__ import annotations

from datetime import timedelta
from zoneinfo import ZoneInfo

from .domain import OptimizerConfig, Task, TransferStep, Transition

_MADRID = ZoneInfo("Europe/Madrid")
_TERMINALS = ("T1", "T2", "T3", "T4")
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
    if origin not in _TERMINALS or destination not in _TERMINALS:
        return None

    best: tuple[int, tuple[TransferStep, ...]] | None = None

    def visit(node: str, at, visited: frozenset[str], elapsed: int, steps: tuple[TransferStep, ...]):
        nonlocal best
        if best and elapsed >= best[0]:
            return
        if node == destination:
            best = (elapsed, steps)
            return
        for nxt in _TERMINALS:
            ride = _DIRECT.get((node, nxt))
            if ride is None or nxt in visited:
                continue
            access = cfg.terminal_shuttle_access_minutes if not steps else 0
            wait = _wait_minutes(at, cfg)
            leg_minutes = access + wait + ride
            step = TransferStep("shuttle", node, nxt, leg_minutes)
            visit(
                nxt,
                at + timedelta(minutes=leg_minutes),
                visited | frozenset((nxt,)),
                elapsed + leg_minutes,
                steps + (step,),
            )

    visit(origin, ready_at, frozenset((origin,)), 0, ())
    return best


def build_transition(previous: Task | None, current: Task, cfg: OptimizerConfig) -> Transition:
    """Build a physical transition inside one operational shift.

    A long idle gap never grants repositioning. Repositioning freedom exists only
    at an explicit shift start, represented by previous=None and controlled by
    the shift model in CP-SAT.
    """
    if previous is None:
        return Transition(None, current.id, "shift_start", True, None, current.start_at)

    ready = previous.end_at
    if current.start_at < ready:
        return Transition(previous.id, current.id, "same_location", False, ready, None, reason="time_overlap")

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
