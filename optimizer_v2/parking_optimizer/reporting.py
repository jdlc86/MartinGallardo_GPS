from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

from .domain import CompanionMatch, Solution, Task, WorkerRoute

_MADRID = ZoneInfo("Europe/Madrid")
_DAYS = ("lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo")
_MONTHS = ("enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre")


def _local(value: datetime) -> datetime:
    return value.astimezone(_MADRID)


def _hm(value: datetime) -> str:
    return _local(value).strftime("%H:%M")


def _day_key(value: datetime) -> str:
    return _local(value).strftime("%Y-%m-%d")


def _day_label(value: datetime) -> str:
    local = _local(value)
    return f"{_DAYS[local.weekday()].capitalize()}, {local.day} de {_MONTHS[local.month - 1]}"


def _task_line(task: Task) -> str:
    kind = "ENTREGA" if task.task_type == "delivery" else "RECOGIDA"
    return f"{_hm(task.scheduled_at)} · {kind} · {task.terminal} · {task.plate or '—'} · {task.customer_name or '—'}"


def _render_steps(lines: list[str], start_at: datetime, steps) -> datetime:
    current = start_at
    for step in steps:
        lines.append(f"🚌 {_hm(current)} · Lanzadera {step.origin} → {step.destination} · {step.minutes} min")
        from datetime import timedelta
        current = current + timedelta(minutes=step.minutes)
        lines.append(f"{_hm(current)} · Llegada prevista a {step.destination}")
    return current


def _render_transition(
    lines: list[str],
    route: WorkerRoute,
    task: Task,
    rider_matches: dict[tuple[str, str], CompanionMatch],
    worker_names: dict[str, str],
) -> None:
    transition = route.transitions.get(task.id)
    if transition is None or transition.kind in ("shift_start", "shift_reset", "same_location"):
        return
    if transition.kind == "terminal_transfer" and transition.ready_at:
        _render_steps(lines, transition.ready_at, transition.steps)
        return
    if transition.kind not in ("ride_out", "ride_in"):
        return

    match = rider_matches.get((route.worker.id, task.id))
    if match is None:
        # This should never be rendered for an accepted plan because the independent
        # validator rejects it. Keep the diagnostic explicit if a corrupted plan is inspected.
        lines.append("⚠️ Traslado de operario sin acompañante válido")
        return

    driver = worker_names.get(match.driver_worker_id, "otro operario")
    if match.direction == "out":
        lines.append(f"👥 {_hm(match.depart_at)} · Ir como acompañante con {driver} · Parking → aeropuerto")
        if match.steps:
            _render_steps(lines, match.vehicle_leg_arrive_at, match.steps)
    else:
        if match.steps and transition.ready_at:
            _render_steps(lines, transition.ready_at, match.steps)
        lines.append(f"👥 {_hm(match.depart_at)} · Regresar al Parking como acompañante con {driver}")


def build_reports(solution: Solution) -> dict[str, dict]:
    """Render UI reports exclusively from the canonical solved structure."""
    worker_names = {worker_id: route.worker.full_name for worker_id, route in solution.routes.items()}
    rider_matches = {(m.rider_worker_id, m.rider_task_id): m for m in solution.companion_matches}
    passengers_by_driver: dict[tuple[str, str], list[CompanionMatch]] = defaultdict(list)
    for match in solution.companion_matches:
        passengers_by_driver[(match.driver_worker_id, match.driver_task_id)].append(match)

    reports: dict[str, dict] = {}
    for worker_id, route in solution.routes.items():
        if not route.tasks:
            continue
        lines = [f"📅 Plan operativo · {route.worker.full_name}"]
        current_day = None
        items = []
        for task in route.tasks:
            day_key = _day_key(task.scheduled_at)
            if day_key != current_day:
                current_day = day_key
                lines.append(f"\n🗓️ {_day_label(task.scheduled_at)}")

            _render_transition(lines, route, task, rider_matches, worker_names)
            passengers = passengers_by_driver.get((worker_id, task.id), [])
            if task.task_type == "delivery":
                lines.append(f"↗ {_hm(task.vehicle_leg_depart_at)} · Salir del Parking · {task.plate or '—'} → {task.terminal}")
                for passenger in passengers:
                    lines.append(f"👥 Llevar a {worker_names.get(passenger.rider_worker_id, 'otro operario')} como acompañante")
                lines.append(_task_line(task))
                lines.append(f"{_hm(task.end_at)} · Fin operación en {task.terminal}")
            else:
                lines.append(_task_line(task))
                for passenger in passengers:
                    lines.append(f"👥 Antes de salir, recoger a {worker_names.get(passenger.rider_worker_id, 'otro operario')}; regresa contigo al Parking")
                lines.append(f"↘ {_hm(task.vehicle_leg_depart_at)} · Salir hacia Parking con el vehículo")
                lines.append(f"{_hm(task.vehicle_leg_arrive_at)} · Llegada prevista al Parking")
            if task.fixed_worker_id:
                lines.append("🔒 Asignación manual preestablecida")
            items.append(task)

        reports[worker_id] = {
            "worker": {
                "id": route.worker.id,
                "full_name": route.worker.full_name,
                "telegram_user_id": route.worker.telegram_user_id,
                "role": "operator",
            },
            "items": items,
            "text": "\n".join(lines),
        }
    return reports
