from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from .domain import OptimizerConfig, ShiftType, Task

_MADRID = ZoneInfo("Europe/Madrid")
_SHIFT_ORDER: tuple[ShiftType, ...] = ("normal", "intensive", "max_effort")


def operational_day(at: datetime, cfg: OptimizerConfig) -> date:
    """Return the business day anchored at the configured shift start.

    With the default 06:00 start, a task at 03:00 on Tuesday belongs to
    Monday's operational day.
    """
    local = at.astimezone(_MADRID)
    anchor = time(cfg.shift_start_hour, cfg.shift_start_minute)
    return local.date() if local.timetz().replace(tzinfo=None) >= anchor else local.date() - timedelta(days=1)


def shift_window(day: date, shift_type: ShiftType, cfg: OptimizerConfig) -> tuple[datetime, datetime]:
    start = datetime.combine(day, time(cfg.shift_start_hour, cfg.shift_start_minute), _MADRID)
    durations = {
        "normal": cfg.normal_shift_duration_minutes,
        "intensive": cfg.intensive_shift_duration_minutes,
        "max_effort": cfg.max_effort_shift_duration_minutes,
    }
    return start, start + timedelta(minutes=durations[shift_type])


def allowed_shift_types(cfg: OptimizerConfig) -> tuple[ShiftType, ...]:
    rank = _SHIFT_ORDER.index(cfg.global_work_mode)
    return _SHIFT_ORDER[: rank + 1]


def eligible_shift_types(task: Task, cfg: OptimizerConfig) -> tuple[ShiftType, ...]:
    day = operational_day(task.start_at, cfg)
    result: list[ShiftType] = []
    for shift_type in allowed_shift_types(cfg):
        start, end = shift_window(day, shift_type, cfg)
        if task.start_at >= start and task.end_at <= end:
            result.append(shift_type)
    return tuple(result)


def shift_cost(shift_type: ShiftType, cfg: OptimizerConfig) -> int:
    return {
        "normal": cfg.normal_shift_cost,
        "intensive": cfg.intensive_shift_cost,
        "max_effort": cfg.max_effort_shift_cost,
    }[shift_type]
