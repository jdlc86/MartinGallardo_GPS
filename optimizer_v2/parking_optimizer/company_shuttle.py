from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from .domain import CompanyShuttleMission, Node, OptimizerConfig, Task


@dataclass(frozen=True, slots=True)
class ShuttleRequest:
    worker_id: str
    successor_task_id: str
    origin: Node
    destination: Node
    ready_at: datetime
    latest_arrival: datetime


def _observed_leg_minutes(tasks: list[Task], origin: Node, destination: Node, at: datetime) -> int | None:
    """Estimate a rescue-car road leg from the same road legs already snapshotted for customer cars.

    We deliberately do not invent a second travel-time source. Prefer same-direction observations
    near the requested time; if a direction is absent (e.g. an all-delivery stress day), use the
    reverse road observation for the same terminal as a conservative operational approximation.
    """
    candidates: list[tuple[float, int]] = []
    reverse: list[tuple[float, int]] = []
    for task in tasks:
        leg_origin = task.start_node if task.task_type == "delivery" else task.terminal
        leg_destination = task.terminal if task.task_type == "delivery" else "PARKING"
        minutes = max(1, int((task.vehicle_leg_arrive_at - task.vehicle_leg_depart_at).total_seconds() // 60))
        distance = abs((task.vehicle_leg_depart_at - at).total_seconds())
        if leg_origin == origin and leg_destination == destination:
            candidates.append((distance, minutes))
        elif leg_origin == destination and leg_destination == origin:
            reverse.append((distance, minutes))
    pool = candidates or reverse
    return min(pool)[1] if pool else None


def request_mission_window(request: ShuttleRequest, tasks: list[Task]) -> tuple[datetime, datetime] | None:
    """Return PARKING departure/return window for one physically closed rescue mission.

    The company car is never left at the airport. For a PARKING->terminal passenger movement the
    car drives out and immediately returns. For terminal->PARKING it first deadheads from PARKING,
    picks the operator up, and returns. Terminal->terminal is PARKING->origin->destination->PARKING.
    """
    if request.origin == request.destination:
        return request.ready_at, request.ready_at

    if request.origin == "PARKING":
        out_m = _observed_leg_minutes(tasks, "PARKING", request.destination, request.ready_at)
        back_m = _observed_leg_minutes(tasks, request.destination, "PARKING", request.ready_at)
        if out_m is None or back_m is None:
            return None
        depart = request.ready_at
        passenger_arrival = depart + timedelta(minutes=out_m)
        if passenger_arrival > request.latest_arrival:
            return None
        return depart, passenger_arrival + timedelta(minutes=back_m)

    if request.destination == "PARKING":
        deadhead_m = _observed_leg_minutes(tasks, "PARKING", request.origin, request.ready_at)
        back_m = _observed_leg_minutes(tasks, request.origin, "PARKING", request.ready_at)
        if deadhead_m is None or back_m is None:
            return None
        # Leave PARKING early enough to reach the waiting operator at ready_at.
        depart = request.ready_at - timedelta(minutes=deadhead_m)
        passenger_arrival = request.ready_at + timedelta(minutes=back_m)
        if passenger_arrival > request.latest_arrival:
            return None
        return depart, passenger_arrival

    to_origin = _observed_leg_minutes(tasks, "PARKING", request.origin, request.ready_at)
    between = _observed_leg_minutes(tasks, request.origin, request.destination, request.ready_at)
    to_parking = _observed_leg_minutes(tasks, request.destination, "PARKING", request.ready_at)
    if None in (to_origin, between, to_parking):
        return None
    depart = request.ready_at - timedelta(minutes=int(to_origin))
    passenger_arrival = request.ready_at + timedelta(minutes=int(between))
    if passenger_arrival > request.latest_arrival:
        return None
    return depart, passenger_arrival + timedelta(minutes=int(to_parking))


def assign_vehicle(missions: list[CompanyShuttleMission], start: datetime, end: datetime, cfg: OptimizerConfig) -> int | None:
    """Return the first configured vehicle whose closed missions do not overlap."""
    for vehicle_index in range(cfg.company_shuttle_vehicle_count):
        if all(m.vehicle_index != vehicle_index or end <= m.depart_parking_at or start >= m.return_parking_at for m in missions):
            return vehicle_index
    return None
