from datetime import datetime, timedelta, timezone

from parking_optimizer.domain import OptimizerConfig, Task, Worker
from parking_optimizer.solver import solve
from parking_optimizer.validator import validate_solution

UTC = timezone.utc


def dt(hour: int, minute: int):
    return datetime(2026, 9, 5, hour, minute, tzinfo=UTC)


def pickup(task_id: str, terminal: str, scheduled, fixed_worker_id=None):
    start = scheduled - timedelta(minutes=5)
    vehicle_depart = scheduled + timedelta(minutes=10)
    vehicle_arrive = vehicle_depart + timedelta(minutes=15)
    return Task(
        id=task_id,
        booking_id=f"b-{task_id}",
        task_type="pickup",
        scheduled_at=scheduled,
        start_at=start,
        end_at=vehicle_arrive,
        start_node=terminal,
        end_node="PARKING",
        terminal=terminal,
        version=1,
        vehicle_leg_depart_at=vehicle_depart,
        vehicle_leg_arrive_at=vehicle_arrive,
        fixed_worker_id=fixed_worker_id,
    )


def delivery(task_id: str, terminal: str, scheduled, fixed_worker_id=None):
    target = scheduled - timedelta(minutes=5)
    vehicle_depart = target - timedelta(minutes=20)
    return Task(
        id=task_id,
        booking_id=f"b-{task_id}",
        task_type="delivery",
        scheduled_at=scheduled,
        start_at=vehicle_depart,
        end_at=scheduled + timedelta(minutes=10),
        start_node="PARKING",
        end_node=terminal,
        terminal=terminal,
        version=1,
        vehicle_leg_depart_at=vehicle_depart,
        vehicle_leg_arrive_at=target,
        fixed_worker_id=fixed_worker_id,
    )


def test_companion_is_part_of_same_cp_sat_solution():
    a = Worker("A", "A")
    b = Worker("B", "B")
    tasks = [
        pickup("p1", "T1", dt(8, 0), "A"),
        pickup("p2", "T4", dt(9, 0), "A"),
        delivery("d1", "T4", dt(9, 0), "B"),
    ]
    cfg = OptimizerConfig(
        terminal_shuttle_access_minutes=0,
        terminal_shuttle_wait_day_minutes=0,
        terminal_shuttle_wait_night_minutes=0,
        max_logistics_passengers=1,
    )

    solution = solve(tasks, [a, b], cfg, time_limit_seconds=5)

    assert solution.solver_status in {"OPTIMAL", "FEASIBLE"}
    assert not solution.unassigned_task_ids
    assert len(solution.companion_matches) == 1
    match = solution.companion_matches[0]
    assert match.rider_worker_id == "A"
    assert match.rider_task_id == "p2"
    assert match.driver_worker_id == "B"
    assert match.driver_task_id == "d1"
    assert validate_solution(solution, cfg) == []
