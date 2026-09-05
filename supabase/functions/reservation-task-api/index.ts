import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS_JSON = Deno.env.get("SUPABASE_SECRET_KEYS");
const LEGACY_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ORIGIN = "https://jdlc86.github.io";
const MINI_APP_URL = "https://jdlc86.github.io/MartinGallardo_GPS/preview-modern/";
const MAX_AGE_SECONDS = 86_400;

class AppError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function serverKey() {
  if (SECRET_KEYS_JSON) {
    try {
      const parsed = JSON.parse(SECRET_KEYS_JSON);
      if (typeof parsed?.default === "string") return parsed.default;
      const first = Object.values(parsed || {})[0];
      if (typeof first === "string") return first;
    } catch {
      // Fall through to the legacy environment variable.
    }
  }
  if (LEGACY_SERVICE_ROLE_KEY) return LEGACY_SERVICE_ROLE_KEY;
  throw new AppError("no_server_key", 500);
}

function serverHeaders(extra: Record<string, string> = {}) {
  const key = serverKey();
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ORIGIN,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    Vary: "Origin",
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function hmac(key: Uint8Array | string, message: string) {
  const keyBytes = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const rawKey = keyBytes.buffer.slice(
    keyBytes.byteOffset,
    keyBytes.byteOffset + keyBytes.byteLength,
  ) as ArrayBuffer;
  const imported = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(message)),
  );
}

function hexBytes(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const output = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

async function authenticate(initData: string) {
  const params = new URLSearchParams(initData);
  const suppliedHash = params.get("hash") || "";
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const calculated = await hmac(await hmac("WebAppData", BOT_TOKEN), dataCheckString);
  const supplied = hexBytes(suppliedHash);
  if (!supplied || !constantTimeEqual(calculated, supplied)) {
    throw new AppError("invalid_init_data", 403);
  }

  const authDate = Number(params.get("auth_date") || 0);
  if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > MAX_AGE_SECONDS) {
    throw new AppError("expired_init_data", 403);
  }

  let user: { id?: number } | null = null;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    // The check below returns the public error code.
  }
  const telegramUserId = Number(user?.id);
  if (!Number.isFinite(telegramUserId)) throw new AppError("missing_user", 403);
  return telegramUserId;
}

async function table(name: string, params: Record<string, string>) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${name}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: serverHeaders({ Accept: "application/json" }) });
  if (!response.ok) throw new AppError((await response.text()) || `upstream_${response.status}`);
  return response.json();
}

async function insert(name: string, body: unknown) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${name}`, {
    method: "POST",
    headers: serverHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new AppError((await response.text()) || `upstream_${response.status}`);
}

async function rpc(name: string, body: unknown) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: serverHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      message = JSON.parse(text)?.message || text;
    } catch {
      // Keep the upstream response text.
    }
    const publicMessage = message.includes("task_assignment_conflict")
      ? "task_assignment_conflict"
      : message.includes("target_worker_inactive")
      ? "target_worker_inactive"
      : message.includes("not_admin")
      ? "not_admin"
      : message;
    throw new AppError(publicMessage, message.includes("conflict") ? 409 : 400);
  }
  return text ? JSON.parse(text) : null;
}

async function telegram(method: string, payload: unknown) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let parsed: { ok?: boolean; description?: string } | null = null;
  try {
    parsed = await response.json();
  } catch {
    // The status check below still records the failed attempt.
  }
  if (!response.ok || parsed?.ok === false) {
    throw new Error(`telegram_${method}_${response.status}_${parsed?.description || "unknown"}`);
  }
  return parsed;
}

function notificationKeyboard(notificationType: string) {
  const flowExpiryNotice = notificationType === "flow_session_expiring";
  const permissionNotice = notificationType.includes("permission") ||
    notificationType.includes("write_") || notificationType.includes("transfer");
  const text = flowExpiryNotice
    ? "⚠️ VOLVER A LA OPERACIÓN"
    : permissionNotice
      ? "📋 ABRIR GESTIÓN DE RESERVAS"
      : "⚡ VER MIS TAREAS";
  const path = flowExpiryNotice
    ? "operations.html?v=20260905SESSIONTEST1"
    : permissionNotice
      ? "reservations-admin.html?v=20260901R3"
      : "operations.html?v=20260901TASK3";
  return { inline_keyboard: [[{ text, web_app: { url: `${MINI_APP_URL}${path}` } }]] };
}

async function flushTelegramNotifications(limit = 15) {
  let claimed: Array<Record<string, unknown>> = [];
  try {
    const result = await rpc("parking_booking_claim_telegram_notifications", { p_limit: limit });
    claimed = Array.isArray(result) ? result : [];
  } catch (error) {
    console.error("claim_task_notifications", error);
    return { attempted: 0, delivered: 0, failed: 0 };
  }

  let delivered = 0;
  let failed = 0;
  for (const notification of claimed) {
    try {
      await telegram("sendMessage", {
        chat_id: Number(notification.recipient_telegram_user_id),
        text: `🔔 ${notification.title}\n\n${notification.body}`,
        reply_markup: notificationKeyboard(String(notification.notification_type || "")),
      });
      await rpc("parking_booking_finish_telegram_notification", {
        p_notification_id: Number(notification.id),
        p_success: true,
        p_error: null,
      });
      delivered += 1;
    } catch (error) {
      failed += 1;
      console.error("send_task_notification", error);
      try {
        await rpc("parking_booking_finish_telegram_notification", {
          p_notification_id: Number(notification.id),
          p_success: false,
          p_error: String((error as Error)?.message || error),
        });
      } catch (finishError) {
        console.error("finish_task_notification", finishError);
      }
    }
  }
  return { attempted: claimed.length, delivered, failed };
}

async function currentUser(telegramUserId: number) {
  const rows = await table("telegram_users", {
    telegram_user_id: `eq.${telegramUserId}`,
    active: "eq.true",
    select: "telegram_user_id,role",
  });
  const user = rows[0];
  if (!user) throw new AppError("not_authorized", 403);
  return user;
}

async function workerFor(telegramUserId: number) {
  const rows = await table("workers", {
    telegram_user_id: `eq.${telegramUserId}`,
    active: "eq.true",
    select: "id,telegram_user_id,full_name,role,active",
    limit: "1",
  });
  return rows[0] || null;
}

async function activeWorkers() {
  const workers = await table("workers", {
    active: "eq.true",
    select: "id,telegram_user_id,full_name,role,active",
    order: "full_name.asc",
  });
  const telegramIds = workers
    .map((worker: Record<string, unknown>) => Number(worker.telegram_user_id))
    .filter((id: number) => Number.isFinite(id));
  if (!telegramIds.length) return [];
  const accounts = await table("telegram_users", {
    telegram_user_id: `in.(${telegramIds.join(",")})`,
    active: "eq.true",
    select: "telegram_user_id,role",
  });
  const roleByTelegramId = new Map(
    accounts.map((account: Record<string, unknown>) => [
      Number(account.telegram_user_id),
      String(account.role),
    ]),
  );
  return workers
    .filter((worker: Record<string, unknown>) => {
      const role = roleByTelegramId.get(Number(worker.telegram_user_id));
      return role !== undefined && role !== "owner";
    })
    .map((worker: Record<string, unknown>) => ({
      ...worker,
      role: roleByTelegramId.get(Number(worker.telegram_user_id)),
    }));
}

async function taskRows(filter: Record<string, string> = {}) {
  return table("reservation_tasks", {
    ...filter,
    select:
      "id,booking_id,task_type,scheduled_at,assigned_worker_id,assigned_at,status,version,completed_at,parking_bookings!inner(id,pickup_date,pickup_time,pickup_terminal,return_date,return_time,return_terminal,price_eur,customer_name,customer_email,customer_phone,vehicle_plate,vehicle_plate_normalized,vehicle_make_model,payment_method,deleted_at),workers(id,telegram_user_id,full_name,role)",
    order: "scheduled_at.asc",
  });
}

function mapTask(task: Record<string, any>) {
  const booking = task.parking_bookings || {};
  const worker = task.workers || null;
  return {
    id: task.id,
    booking_id: task.booking_id,
    type: task.task_type,
    scheduled_at: task.scheduled_at,
    terminal: task.task_type === "pickup" ? booking.pickup_terminal : booking.return_terminal,
    pickup_date: booking.pickup_date,
    pickup_time: booking.pickup_time,
    pickup_terminal: booking.pickup_terminal,
    return_date: booking.return_date,
    return_time: booking.return_time,
    return_terminal: booking.return_terminal,
    plate: booking.vehicle_plate,
    customer_name: booking.customer_name,
    customer_email: booking.customer_email,
    customer_phone: booking.customer_phone,
    price_eur: booking.price_eur,
    payment_method: booking.payment_method,
    vehicle_make_model: booking.vehicle_make_model,
    status: task.status,
    version: task.version,
    assigned_worker: worker
      ? {
        id: worker.id,
        telegram_user_id: worker.telegram_user_id,
        full_name: worker.full_name,
        role: worker.role,
      }
      : null,
  };
}

function requireUuid(value: unknown, code: string) {
  const uuid = String(value || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new AppError(code);
  }
  return uuid;
}

function taskLine(task: Record<string, any>) {
  const dateTime = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(task.scheduled_at));
  return `${task.type === "pickup" ? "✈️ Recogida" : "🏁 Entrega"} · ${dateTime} · ${
    task.terminal || "Terminal —"
  } · ${task.plate || "—"}`;
}

async function enqueueAssignmentNotifications(
  tasks: Array<Record<string, any>>,
  target: Record<string, any>,
  previous: Map<number, Array<Record<string, any>>>,
) {
  const notifications: Array<Record<string, unknown>> = [];
  const targetId = Number(target?.target_telegram_user_id ?? target?.telegram_user_id);
  const lines = tasks.slice(0, 8).map(taskLine);
  const more = tasks.length > 8 ? `\n… y ${tasks.length - 8} más.` : "";
  const body = `${tasks.length} ${tasks.length === 1 ? "tarea asignada" : "tareas asignadas"} a tu agenda.\n\n${
    lines.join("\n")
  }${more}`;

  if (Number.isFinite(targetId)) {
    notifications.push({
      recipient_telegram_user_id: targetId,
      notification_type: "task_assignment",
      title: "Nuevas asignaciones",
      body,
      payload: { task_ids: tasks.map((task) => task.id) },
    });
  }

  for (const [telegramUserId, reassignedTasks] of previous) {
    const reassignedBody = `${reassignedTasks.length} ${
      reassignedTasks.length === 1 ? "tarea ha" : "tareas han"
    } sido reasignada${reassignedTasks.length === 1 ? "" : "s"} a otro operario.\n\n${
      reassignedTasks.slice(0, 8).map(taskLine).join("\n")
    }`;
    notifications.push({
      recipient_telegram_user_id: telegramUserId,
      notification_type: "task_reassignment",
      title: "Cambio de asignación",
      body: reassignedBody,
      payload: { task_ids: reassignedTasks.map((task) => task.id) },
    });
  }

  if (notifications.length) await insert("parking_booking_notifications", notifications);
  return notifications.length;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  try {
    const origin = request.headers.get("Origin");
    if (origin && origin !== ORIGIN) throw new AppError("origin_not_allowed", 403);

    const body = await request.json();
    const telegramUserId = await authenticate(String(body.initData || ""));
    const actor = await currentUser(telegramUserId);
    const action = String(body.action || "");

    if (action === "dispatch") {
      if (!["owner", "admin"].includes(actor.role)) throw new AppError("not_admin", 403);
      const tasks = (await taskRows({
        status: "in.(unassigned,assigned)",
        "parking_bookings.deleted_at": "is.null",
      })).map(mapTask);
      return json({ ok: true, tasks, workers: await activeWorkers() });
    }

    if (action === "mine") {
      const worker = await workerFor(telegramUserId);
      if (!worker) return json({ ok: true, tasks: [] });
      const tasks = (await taskRows({
        assigned_worker_id: `eq.${worker.id}`,
        status: "eq.assigned",
        "parking_bookings.deleted_at": "is.null",
      })).map(mapTask);
      return json({ ok: true, tasks, worker });
    }

    if (action === "assign") {
      if (!["owner", "admin"].includes(actor.role)) throw new AppError("not_admin", 403);
      if (!Array.isArray(body.items) || body.items.length === 0) {
        throw new AppError("empty_task_selection");
      }
      const items = body.items.map((item: Record<string, unknown>) => ({
        id: requireUuid(item.id, "invalid_task_selection"),
        version: Number(item.version),
      }));
      if (items.some((item: { version: number }) => !Number.isSafeInteger(item.version) || item.version < 0)) {
        throw new AppError("invalid_task_selection");
      }
      const targetWorkerId = requireUuid(body.target_worker_id, "invalid_target_worker");
      const filter = `in.(${items.map((item: { id: string }) => item.id).join(",")})`;
      const before = await taskRows({ id: filter });
      const previous = new Map<number, Array<Record<string, any>>>();
      for (const raw of before) {
        const task = mapTask(raw);
        const previousWorker = raw.workers;
        if (previousWorker?.telegram_user_id && previousWorker.id !== targetWorkerId) {
          const id = Number(previousWorker.telegram_user_id);
          if (!previous.has(id)) previous.set(id, []);
          previous.get(id)!.push(task);
        }
      }

      const result = await rpc("reservation_task_bulk_assign", {
        p_actor_telegram_user_id: telegramUserId,
        p_target_worker_id: targetWorkerId,
        p_items: items,
      });
      const tasks = (await taskRows({ id: filter })).map(mapTask);
      const queued = await enqueueAssignmentNotifications(tasks, result, previous);
      return json({ ok: true, result, tasks, notifications_queued: queued });
    }

    if (action === "notifications") {
      const delivery = await flushTelegramNotifications();
      const notifications = await table("parking_booking_notifications", {
        recipient_telegram_user_id: `eq.${telegramUserId}`,
        select: "id,notification_type,title,body,payload,read_at,created_at",
        order: "created_at.desc",
        limit: "50",
      });
      return json({
        ok: true,
        notifications,
        unread: notifications.filter((notification: Record<string, unknown>) => !notification.read_at).length,
        notification_delivery: delivery,
      });
    }

    if (action === "mark_notifications_read") {
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((id: unknown) => Number.isSafeInteger(Number(id))).map(Number)
        : [];
      if (ids.length) {
        const url = new URL(`${SUPABASE_URL}/rest/v1/parking_booking_notifications`);
        url.searchParams.set("recipient_telegram_user_id", `eq.${telegramUserId}`);
        url.searchParams.set("id", `in.(${ids.join(",")})`);
        const response = await fetch(url, {
          method: "PATCH",
          headers: serverHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ read_at: new Date().toISOString() }),
        });
        if (!response.ok) throw new AppError(await response.text());
      }
      return json({ ok: true });
    }

    throw new AppError("invalid_action");
  } catch (error) {
    console.error(error);
    const appError = error as AppError;
    return json({ ok: false, error: String(appError?.message || error) }, appError?.status || 400);
  }
});
