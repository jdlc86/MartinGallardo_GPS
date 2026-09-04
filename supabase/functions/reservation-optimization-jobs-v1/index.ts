import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS_JSON = Deno.env.get("SUPABASE_SECRET_KEYS");
const LEGACY_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ORIGIN = "https://jdlc86.github.io";
const BACKEND_VERSION = "1.4.0";
const BACKEND_BUILD = "2026.09.04.04";

const OPTIMIZER_DEFAULTS = {
  back_forward_mode: "fast",
  global_work_mode: "max_effort",
  company_shuttle_vehicle_count: 1,
  company_shuttle_passenger_capacity: 4,
  normal_shift_duration_minutes: 720,
  intensive_shift_duration_minutes: 1080,
  max_effort_shift_duration_minutes: 1320,
  normal_rest_minutes: 720,
  intensive_rest_minutes: 360,
  max_effort_rest_minutes: 120,
  back_forward_window_minutes: 1440,
  back_forward_overlap_minutes: 360,
  back_forward_candidate_step_minutes: 60,
  back_forward_max_anchor_candidates: 12,
  back_forward_optimal_explore_ratio: 0.35,
  optimizer_time_limit_seconds: 120,
};
const OPTIMIZER_CONFIG_FIELDS = Object.keys(OPTIMIZER_DEFAULTS);


class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function serviceKey() {
  if (SECRET_KEYS_JSON) {
    try {
      const parsed = JSON.parse(SECRET_KEYS_JSON);
      if (typeof parsed?.default === "string") return parsed.default;
      const first = Object.values(parsed || {})[0];
      if (typeof first === "string") return first;
    } catch {
      // fallback below
    }
  }
  if (LEGACY_SERVICE_ROLE_KEY) return LEGACY_SERVICE_ROLE_KEY;
  throw new AppError("no_server_key", 500);
}

function headers(extra: Record<string, string> = {}) {
  const key = serviceKey();
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

function cors() {
  return {
    "Access-Control-Allow-Origin": ORIGIN,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    Vary: "Origin",
  };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmac(key: Uint8Array | string, message: string) {
  const bytes = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message)));
}

function fromHex(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function authenticate(initData: string) {
  const params = new URLSearchParams(initData);
  const suppliedHash = params.get("hash") || "";
  params.delete("hash");
  const checkString = [...params.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const calculated = await hmac(await hmac("WebAppData", BOT_TOKEN), checkString);
  const supplied = fromHex(suppliedHash);
  if (!supplied || !constantTimeEqual(calculated, supplied)) throw new AppError("invalid_init_data", 403);
  const authDate = Number(params.get("auth_date") || 0);
  if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > 86400) throw new AppError("expired_init_data", 403);
  let telegramUser: any = null;
  try { telegramUser = JSON.parse(params.get("user") || "null"); } catch { /* invalid below */ }
  const actor = Number(telegramUser?.id);
  if (!Number.isFinite(actor)) throw new AppError("missing_user", 403);
  return actor;
}

async function rest(path: string, method = "GET", body?: unknown, query?: Record<string, string>) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
  const res = await fetch(url, {
    method,
    headers: headers({
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(method === "POST" ? { Prefer: "return=representation" } : {}),
    }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new AppError(text || "db_error", res.status === 409 ? 409 : 500);
  return text ? JSON.parse(text) : null;
}

const rpc = (name: string, body: unknown) => rest(`rpc/${name}`, "POST", body);

const ROUTE_PREFLIGHT_URL = `${SUPABASE_URL}/functions/v1/reservation-ai-planner-v2`;
const MADRID_HOUR = new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Madrid",hour:"2-digit",hour12:false});
function routeBand(at: Date) {
  const h = Number(MADRID_HOUR.format(at));
  return h < 6 ? "MADRUGADA" : h < 10 ? "PUNTA_MANANA" : h < 16 ? "VALLE_DIA" : h < 20 ? "PUNTA_TARDE" : "NOCHE";
}
function routeTerminal(value: unknown) {
  const s=String(value||"").toUpperCase().replace(/\s+/g,"");
  if(s.includes("4S")||s.includes("T4")||s.includes("TERMINAL4")) return "T4";
  if(s.includes("T3")||s.includes("TERMINAL3")) return "T3";
  if(s.includes("T2")||s.includes("TERMINAL2")) return "T2";
  if(s.includes("T1")||s.includes("TERMINAL1")) return "T1";
  return null;
}
async function routeNeeds(start: Date,end: Date) {
  const tasks=await rest("reservation_tasks","GET",undefined,{
    status:"in.(unassigned,assigned)",
    scheduled_at:`gte.${start.toISOString()}`,
    and:`(scheduled_at.lt.${end.toISOString()})`,
    select:"id,task_type,scheduled_at,parking_bookings!inner(pickup_terminal,return_terminal,deleted_at)",
    "parking_bookings.deleted_at":"is.null",
    order:"scheduled_at.asc",
  });
  const bands=new Set<string>(),terminals=new Set<string>();
  for(const row of tasks){
    const booking=row.parking_bookings||{};
    const t=routeTerminal(row.task_type==="pickup"?booking.pickup_terminal:booking.return_terminal);
    if(t) terminals.add(t);
    const at=new Date(row.scheduled_at);
    for(const offset of [-90,0,90]) bands.add(routeBand(new Date(+at+offset*60000)));
  }
  return {bands:[...bands],terminals:[...terminals],task_count:tasks.length};
}
async function matrixReady(bands:string[],terminals:string[]) {
  if(!bands.length||!terminals.length) return true;
  const rows=await rest("ai_dispatch_route_matrix","GET",undefined,{
    time_band:`in.(${bands.join(",")})`,
    select:"origin,destination,time_band,current_duration_s",
  });
  for(const band of bands) for(const terminal of terminals){
    for(const [origin,destination] of [["PARKING",terminal],[terminal,"PARKING"]]){
      if(!rows.some((r:any)=>r.time_band===band&&r.origin===origin&&r.destination===destination&&Number(r.current_duration_s)>0)) return false;
    }
  }
  return true;
}
async function prepareRoutes(initData:string,epoch:number,start:Date,end:Date){
  const needs=await routeNeeds(start,end);
  if(!needs.task_count||!needs.terminals.length) return {matrix_ready:true,skipped:true,reason:"no_route_tasks",...needs};
  try{
    const r=await fetch(ROUTE_PREFLIGHT_URL,{
      method:"POST",
      headers:headers({"Content-Type":"application/json"}),
      body:JSON.stringify({initData,action:"refresh_routes",writer_epoch:epoch,force:false,required_bands:needs.bands,required_terminals:needs.terminals,auto:true}),
    });
    const d=await r.json().catch(()=>({}));
    if(r.ok&&d?.ok&&d?.matrix_ready) return {...d,...needs};
    if(await matrixReady(needs.bands,needs.terminals)) return {matrix_ready:true,degraded:true,source:"cached_after_preflight_error",error:d?.error||d?.reason||"route_preflight_failed",...needs};
    throw new AppError(String(d?.error||d?.reason||"route_preflight_failed"),503);
  }catch(error){
    if(await matrixReady(needs.bands,needs.terminals)) return {matrix_ready:true,degraded:true,source:"cached_after_preflight_exception",error:String((error as Error)?.message||error),...needs};
    throw error;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (req.method !== "POST") return response({ ok: false, error: "method_not_allowed" }, 405);

  try {
    const origin = req.headers.get("Origin");
    if (origin && origin !== ORIGIN) throw new AppError("origin_not_allowed", 403);
    const body = await req.json();
    const actor = await authenticate(String(body.initData || ""));
    const action = String(body.action || "");



    if (action === "system_info") {
      const actorRows = await rest("telegram_users", "GET", undefined, {
        telegram_user_id: `eq.${actor}`,
        active: "eq.true",
        select: "telegram_user_id,role",
        limit: "1",
      });
      if (!actorRows.length || !["owner","admin"].includes(String(actorRows[0].role))) {
        throw new AppError("not_admin", 403);
      }
      const jobs = await rest("optimization_jobs", "GET", undefined, {
        status: "eq.succeeded",
        select: "id,created_at,input_snapshot,solver_version",
        order: "created_at.desc",
        limit: "1",
      });
      const latest = jobs[0] || null;
      return response({
        ok: true,
        backend: { version: BACKEND_VERSION, build: BACKEND_BUILD, function_version: 10 },
        optimizer: latest ? {
          version: latest.input_snapshot?.optimizer_version || null,
          build: latest.input_snapshot?.optimizer_build || null,
          solver_version: latest.solver_version || null,
          last_job_id: latest.id,
          last_job_at: latest.created_at,
        } : null,
      });
    }

    if (action === "participants") {
      const actorRows = await rest("telegram_users", "GET", undefined, {
        telegram_user_id: `eq.${actor}`,
        active: "eq.true",
        select: "telegram_user_id,role",
        limit: "1",
      });
      if (!actorRows.length || !["owner","admin"].includes(String(actorRows[0].role))) {
        throw new AppError("not_admin", 403);
      }
      const users = await rest("telegram_users", "GET", undefined, {
        active: "eq.true",
        role: "in.(admin,operario)",
        select: "telegram_user_id,role",
      });
      const roleById = new Map(users.map((u: any) => [Number(u.telegram_user_id), String(u.role)]));
      const ids = [...roleById.keys()];
      if (!ids.length) return response({ ok: true, participants: [] });
      const workers = await rest("workers", "GET", undefined, {
        active: "eq.true",
        telegram_user_id: `in.(${ids.join(",")})`,
        select: "id,telegram_user_id,full_name,role,active",
        order: "full_name.asc",
      });
      return response({
        ok: true,
        participants: workers.map((w: any) => ({
          id: String(w.id),
          telegram_user_id: Number(w.telegram_user_id),
          full_name: String(w.full_name),
          account_role: roleById.get(Number(w.telegram_user_id)),
        })),
      });
    }

    if (action === "enqueue") {
      const epoch = Number(body.writer_epoch);
      await rpc("parking_booking_require_writer", { p_actor_telegram_user_id: actor, p_writer_epoch: epoch });
      const cfg = (await rest("ai_dispatch_config", "GET", undefined, { id: "eq.1", select: "default_horizon_days" }))[0] || {};
      const days = Math.min(Math.max(Number(body.horizon_days) || Number(cfg.default_horizon_days) || 7, 1), 31);
      const start = new Date();
      const end = new Date(+start + days * 86400000);
      const selectedWorkerIds = Array.isArray(body.selected_worker_ids)
        ? [...new Set(body.selected_worker_ids.map((x: unknown) => String(x)).filter((x: string) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x)
          ))]
        : [];
      if (!selectedWorkerIds.length) throw new AppError("optimizer_no_participants");
      const allowedUsers = await rest("telegram_users", "GET", undefined, {
        active: "eq.true", role: "in.(admin,operario)", select: "telegram_user_id,role",
      });
      const allowedTelegramIds = allowedUsers.map((u: any) => Number(u.telegram_user_id)).filter(Number.isFinite);
      const allowedWorkers = allowedTelegramIds.length ? await rest("workers", "GET", undefined, {
        active: "eq.true",
        id: `in.(${selectedWorkerIds.join(",")})`,
        telegram_user_id: `in.(${allowedTelegramIds.join(",")})`,
        select: "id",
      }) : [];
      if (allowedWorkers.length !== selectedWorkerIds.length) throw new AppError("optimizer_invalid_participants");
      const routePreflight = await prepareRoutes(String(body.initData || ""), epoch, start, end);
      if (!routePreflight.matrix_ready) throw new AppError("route_preflight_failed", 503);
      const idempotencyKey = String(body.idempotency_key || crypto.randomUUID());
      try {
        const rows = await rest("optimization_jobs", "POST", {
          created_by_telegram_user_id: actor,
          writer_epoch: epoch,
          idempotency_key: idempotencyKey,
          status: "pending",
          solver_version: "optimizer_v2_cp_sat",
          horizon_start: start.toISOString(),
          horizon_end: end.toISOString(),
          request: { horizon_days: days, source: "miniapp", selected_worker_ids: selectedWorkerIds, route_preflight: routePreflight },
        });
        return response({ ok: true, job: rows[0], queued: true, route_preflight: routePreflight }, 202);
      } catch (error) {
        if ((error as AppError).status !== 409) throw error;
        const rows = await rest("optimization_jobs", "GET", undefined, {
          created_by_telegram_user_id: `eq.${actor}`,
          idempotency_key: `eq.${idempotencyKey}`,
          select: "*",
          limit: "1",
        });
        return response({ ok: true, job: rows[0], queued: false, idempotent: true });
      }
    }

    if (action === "latest") {
      const rows = await rest("optimization_jobs", "GET", undefined, {
        created_by_telegram_user_id: `eq.${actor}`,
        select: "id,status,solver_version,horizon_start,horizon_end,progress,metrics,result_plan_id,error_code,attempt,max_attempts,started_at,finished_at,created_at,updated_at",
        order: "created_at.desc",
        limit: "1",
      });
      if (!rows.length) return response({ ok: true, job: null, proposal: null });
      const job = rows[0];
      let proposal = null;
      if (job.status === "succeeded" && job.result_plan_id) {
        const plans = await rest("ai_dispatch_plans", "GET", undefined, {
          id: `eq.${job.result_plan_id}`,
          created_by_telegram_user_id: `eq.${actor}`,
          select: "id,status,solver_engine,horizon_start,horizon_end,plan,reports,created_at",
          limit: "1",
        });
        if (plans.length && plans[0].status === "proposal") {
          proposal = {
            plan_id: plans[0].id,
            status: plans[0].status,
            solver_engine: plans[0].solver_engine,
            horizon_start: plans[0].horizon_start,
            horizon_end: plans[0].horizon_end,
            created_at: plans[0].created_at,
            ...(plans[0].plan || {}),
            reports: plans[0].reports || {},
          };
          const unassigned = Array.isArray(proposal.unassigned) ? proposal.unassigned : [];
          const ids = unassigned.map((row: any) => String(row.task_id || "")).filter(Boolean);
          if (ids.length) {
            const taskRows = await rest("reservation_tasks", "GET", undefined, {
              id: `in.(${ids.join(",")})`,
              select: "id,task_type,scheduled_at,parking_bookings!inner(vehicle_plate,customer_name,pickup_terminal,return_terminal)",
            });
            const taskMeta = Object.fromEntries(taskRows.map((row: any) => [String(row.id), row]));
            proposal.unassigned = unassigned.map((row: any) => {
              const meta = taskMeta[String(row.task_id)] || {};
              const booking = meta.parking_bookings || {};
              return {
                ...row,
                task_type: row.task_type || meta.task_type,
                scheduled_at: row.scheduled_at || meta.scheduled_at,
                plate: booking.vehicle_plate || null,
                customer_name: booking.customer_name || null,
              };
            });
          }
        }
      }
      return response({ ok: true, job, proposal });
    }

    if (action === "status") {
      const jobId = String(body.job_id || "");
      if (!jobId) throw new AppError("job_id_required");
      const rows = await rest("optimization_jobs", "GET", undefined, {
        id: `eq.${jobId}`,
        created_by_telegram_user_id: `eq.${actor}`,
        select: "id,status,solver_version,horizon_start,horizon_end,progress,metrics,result_plan_id,error_code,attempt,max_attempts,started_at,finished_at,created_at,updated_at",
        limit: "1",
      });
      if (!rows.length) throw new AppError("job_not_found", 404);
      const job = rows[0];
      let proposal = null;
      if (job.status === "succeeded" && job.result_plan_id) {
        const plans = await rest("ai_dispatch_plans", "GET", undefined, {
          id: `eq.${job.result_plan_id}`,
          created_by_telegram_user_id: `eq.${actor}`,
          select: "id,status,solver_engine,horizon_start,horizon_end,plan,reports,created_at",
          limit: "1",
        });
        if (plans.length && plans[0].status === "proposal") {
          proposal = {
            plan_id: plans[0].id,
            status: plans[0].status,
            solver_engine: plans[0].solver_engine,
            horizon_start: plans[0].horizon_start,
            horizon_end: plans[0].horizon_end,
            created_at: plans[0].created_at,
            ...(plans[0].plan || {}),
            reports: plans[0].reports || {},
          };
          const unassigned = Array.isArray(proposal.unassigned) ? proposal.unassigned : [];
          const ids = unassigned.map((row: any) => String(row.task_id || "")).filter(Boolean);
          if (ids.length) {
            const taskRows = await rest("reservation_tasks", "GET", undefined, {
              id: `in.(${ids.join(",")})`,
              select: "id,task_type,scheduled_at,parking_bookings!inner(vehicle_plate,customer_name,pickup_terminal,return_terminal)",
            });
            const taskMeta = Object.fromEntries(taskRows.map((row: any) => [String(row.id), row]));
            proposal.unassigned = unassigned.map((row: any) => {
              const meta = taskMeta[String(row.task_id)] || {};
              const booking = meta.parking_bookings || {};
              return {
                ...row,
                task_type: row.task_type || meta.task_type,
                scheduled_at: row.scheduled_at || meta.scheduled_at,
                plate: booking.vehicle_plate || null,
                customer_name: booking.customer_name || null,
              };
            });
          }
        }
      }
      return response({ ok: true, job, proposal });
    }


    if (action === "config_get") {
      const users = await rest("telegram_users", "GET", undefined, {
        telegram_user_id: `eq.${actor}`,
        active: "eq.true",
        select: "telegram_user_id,role",
        limit: "1",
      });
      const user = users[0];
      if (!user || !["owner", "admin"].includes(String(user.role))) throw new AppError("not_admin", 403);
      const dashboard = await rpc("parking_booking_dashboard", {
        p_actor_telegram_user_id: actor, p_query: "", p_limit: 1, p_offset: 0,
      });
      const cfgRows = await rest("ai_dispatch_config", "GET", undefined, {
        id: "eq.1",
        select: OPTIMIZER_CONFIG_FIELDS.join(","),
        limit: "1",
      });
      return response({
        ok: true,
        config: cfgRows[0] || OPTIMIZER_DEFAULTS,
        defaults: OPTIMIZER_DEFAULTS,
        permission: dashboard?.permission || null,
      });
    }

    if (action === "config_update") {
      const epoch = Number(body.writer_epoch);
      await rpc("parking_booking_require_writer", { p_actor_telegram_user_id: actor, p_writer_epoch: epoch });
      const incoming = body.config && typeof body.config === "object" ? body.config : {};
      const patch: Record<string, unknown> = {};
      for (const key of OPTIMIZER_CONFIG_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(incoming, key)) patch[key] = incoming[key];
      }
      if (!Object.keys(patch).length) throw new AppError("optimizer_config_empty");

      const mode = String(patch.back_forward_mode ?? "fast");
      const work = String(patch.global_work_mode ?? "max_effort");
      if (!["fast", "optimal"].includes(mode)) throw new AppError("optimizer_config_invalid");
      if (!["normal", "intensive", "max_effort"].includes(work)) throw new AppError("optimizer_config_invalid");

      const ints = [
        "company_shuttle_vehicle_count","company_shuttle_passenger_capacity",
        "normal_shift_duration_minutes","intensive_shift_duration_minutes","max_effort_shift_duration_minutes",
        "normal_rest_minutes","intensive_rest_minutes","max_effort_rest_minutes",
        "back_forward_window_minutes","back_forward_overlap_minutes",
        "back_forward_candidate_step_minutes","back_forward_max_anchor_candidates",
      ];
      for (const key of ints) if (key in patch) {
        const n = Number(patch[key]);
        if (!Number.isInteger(n)) throw new AppError("optimizer_config_invalid");
        patch[key] = n;
      }
      for (const key of ["back_forward_optimal_explore_ratio","optimizer_time_limit_seconds"]) if (key in patch) {
        const n = Number(patch[key]);
        if (!Number.isFinite(n)) throw new AppError("optimizer_config_invalid");
        patch[key] = n;
      }
      patch.updated_at = new Date().toISOString();
      const rows = await rest("ai_dispatch_config", "PATCH", patch, { id: "eq.1" });
      return response({ ok: true, config: rows?.[0] || patch });
    }

    if (action === "config_reset") {
      const epoch = Number(body.writer_epoch);
      await rpc("parking_booking_require_writer", { p_actor_telegram_user_id: actor, p_writer_epoch: epoch });
      const rows = await rest("ai_dispatch_config", "PATCH", {
        ...OPTIMIZER_DEFAULTS,
        updated_at: new Date().toISOString(),
      }, { id: "eq.1" });
      return response({ ok: true, config: rows?.[0] || OPTIMIZER_DEFAULTS, defaults: OPTIMIZER_DEFAULTS });
    }

    if (action === "cancel") {
      const jobId = String(body.job_id || "");
      if (!jobId) throw new AppError("job_id_required");
      const ok = await rpc("cancel_optimization_job", { p_job_id: jobId, p_actor_telegram_user_id: actor });
      return response({ ok: true, cancelled_or_requested: Boolean(ok) });
    }

    throw new AppError("invalid_action");
  } catch (error) {
    console.error(error);
    const appError = error as AppError;
    return response({ ok: false, error: String(appError?.message || error) }, appError?.status || 500);
  }
});
