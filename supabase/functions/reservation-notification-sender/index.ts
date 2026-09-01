import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS_JSON = Deno.env.get("SUPABASE_SECRET_KEYS");
const LEGACY_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const MINI_APP_URL = "https://jdlc86.github.io/MartinGallardo_GPS/preview-modern/";

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
  throw new Error("no_server_key");
}

function serverHeaders(extra: Record<string, string> = {}) {
  const key = serverKey();
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function rpc(name: string, body: unknown) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: serverHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `rpc_${name}_${response.status}`);
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
    // The response status below still records the failed attempt.
  }
  if (!response.ok || parsed?.ok === false) {
    throw new Error(`telegram_${method}_${response.status}_${parsed?.description || "unknown"}`);
  }
}

function keyboard(notificationType: string) {
  const permissionNotice = notificationType.includes("permission") ||
    notificationType.includes("write_") || notificationType.includes("transfer");
  const text = permissionNotice ? "📋 ABRIR GESTIÓN DE RESERVAS" : "⚡ VER MIS TAREAS";
  const path = permissionNotice
    ? "reservations-admin.html?v=20260901R3"
    : "operations.html?v=20260901TASK3";
  return { inline_keyboard: [[{ text, web_app: { url: `${MINI_APP_URL}${path}` } }]] };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const suppliedSecret = request.headers.get("X-PMG-Cron-Secret") || "";
  let authorized = false;
  try {
    authorized = suppliedSecret.length >= 32 && await rpc(
      "validate_reservation_notification_cron_secret",
      { p_secret: suppliedSecret },
    ) === true;
  } catch (error) {
    console.error("validate_notification_cron", error);
  }
  if (!authorized) return json({ ok: false, error: "not_authorized" }, 403);

  let claimed: Array<Record<string, unknown>> = [];
  try {
    const result = await rpc("parking_booking_claim_telegram_notifications", { p_limit: 25 });
    claimed = Array.isArray(result) ? result : [];
  } catch (error) {
    console.error("claim_reservation_notifications", error);
    return json({ ok: false, error: "notification_claim_failed" }, 500);
  }

  let delivered = 0;
  let failed = 0;
  for (const notification of claimed) {
    try {
      await telegram("sendMessage", {
        chat_id: Number(notification.recipient_telegram_user_id),
        text: `🔔 ${notification.title}\n\n${notification.body}`,
        reply_markup: keyboard(String(notification.notification_type || "")),
      });
      await rpc("parking_booking_finish_telegram_notification", {
        p_notification_id: Number(notification.id),
        p_success: true,
        p_error: null,
      });
      delivered += 1;
    } catch (error) {
      failed += 1;
      console.error("send_reservation_notification", error);
      try {
        await rpc("parking_booking_finish_telegram_notification", {
          p_notification_id: Number(notification.id),
          p_success: false,
          p_error: String((error as Error)?.message || error),
        });
      } catch (finishError) {
        console.error("finish_reservation_notification", finishError);
      }
    }
  }

  return json({ ok: failed === 0, attempted: claimed.length, delivered, failed });
});
