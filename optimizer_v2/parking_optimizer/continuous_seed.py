from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable

from .daily_solver import _ordered_tasks
from .domain import OptimizerConfig, ShiftAssignment, Solution, Task, Transition, Worker, WorkerRoute
from .shifts import allowed_shift_types, operational_day, shift_duration_minutes, shift_rest_minutes
from .transitions import build_transition


@dataclass
class _State:
    worker: Worker
    current_tasks: list[Task] = field(default_factory=list)
    blocks: list[tuple[str, datetime, datetime]] = field(default_factory=list)
    block_start: datetime | None = None
    block_type: str | None = None
    eligible_types: tuple[str, ...] = ()
    last_task: Task | None = None


def _types_by_capacity(cfg: OptimizerConfig) -> list[str]:
    return sorted(
        allowed_shift_types(cfg),
        key=lambda st: (shift_duration_minutes(st, cfg), -shift_rest_minutes(st, cfg)),
        reverse=True,
    )


def build_continuous_seed(
    tasks: Iterable[Task],
    workers: Iterable[Worker],
    cfg: OptimizerConfig,
    *,
    preferred_worker_by_task: dict[str, str] | None = None,
) -> Solution:
    """Fast deterministic 24/7 incumbent and continuity stitcher.

    It never invents a discontinuity: a worker either continues through a
    physically feasible transition or opens a new shift after the required
    policy rest. Window solvers may suggest preferred workers, but those
    preferences never override feasibility.
    """
    tasks = _ordered_tasks(tasks)
    workers = list(workers)
    routes = {w.id: WorkerRoute(w) for w in workers}
    states = {w.id: _State(w) for w in workers}
    preferred_types = _types_by_capacity(cfg)
    preferred_worker_by_task = preferred_worker_by_task or {}
    assigned: set[str] = set()
    shifts: list[ShiftAssignment] = []

    for task in tasks:
        candidates = [
            w for w in workers
            if (task.fixed_worker_id == w.id) or (task.fixed_worker_id is None and w.auto_assignable)
        ]
        best = None
        for worker in candidates:
            s = states[worker.id]
            if s.last_task is None:
                option = (1, 0, worker.id, "start", preferred_types[0], tuple(preferred_types))
            else:
                prev = s.last_task
                if task.start_at < prev.end_at:
                    continue
                tr = build_transition(prev, task, cfg)
                span = int((task.end_at - s.block_start).total_seconds() // 60) if s.block_start else 10**9
                continuation_types = [
                    st for st in s.eligible_types
                    if span <= shift_duration_minutes(st, cfg)
                ]
                if tr.feasible and not tr.requires_companion and continuation_types:
                    st = continuation_types[0]
                    option = (0, tr.cost_minutes, worker.id, "continue", st, tuple(continuation_types))
                else:
                    gap = int((task.start_at - prev.end_at).total_seconds() // 60)
                    restart_types = [
                        st for st in preferred_types
                        if gap >= shift_rest_minutes(st, cfg)
                    ]
                    if not restart_types:
                        continue
                    st = restart_types[0]
                    option = (1, gap, worker.id, "restart", st, tuple(restart_types))

            preference_penalty = 0 if preferred_worker_by_task.get(task.id) == worker.id else 1
            rank = (preference_penalty, *option[:3])
            if best is None or rank < best[0]:
                best = (rank, option, worker)

        if best is None:
            continue

        _, option, worker = best
        mode, st, eligible = option[3], option[4], option[5]
        s = states[worker.id]

        if mode in {"start", "restart"}:
            if s.current_tasks:
                end_at = s.current_tasks[-1].end_at
                shifts.append(
                    ShiftAssignment(
                        worker.id,
                        operational_day(s.block_start, cfg),
                        s.block_type,
                        s.block_start,
                        end_at,
                    )
                )
            predecessor = s.last_task
            routes[worker.id].transitions[task.id] = Transition(
                predecessor.id if predecessor else None,
                task.id,
                "shift_start",
                True,
                predecessor.end_at if predecessor else None,
                task.start_at,
                0,
                reason=f"new_shift:{st}",
            )
            s.current_tasks = [task]
            s.block_start = task.start_at
            s.block_type = st
            s.eligible_types = eligible
        else:
            routes[worker.id].transitions[task.id] = build_transition(s.last_task, task, cfg)
            s.current_tasks.append(task)
            s.block_type = st
            s.eligible_types = eligible

        s.last_task = task
        routes[worker.id].tasks.append(task)
        assigned.add(task.id)

    for worker in workers:
        s = states[worker.id]
        if s.current_tasks:
            shifts.append(
                ShiftAssignment(
                    worker.id,
                    operational_day(s.block_start, cfg),
                    s.block_type,
                    s.block_start,
                    s.current_tasks[-1].end_at,
                )
            )

    return Solution(
        routes=routes,
        unassigned_task_ids=[t.id for t in tasks if t.id not in assigned],
        shift_assignments=sorted(shifts, key=lambda sh: (sh.worker_id, sh.start_at)),
        solver_status="FEASIBLE",
        coverage_count=len(assigned),
        operational_day_count=len({operational_day(t.start_at, cfg) for t in tasks}),
        day_diagnostics=[{
            "mode": "continuous_seed",
            "coverage_count": len(assigned),
            "task_count": len(tasks),
        }],
    )
