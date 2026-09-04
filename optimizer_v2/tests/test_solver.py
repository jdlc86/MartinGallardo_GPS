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


def test_intensive_rest_opens_new_shift_and_resets_location():
    worker = Worker("A", "A")
    tasks = [
        pickup("p1", "T1", dt(8, 0), "A"),
        pickup("p2", "T4", dt(15, 0), "A"),
    ]
    cfg = OptimizerConfig(
        global_work_mode="intensive",
        company_shuttle_vehicle_count=0,
        normal_rest_minutes=720,
        intensive_rest_minutes=360,
    )
    solution = solve(tasks, [worker], cfg, time_limit_seconds=5)

    assert not solution.unassigned_task_ids
    assert len(solution.shift_assignments) == 2
    assert solution.shift_assignments[1].shift_type == "intensive"
    assert solution.routes["A"].transitions["p2"].kind == "shift_start"
    assert validate_solution(solution, cfg) == []


def test_rest_shorter_than_policy_cannot_fake_repositioning():
    worker = Worker("A", "A")
    tasks = [
        pickup("p1", "T1", dt(8, 0)),
        pickup("p2", "T4", dt(13, 0)),
    ]
    cfg = OptimizerConfig(
        global_work_mode="intensive",
        company_shuttle_vehicle_count=0,
        normal_rest_minutes=720,
        intensive_rest_minutes=360,
    )
    solution = solve(tasks, [worker], cfg, time_limit_seconds=5)

    assert solution.coverage_count == 1
    assert len(solution.unassigned_task_ids) == 1
    assert validate_solution(solution, cfg) == []


def test_max_effort_allows_two_hour_rest_restart():
    worker = Worker("A", "A")
    tasks = [
        pickup("p1", "T1", dt(8, 0), "A"),
        pickup("p2", "T4", dt(11, 0), "A"),
    ]
    cfg = OptimizerConfig(
        global_work_mode="max_effort",
        company_shuttle_vehicle_count=0,
        max_effort_rest_minutes=120,
    )
    solution = solve(tasks, [worker], cfg, time_limit_seconds=5)

    assert not solution.unassigned_task_ids
    assert len(solution.shift_assignments) == 2
    assert solution.shift_assignments[1].shift_type == "max_effort"
    assert validate_solution(solution, cfg) == []


def test_back_forward_global_closure_preserves_company_shuttle():
    a = Worker("A", "A")
    tasks = [
        pickup("p1", "T1", dt(8, 0), "A"),
        pickup("p2", "T4", dt(9, 0), "A"),
    ]
    cfg = OptimizerConfig(
        global_work_mode="max_effort",
        company_shuttle_vehicle_count=1,
        company_shuttle_passenger_capacity=4,
        terminal_shuttle_access_minutes=0,
        terminal_shuttle_wait_day_minutes=0,
        terminal_shuttle_wait_night_minutes=0,
        back_forward_window_minutes=30,
        back_forward_overlap_minutes=5,
    )

    solution = solve(tasks, [a], cfg, time_limit_seconds=8)

    assert solution.coverage_count == 2
    assert not solution.unassigned_task_ids
    assert len(solution.company_shuttle_missions) >= 1
    assert any(t.kind == "company_shuttle" for t in solution.routes["A"].transitions.values())
    assert validate_solution(solution, cfg) == []


def test_back_forward_global_closure_never_reduces_coverage():
    workers = [Worker("A", "A"), Worker("B", "B")]
    tasks = [
        delivery("d1", "T1", dt(8, 0)),
        pickup("p1", "T1", dt(8, 40)),
        delivery("d2", "T4", dt(9, 20)),
        pickup("p2", "T4", dt(10, 0)),
    ]
    cfg = OptimizerConfig(
        global_work_mode="max_effort",
        company_shuttle_vehicle_count=2,
        back_forward_window_minutes=45,
        back_forward_overlap_minutes=10,
    )

    solution = solve(tasks, workers, cfg, time_limit_seconds=8)

    assert solution.coverage_count >= 1
    assert solution.coverage_count == len(tasks) - len(solution.unassigned_task_ids)
    assert validate_solution(solution, cfg) == []
