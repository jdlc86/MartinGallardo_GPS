from __future__ import annotations

from sqlalchemy import text

from app.db import AppUser, _to_user, audit, engine, get_user_by_telegram_id


async def list_pending_users() -> list[AppUser]:
    async with engine.connect() as conn:
        result = await conn.execute(
            text(
                """
                select id, telegram_user_id, full_name, telegram_username,
                       role::text as role, status::text as status
                from public.app_users
                where status = 'PENDING'
                order by created_at asc
                """
            )
        )
        return [_to_user(row) for row in result.fetchall()]


async def set_user_status(
    *, actor: AppUser, target_telegram_user_id: int, status: str
) -> AppUser:
    if actor.role != "OWNER" or actor.status != "ACTIVE":
        raise PermissionError("Only an active OWNER can change user access")

    target = await get_user_by_telegram_id(target_telegram_user_id)
    if target is None:
        raise LookupError("User not found")
    if target.role == "OWNER":
        raise PermissionError("OWNER access cannot be changed from the bot")

    if status not in {"ACTIVE", "DISABLED", "REJECTED"}:
        raise ValueError("Invalid user status")

    async with engine.begin() as conn:
        await conn.execute(
            text(
                """
                update public.app_users
                set status = cast(:status as public.user_status),
                    approved_at = case when :status = 'ACTIVE' then now() else approved_at end,
                    approved_by = case when :status = 'ACTIVE' then cast(:actor_id as uuid) else approved_by end,
                    disabled_at = case when :status = 'DISABLED' then now() else null end,
                    disabled_by = case when :status = 'DISABLED' then cast(:actor_id as uuid) else null end
                where telegram_user_id = :target_telegram_user_id
                """
            ),
            {
                "status": status,
                "actor_id": actor.id,
                "target_telegram_user_id": target_telegram_user_id,
            },
        )

    await audit(
        actor_user_id=actor.id,
        action=f"USER_{status}",
        entity_type="app_user",
        entity_id=target.id,
        metadata={"telegram_user_id": target_telegram_user_id},
    )
    updated = await get_user_by_telegram_id(target_telegram_user_id)
    if updated is None:
        raise RuntimeError("User disappeared after status update")
    return updated
