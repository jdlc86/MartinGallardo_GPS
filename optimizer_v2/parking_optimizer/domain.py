from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Literal

Node = Literal["PARKING", "T1", "T2", "T3", "T4"]
TaskType = Literal["pickup", "delivery"]
ShiftType = Literal["normal", "intensive", "max_effort"]
MovementKind = Literal[
    "shift_start",
    "same_location",
    "terminal_transfer",
    "ride_out",
    "ride_in",
]


@dataclass(frozen=True, slots=True)
class Worker:
    id: str
    full_name: str
    telegram_user_id: int | None = None


@dataclass(frozen=True, slots=True)
class Task:
    id: str
    booking_id: str
    task_type: TaskType
    scheduled_at: datetime
    start_at: datetime
    end_at: datetime
    start_node: Node
    end_node: Node
    terminal: Node
    version: int
    vehicle_leg_depart_at: datetime
    vehicle_leg_arrive_at: datetime
    plate: str | None = None
    customer_name: str | None = None
    fixed_worker_id: str | None = None

    @property
    def duration_seconds(self) -> int:
        return max(0, int((self.end_at - self.start_at).total_seconds()))


@dataclass(frozen=True, slots=True)
class TransferStep:
    mode: str
    origin: Node
    destination: Node
    minutes: int


@dataclass(frozen=True, slots=True)
class Transition:
    predecessor_task_id: str | None
    successor_task_id: str
    kind: MovementKind
    feasible: bool
    ready_at: datetime | None
    arrive_at: datetime | None
    cost_minutes: int = 0
    reason: str | None = None
    steps: tuple[TransferStep, ...] = ()
    requires_companion: bool = False
    direction: Literal["out", "in"] | None = None


@dataclass(frozen=True, slots=True)
class CompanionSeat:
    driver_task_id: str
    driver_worker_id: str
    direction: Literal["out", "in"]
    origin: Node
    destination: Node
    depart_at: datetime
    arrive_at: datetime
    capacity: int


@dataclass(frozen=True, slots=True)
class CompanionMatch:
    rider_worker_id: str
    rider_task_id: str
    driver_worker_id: str
    driver_task_id: str
    direction: Literal["out", "in"]
    depart_at: datetime
    vehicle_leg_arrive_at: datetime
    arrive_at: datetime
    steps: tuple[TransferStep, ...] = ()


@dataclass(frozen=True, slots=True)
class ShiftAssignment:
    worker_id: str
    operational_day: date
    shift_type: ShiftType
    start_at: datetime
    end_at: datetime


@dataclass(slots=True)
class WorkerRoute:
    worker: Worker
    tasks: list[Task] = field(default_factory=list)
    transitions: dict[str, Transition] = field(default_factory=dict)


@dataclass(slots=True)
class Solution:
    routes: dict[str, WorkerRoute]
    unassigned_task_ids: list[str]
    companion_matches: list[CompanionMatch] = field(default_factory=list)
    shift_assignments: list[ShiftAssignment] = field(default_factory=list)
    objective_value: int | None = None
    solver_status: str = "UNKNOWN"
    coverage_count: int = 0
    coverage_best_bound: float | None = None
    coverage_relative_gap: float | None = None
    operational_day_count: int = 0


@dataclass(frozen=True, slots=True)
class OptimizerConfig:
    operation_minutes: int = 10
    target_early_minutes: int = 5
    road_uncertainty_pct: float = 0.10
    road_uncertainty_min_minutes: int = 2
    terminal_shuttle_access_minutes: int = 5
    terminal_shuttle_wait_day_minutes: int = 5
    terminal_shuttle_wait_night_minutes: int = 20
    terminal_shuttle_day_start_hour: int = 6
    terminal_shuttle_day_end_hour: int = 22
    max_logistics_passengers: int = 1

    # Work policy. All values are configurable from ai_dispatch_config.
    global_work_mode: ShiftType = "max_effort"
    shift_start_hour: int = 6
    shift_start_minute: int = 0
    normal_shift_duration_minutes: int = 12 * 60       # 06:00 -> 18:00
    intensive_shift_duration_minutes: int = 18 * 60    # 06:00 -> 00:00 next day
    max_effort_shift_duration_minutes: int = 22 * 60   # 06:00 -> 04:00 next day

    # Secondary objective only. Coverage is optimized in a separate first phase.
    normal_shift_cost: int = 0
    intensive_shift_cost: int = 120
    max_effort_shift_cost: int = 300
