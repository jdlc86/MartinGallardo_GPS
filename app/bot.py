from __future__ import annotations

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes, MessageHandler, filters

from app.config import settings
from app.db import audit, get_user_by_telegram_id, register_or_refresh_user
from app.users import list_active_non_owner_users, list_pending_users, set_user_status


def _pending_keyboard(telegram_user_id: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[
            InlineKeyboardButton("✅ Autorizar", callback_data=f"user:ACTIVE:{telegram_user_id}"),
            InlineKeyboardButton("❌ Rechazar", callback_data=f"user:REJECTED:{telegram_user_id}"),
        ]]
    )


def _active_user_keyboard(telegram_user_id: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton("🚫 Desactivar acceso", callback_data=f"user:DISABLED:{telegram_user_id}")]]
    )


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    tg_user = update.effective_user
    if tg_user is None or update.effective_message is None:
        return

    user = await register_or_refresh_user(
        telegram_user_id=tg_user.id,
        full_name=tg_user.full_name,
        telegram_username=tg_user.username,
    )
    await audit(actor_user_id=user.id, action="BOT_START", entity_type="app_user", entity_id=user.id)

    if user.status == "ACTIVE":
        lines = [
            f"Acceso activo. Rol: {user.role}.",
            "",
            "Operaciones disponibles:",
            "• Configurar (OWNER/ADMIN)",
        ]
        if user.role == "OWNER":
            lines.extend(["• /pendientes", "• /usuarios"])
        await update.effective_message.reply_text("\n".join(lines))
    elif user.status == "PENDING":
        await update.effective_message.reply_text(
            "Tu solicitud de acceso ha quedado registrada y está pendiente de autorización."
        )
    else:
        await update.effective_message.reply_text("⛔ Tu usuario no tiene acceso autorizado.")


async def configurar(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    tg_user = update.effective_user
    if tg_user is None or update.effective_message is None:
        return

    user = await get_user_by_telegram_id(tg_user.id)
    if user is None or user.status != "ACTIVE":
        await update.effective_message.reply_text("⛔ No tienes acceso autorizado.")
        return
    if user.role not in {"OWNER", "ADMIN"}:
        await update.effective_message.reply_text("⛔ Solo OWNER o ADMIN pueden configurar el terreno.")
        return

    await audit(
        actor_user_id=user.id,
        action="PARKING_CONFIGURATION_OPENED",
        entity_type="parking",
        entity_id="single-parking",
        metadata={"telegram_user_id": user.telegram_user_id},
    )
    await update.effective_message.reply_text(
        "⚙️ Configuración del parking autorizada.\n\n"
        "La Mini App de perímetro y sectorización se conectará aquí en el siguiente bloque."
    )


async def pendientes(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    tg_user = update.effective_user
    if tg_user is None or update.effective_message is None:
        return

    actor = await get_user_by_telegram_id(tg_user.id)
    if actor is None or actor.status != "ACTIVE" or actor.role != "OWNER":
        await update.effective_message.reply_text("⛔ Solo el OWNER puede gestionar accesos.")
        return

    pending = await list_pending_users()
    if not pending:
        await update.effective_message.reply_text("No hay solicitudes pendientes.")
        return

    for user in pending:
        username = f"@{user.telegram_username}" if user.telegram_username else "sin username"
        await update.effective_message.reply_text(
            f"👤 {user.full_name}\n{username}\nTelegram ID: {user.telegram_user_id}",
            reply_markup=_pending_keyboard(user.telegram_user_id),
        )


async def usuarios(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    tg_user = update.effective_user
    if tg_user is None or update.effective_message is None:
        return

    actor = await get_user_by_telegram_id(tg_user.id)
    if actor is None or actor.status != "ACTIVE" or actor.role != "OWNER":
        await update.effective_message.reply_text("⛔ Solo el OWNER puede gestionar accesos.")
        return

    users = await list_active_non_owner_users()
    if not users:
        await update.effective_message.reply_text("No hay trabajadores activos.")
        return

    for user in users:
        username = f"@{user.telegram_username}" if user.telegram_username else "sin username"
        await update.effective_message.reply_text(
            f"👤 {user.full_name}\n{username}\nRol: {user.role}\nTelegram ID: {user.telegram_user_id}",
            reply_markup=_active_user_keyboard(user.telegram_user_id),
        )


async def user_access_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    tg_user = update.effective_user
    if query is None or tg_user is None or query.data is None:
        return
    await query.answer()

    actor = await get_user_by_telegram_id(tg_user.id)
    if actor is None or actor.status != "ACTIVE" or actor.role != "OWNER":
        await query.edit_message_text("⛔ No autorizado.")
        return

    try:
        _, status, raw_id = query.data.split(":", 2)
        target_id = int(raw_id)
        target = await set_user_status(actor=actor, target_telegram_user_id=target_id, status=status)
    except (ValueError, LookupError, PermissionError) as exc:
        await query.edit_message_text(f"No se pudo cambiar el acceso: {exc}")
        return

    await query.edit_message_text(f"Usuario {target.full_name}: {target.status}.")
    notification = {
        "ACTIVE": "✅ Tu acceso al sistema ha sido autorizado.",
        "DISABLED": "⛔ Tu acceso al sistema ha sido desactivado.",
        "REJECTED": "❌ Tu solicitud de acceso ha sido rechazada.",
    }.get(status)
    if notification:
        try:
            await context.bot.send_message(chat_id=target.telegram_user_id, text=notification)
        except Exception:
            pass


async def unknown_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_message is not None:
        await update.effective_message.reply_text(
            "No reconozco esa operación todavía. Usa /start para ver las opciones disponibles."
        )


def build_bot_application() -> Application:
    application = Application.builder().token(settings.telegram_bot_token).build()
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("pendientes", pendientes))
    application.add_handler(CommandHandler("usuarios", usuarios))
    application.add_handler(CallbackQueryHandler(user_access_callback, pattern=r"^user:"))
    application.add_handler(
        MessageHandler(filters.TEXT & filters.Regex(r"(?i)^\s*configurar\s*$"), configurar)
    )
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, unknown_text))
    return application
