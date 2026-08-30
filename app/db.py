from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.config import settings


engine: AsyncEngine = create_async_engine(settings.database_url, pool_pre_ping=True)


@dataclass(slots=True)
class AppUser:
    id: str
    telegram_user_id: int
    full_name: str
    telegram_username: str | None
    role: str
    status: str


def _to_user(row: Any) -> AppUser:
    return AppUser(
        id=str(row.id),
        telegram_user_id=row.telegram_user_id,
        full_name=row.full_name,
        telegram_username=row.telegram_username,
        role=row.role,
        status=row.status,
    )


async def get_user_by_telegram_id(telegram_user_id: int) -> AppUser | None:
    async with engine.connect() as conn:
        result = await conn.execute(
            text(
                """
                select id, telegram_user_id, full_name, telegram_username,
                       role::text as role, status::text as status
                from public.app_users
                where telegram_user_id = :telegram_user_id
                """
            ),
            {"telegram_user_id": telegram_user_id},
        )
        row = result.first()
        return _to_user(row) if row else None


async def register_or_refresh_user(
    *, telegram_user_id: int, full_name: str, telegram_username: str | None
) -> AppUser:
    owner_id = settings.owner_telegram_id
    is_owner = owner_id is not None and telegram_user_id == owner_id

    async with engine.begin() as conn:
        await conn.execute(
            text(
                """
                insert into public.app_users (
                    telegram_user_id, telegram_username, full_name, role, status, approved_at
                )
                values (
                    :telegram_user_id, :telegram_username, :full_name,
                    cast(:role as public.user_role), cast(:status as public.user_status),
                    case when :status = 'ACTIVE' then now() else null end
                )
                on conflict (telegram_user_id) do update
                set telegram_username = excluded.telegram_username,
                    full_name = excluded.full_name
                """
            ),
            {
                "telegram_user_id": telegram_user_id,
                "telegram_username": telegram_username,
                "full_name": full_name,
                "role": "OWNER" if is_owner else "OPERATOR",
                "status": "ACTIVE" if is_owner else "PENDING",
            },
        )

    user = await get_user_by_telegram_id(telegram_user_id)
    if user is None:
        raise RuntimeError("Unable to create or load Telegram user")
    return user


async def audit(
    *, actor_user_id: str | None, action: str, entity_type: str, entity_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            text(
                """
                insert into public.audit_events(actor_user_id, action, entity_type, entity_id, metadata)
                values (:actor_user_id, :action, :entity_type, :entity_id, cast(:metadata as jsonb))
                """
            ),
            {
                "actor_user_id": actor_user_id,
                "action": action,
                "entity_type": entity_type,
                "entity_id": entity_id,
                "metadata": __import__("json").dumps(metadata or {}),
            },
        )
