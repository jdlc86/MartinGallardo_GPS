import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANALYTICS_ACCESS_TOKEN = Deno.env.get("ANALYTICS_ACCESS_TOKEN") || "";

const PROJECT_REF = "mvexykcxnpaywkbnoxwu";
const MANAGEMENT_API = "https://api.supabase.com/v1";
const SAMPLE_FUNCTION = {
  slug: "telegram-modern-action",
  id: "f87aac26-2211-46d2-8a0d-468565c58f41",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

async function requireMaintenanceSecret(req: Request) {
  const secret = req.headers.get("x-maintenance-secret") || "";
  if (!secret) return false;

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/validate_maintenance_runner_secret`,
    {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_secret: secret }),
    },
  );

  if (!response.ok) return false;
  return (await response.json().catch(() => false)) === true;
}

async function analyticsGet(path: string) {
  const response = await fetch(`${MANAGEMENT_API}/projects/${PROJECT_REF}/analytics/endpoints/${path}`, {
    headers: {
      Authorization: `Bearer ${ANALYTICS_ACCESS_TOKEN}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Keep the raw text so the probe exposes the real response shape.
  }
  return { status: response.status, ok: response.ok, body };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  try {
    if (!(await requireMaintenanceSecret(req))) {
      return json({ ok: false, error: "not_authorized" }, 403);
    }

    if (!ANALYTICS_ACCESS_TOKEN) {
      return json({ ok: false, error: "analytics_token_unavailable" }, 500);
    }

    const apiCounts = await analyticsGet("usage.api-counts");
    const apiRequestsCount = await analyticsGet("usage.api-requests-count");

    const combinedAttempts = [];
    for (const interval of ["1h", "1d", "7d", "30d"]) {
      const query = new URLSearchParams({
        interval,
        function_id: SAMPLE_FUNCTION.id,
      });
      const result = await analyticsGet(`functions.combined-stats?${query.toString()}`);
      combinedAttempts.push({ interval, ...result });
      if (result.ok) break;
    }

    return json({
      ok: true,
      project_ref: PROJECT_REF,
      api_counts: apiCounts,
      api_requests_count: apiRequestsCount,
      edge_function_sample: SAMPLE_FUNCTION,
      combined_stats_attempts: combinedAttempts,
    });
  } catch (error) {
    console.error(error);
    return json({
      ok: false,
      error: String((error as Error)?.message || error),
    }, 500);
  }
});
