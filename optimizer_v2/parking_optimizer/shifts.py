from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from .domain import OptimizerConfig, ShiftType, Task

_MADRID = ZoneInfo("Europe/Madrid")
_SHIFT_ORDER: tuple[ShiftType, ...] = ("normal", "intensive", "max_effort")


def operational_day(at: datetime, cfg: OptimizerConfig) -> date:
    """Legacy/reporting business-day label anchored at configured shift start.

    The continuous workforce solver no longer uses this as a hard optimization
    boundary. It remains useful for reports and backward-compatible artifacts.
    """
    local = at.astimezone(_MADRID)
    anchor = time(cfg.shift_start_hour, cfg.shift_start_minute)
    return local.date() if local.timetz().replace(tzinfo=None) >= anchor else local.date() - timedelta(days=1)


def shift_window(day: date, shift_type: ShiftType, cfg: OptimizerConfig) -> tuple[datetime, datetime]:
    """Legacy canonical window used only by the legacy daily solver."""
    start = datetime.combine(day, time(cfg.shift_start_hour, cfg.shift_start_minute), _MADRID)
    return start, start + timedelta(minutes=shift_duration_minutes(shift_type, cfg))


def allowed_shift_types(cfg: OptimizerConfig) -> tuple[ShiftType, ...]:
    rank = _SHIFT_ORDER.index(cfg.global_work_mode)
    return _SHIFT_ORDER[: rank + 1]


def shift_duration_minutes(shift_type: ShiftType, cfg: OptimizerConfig) -> int:
    return {
        "normal": cfg.normal_shift_duration_minutes,
        "intensive": cfg.intensive_shift_duration_minutes,
        "max_effort": cfg.max_effort_shift_duration_minutes,
    }[shift_type]


def shift_rest_minutes(shift_type: ShiftType, cfg: OptimizerConfig) -> int:
    """Minimum rest before a newly-started shift of this type.

    With global max_effort the solver may choose 12h/6h/2h rest by choosing
    normal/intensive/max_effort for the new block. With a stricter global mode,
    only the corresponding prefix of policies is available.
    """
    return {
        "normal": cfg.normal_rest_minutes,
        "intensive": cfg.intensive_rest_minutes,
        "max_effort": cfg.max_effort_rest_minutes,
    }[shift_type]


def eligible_shift_types(task: Task, cfg: OptimizerConfig) -> tuple[ShiftType, ...]:
    """Legacy daily-solver helper.

    In the continuous solver every task can start a shift at its own start time,
    so eligibility is controlled by block duration instead of a fixed 06:00
    calendar window.
    """
    day = operational_day(task.start_at, cfg)
    result: list[ShiftType] = []
    for shift_type in allowed_shift_types(cfg):
        start, end = shift_window(day, shift_type, cfg)
        if task.start_at >= start and task.end_at <= end:
            result.append(shift_type)
    return tuple(result)


def flexible_task_shift_types(task: Task, cfg: OptimizerConfig) -> tuple[ShiftType, ...]:
    """Shift types capable of containing the task when the block starts at task.start_at."""
    task_minutes = max(0, int((task.end_at - task.start_at).total_seconds() // 60))
    return tuple(st for st in allowed_shift_types(cfg) if task_minutes <= shift_duration_minutes(st, cfg))


def shift_cost(shift_type: ShiftType, cfg: OptimizerConfig) -> int:
    return {
        "normal": cfg.normal_shift_cost,
        "intensive": cfg.intensive_shift_cost,
        "max_effort": cfg.max_effort_shift_cost,
    }[shift_type]
