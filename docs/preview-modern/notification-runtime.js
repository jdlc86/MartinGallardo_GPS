(function () {
  if (window.__PMG_NOTIFICATIONS__) return;
  window.__PMG_NOTIFICATIONS__ = true;

  const API = "https://mvexykcxnpaywkbnoxwu.supabase.co/functions/v1/reservation-task-api";
  const SUPABASE_URL = "https://mvexykcxnpaywkbnoxwu.supabase.co";
  const SUPABASE_KEY = "sb_publishable_CtdeA8WPS-9bQhAC7_8e_w_5sBiNktm";
  let notices = [];
  let client;
  let channels = [];
  let pollTimer;
  let previousOverflow = "";

  const telegram = () => window.Telegram?.WebApp;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);

  function ensureStyles() {
    if (document.getElementById("pmg-notice-style")) return;
    const style = document.createElement("style");
    style.id = "pmg-notice-style";
    style.textContent = `
      html.pmg-notifications-mounted .pmg-theme-control{right:66px!important}
      html.pmg-notifications-mounted .pmg-theme-panel{right:66px!important}
      #pmg-notice-bell{position:fixed!important;z-index:2147483500!important;right:12px!important;top:calc(10px + env(safe-area-inset-top))!important;width:42px!important;height:42px!important;display:grid!important;place-items:center!important;border-radius:14px!important;border:1px solid var(--pmg-border,#ffffff22)!important;background:color-mix(in srgb,var(--pmg-surface,#101d30) 94%,transparent)!important;color:var(--pmg-text,#fff)!important;box-shadow:var(--pmg-control-shadow,0 8px 28px #0005)!important;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);font-size:18px!important;padding:0!important;transition:transform .16s ease,border-color .16s ease,background-color .16s ease!important}
      #pmg-notice-bell:active{transform:translateY(1px) scale(.98)}
      #pmg-notice-bell[aria-expanded="true"]{border-color:color-mix(in srgb,var(--pmg-accent,#2563eb) 58%,var(--pmg-border,#ffffff22))!important;background:var(--pmg-info-soft,#2563eb18)!important}
      #pmg-notice-count{position:absolute;right:-5px;top:-6px;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:var(--pmg-danger,#dc2626);color:#fff;display:grid;place-items:center;font-size:9px;font-weight:950;border:2px solid var(--pmg-bg,#08111f);box-shadow:0 4px 10px color-mix(in srgb,var(--pmg-danger,#dc2626) 35%,transparent)}
      #pmg-notice-count[hidden]{display:none!important}
      #pmg-notice-panel{position:fixed;inset:0;z-index:2147483550;background:var(--pmg-overlay,#020617b8);display:flex;align-items:flex-end;padding-top:env(safe-area-inset-top);animation:pmg-notice-fade .16s ease-out}
      #pmg-notice-panel .pmg-notice-box{width:min(100%,640px);max-height:min(86vh,760px);overflow:hidden;margin:0 auto;background:var(--pmg-surface,#101d30);color:var(--pmg-text,#fff);border:1px solid var(--pmg-border,#ffffff22);border-radius:26px 26px 0 0;box-shadow:0 -18px 70px var(--pmg-shadow,#0006);display:grid;grid-template-rows:auto minmax(0,1fr);animation:pmg-notice-rise .2s ease-out}
      #pmg-notice-panel .pmg-notice-head{padding:17px 16px 13px;border-bottom:1px solid var(--pmg-border,#ffffff22);background:color-mix(in srgb,var(--pmg-surface,#101d30) 94%,transparent);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
      #pmg-notice-panel .pmg-notice-head-row{display:flex;align-items:center;gap:12px}
      #pmg-notice-panel .pmg-notice-title-icon{width:40px;height:40px;border-radius:14px;display:grid;place-items:center;background:var(--pmg-info-soft,#2563eb18);color:var(--pmg-info-text,#bfdbfe);font-size:18px;flex:0 0 auto}
      #pmg-notice-panel .pmg-notice-heading{min-width:0;flex:1}
      #pmg-notice-panel .pmg-notice-kicker{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--pmg-accent-text,#7dd3fc);font-weight:900}
      #pmg-notice-panel h3{margin:2px 0 0;font-size:21px;letter-spacing:-.025em}
      #pmg-notice-panel .pmg-notice-close{width:38px;height:38px;display:grid;place-items:center;border:1px solid var(--pmg-border,#ffffff22);border-radius:13px;background:var(--pmg-soft,#ffffff0d);color:inherit;font-size:21px;line-height:1}
      #pmg-notice-panel .pmg-notice-summary{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:13px}
      #pmg-notice-panel .pmg-notice-summary span{color:var(--pmg-muted,#9db0c8);font-size:11px}
      #pmg-notice-panel .pmg-mark-all{border:0;background:transparent;color:var(--pmg-accent-text,#7dd3fc);font:850 10px/1.2 system-ui;padding:7px 0}
      #pmg-notice-panel .pmg-mark-all[hidden]{display:none}
      #pmg-notice-panel .pmg-notice-list{overflow:auto;overscroll-behavior:contain;padding:10px 12px calc(18px + env(safe-area-inset-bottom));scrollbar-width:thin;scrollbar-color:var(--pmg-border,#ffffff22) transparent}
      .pmg-notice{position:relative;display:grid;grid-template-columns:38px minmax(0,1fr);gap:11px;padding:13px;border-radius:17px;border:1px solid var(--pmg-border,#ffffff22);background:var(--pmg-soft,#ffffff08);margin-top:8px;transition:border-color .16s ease,background-color .16s ease}
      .pmg-notice:first-child{margin-top:0}
      .pmg-notice.unread{border-color:color-mix(in srgb,var(--pmg-accent,#2563eb) 42%,var(--pmg-border,#ffffff22));background:var(--pmg-info-soft,#2563eb18)}
      .pmg-notice.unread:after{content:"";position:absolute;right:11px;top:11px;width:7px;height:7px;border-radius:999px;background:var(--pmg-accent,#2563eb);box-shadow:0 0 0 4px color-mix(in srgb,var(--pmg-accent,#2563eb) 14%,transparent)}
      .pmg-notice .pmg-notice-icon{width:38px;height:38px;border-radius:13px;display:grid;place-items:center;background:var(--pmg-surface-2,#16243d);font-size:16px}
      .pmg-notice .pmg-notice-copy{min-width:0;padding-right:7px}
      .pmg-notice b{display:block;font-size:12px;line-height:1.35}
      .pmg-notice p{white-space:pre-line;margin:5px 0 0;color:var(--pmg-muted,#9db0c8);font-size:10.5px;line-height:1.5}
      .pmg-notice time{display:block;margin-top:8px;color:var(--pmg-muted,#9db0c8);font-size:9px;font-weight:700}
      .pmg-notice .pmg-notice-action{display:inline-flex;align-items:center;justify-content:center;min-height:34px;margin-top:10px;padding:8px 11px;border-radius:11px;background:var(--pmg-accent,#2563eb);color:var(--pmg-on-accent,#fff);text-decoration:none;font-size:9.5px;font-weight:900}
      .pmg-notice-empty{padding:34px 20px;text-align:center;color:var(--pmg-muted,#9db0c8)}
      .pmg-notice-empty .icon{width:54px;height:54px;margin:0 auto 12px;border-radius:18px;display:grid;place-items:center;background:var(--pmg-soft,#ffffff0d);font-size:23px}
      .pmg-notice-empty b{display:block;color:var(--pmg-text,#fff);font-size:13px}
      .pmg-notice-empty p{margin:5px auto 0;max-width:290px;font-size:10.5px;line-height:1.5}
      @media(min-width:700px){#pmg-notice-panel{align-items:center;padding:24px}#pmg-notice-panel .pmg-notice-box{border-radius:26px;box-shadow:0 24px 90px var(--pmg-shadow,#0008)}}
      @media(max-width:480px){html.pmg-notifications-mounted .pmg-theme-control{right:62px!important}html.pmg-notifications-mounted .pmg-theme-panel{right:10px!important}#pmg-notice-bell{right:10px!important;top:calc(8px + env(safe-area-inset-top))!important;width:40px!important;height:40px!important}.pmg-notice{padding:12px 11px}}
      @media(prefers-reduced-motion:reduce){#pmg-notice-panel,#pmg-notice-panel .pmg-notice-box{animation:none}}
      @keyframes pmg-notice-fade{from{opacity:0}to{opacity:1}}
      @keyframes pmg-notice-rise{from{transform:translateY(18px);opacity:.65}to{transform:none;opacity:1}}
    `;
    document.head.appendChild(style);
  }

  async function api(action, extra = {}) {
    const app = telegram();
    const response = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: app?.initData || "", action, ...extra }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || "network_error");
    return data;
  }

  function unreadCount() {
    return notices.filter((notice) => !notice.read_at).length;
  }

  function mountBell() {
    if (!document.body) return;
    ensureStyles();
    document.documentElement.classList.add("pmg-notifications-mounted");
    let button = document.getElementById("pmg-notice-bell");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.id = "pmg-notice-bell";
      button.setAttribute("aria-label", "Abrir notificaciones");
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-expanded", "false");
      button.innerHTML = '<span aria-hidden="true">🔔</span><span id="pmg-notice-count" hidden></span>';
      document.body.appendChild(button);
      button.addEventListener("click", openPanel);
    }
    const count = unreadCount();
    const badge = document.getElementById("pmg-notice-count");
    button.setAttribute("aria-label", count ? `Notificaciones, ${count} sin leer` : "Notificaciones");
    if (badge) {
      badge.hidden = count === 0;
      badge.textContent = count > 99 ? "99+" : String(count);
    }
  }

  function iconFor(type) {
    if (type.includes("task_reassignment") || type.includes("task_unassigned")) return "↻";
    if (type.includes("task_")) return "✓";
    if (type.includes("permission") || type.includes("write_") || type.includes("transfer")) return "◆";
    return "•";
  }

  function actionFor(type) {
    if (type.includes("task_")) return { label: "VER MIS TAREAS", href: "operations.html?v=20260901TASK3" };
    if (type.includes("permission") || type.includes("write_") || type.includes("transfer")) {
      return { label: "ABRIR GESTIÓN DE RESERVAS", href: "reservations-admin.html?v=20260901R3" };
    }
    return null;
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return new Intl.DateTimeFormat("es-ES", sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function renderNotice(notice) {
    const type = String(notice.notification_type || "system");
    const action = actionFor(type);
    return `<article class="pmg-notice ${notice.read_at ? "" : "unread"}" data-notice-id="${Number(notice.id)}">
      <div class="pmg-notice-icon" aria-hidden="true">${iconFor(type)}</div>
      <div class="pmg-notice-copy">
        <b>${escapeHtml(notice.title)}</b>
        <p>${escapeHtml(notice.body)}</p>
        <time datetime="${escapeHtml(notice.created_at)}">${escapeHtml(formatDate(notice.created_at))}</time>
        ${action ? `<a class="pmg-notice-action" href="${action.href}">${action.label}</a>` : ""}
      </div>
    </article>`;
  }

  function closePanel(returnFocus = false) {
    const panel = document.getElementById("pmg-notice-panel");
    if (!panel) return;
    panel.remove();
    document.body.style.overflow = previousOverflow;
    const bell = document.getElementById("pmg-notice-bell");
    bell?.setAttribute("aria-expanded", "false");
    if (returnFocus) bell?.focus({ preventScroll: true });
  }

  function updatePanelSummary() {
    const panel = document.getElementById("pmg-notice-panel");
    if (!panel) return;
    const unread = unreadCount();
    const summary = panel.querySelector(".pmg-notice-summary span");
    const markAll = panel.querySelector(".pmg-mark-all");
    if (summary) summary.textContent = unread
      ? `${unread} ${unread === 1 ? "aviso nuevo" : "avisos nuevos"}`
      : notices.length ? "Todo está al día" : "Sin avisos pendientes";
    if (markAll) markAll.hidden = unread === 0;
  }

  async function markAllRead(button) {
    const ids = notices.filter((notice) => !notice.read_at).map((notice) => Number(notice.id));
    if (!ids.length) return;
    button.disabled = true;
    try {
      await api("mark_notifications_read", { ids });
      const now = new Date().toISOString();
      notices.forEach((notice) => {
        if (ids.includes(Number(notice.id))) notice.read_at = now;
      });
      document.querySelectorAll(".pmg-notice.unread").forEach((notice) => notice.classList.remove("unread"));
      mountBell();
      updatePanelSummary();
    } catch {
      button.textContent = "NO SE PUDO ACTUALIZAR";
      setTimeout(() => { button.textContent = "MARCAR TODO COMO LEÍDO"; }, 1800);
    } finally {
      button.disabled = false;
    }
  }

  function openPanel() {
    mountBell();
    closePanel();
    document.querySelector(".pmg-theme-panel")?.classList.remove("on");
    const panel = document.createElement("div");
    panel.id = "pmg-notice-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "pmg-notice-title");
    panel.innerHTML = `<section class="pmg-notice-box">
      <header class="pmg-notice-head">
        <div class="pmg-notice-head-row">
          <div class="pmg-notice-title-icon" aria-hidden="true">🔔</div>
          <div class="pmg-notice-heading"><div class="pmg-notice-kicker">Centro de avisos</div><h3 id="pmg-notice-title">Notificaciones</h3></div>
          <button type="button" class="pmg-notice-close" aria-label="Cerrar notificaciones">×</button>
        </div>
        <div class="pmg-notice-summary"><span></span><button type="button" class="pmg-mark-all">MARCAR TODO COMO LEÍDO</button></div>
      </header>
      <div class="pmg-notice-list">${notices.length
        ? notices.map(renderNotice).join("")
        : '<div class="pmg-notice-empty"><div class="icon">✓</div><b>Todo está al día</b><p>Las nuevas asignaciones y solicitudes aparecerán aquí.</p></div>'}</div>
    </section>`;
    document.body.appendChild(panel);
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.getElementById("pmg-notice-bell")?.setAttribute("aria-expanded", "true");
    panel.querySelector(".pmg-notice-close")?.addEventListener("click", () => closePanel(true));
    panel.querySelector(".pmg-mark-all")?.addEventListener("click", (event) => markAllRead(event.currentTarget));
    panel.addEventListener("click", (event) => {
      if (event.target === panel) closePanel(true);
    });
    updatePanelSummary();
    panel.querySelector(".pmg-notice-close")?.focus({ preventScroll: true });
  }

  async function refresh() {
    const app = telegram();
    if (document.hidden || !app?.initData || !navigator.onLine) return;
    try {
      const data = await api("notifications");
      notices = Array.isArray(data.notifications) ? data.notifications : [];
      mountBell();
      const panel = document.getElementById("pmg-notice-panel");
      if (panel) {
        panel.querySelector(".pmg-notice-list").innerHTML = notices.length
          ? notices.map(renderNotice).join("")
          : '<div class="pmg-notice-empty"><div class="icon">✓</div><b>Todo está al día</b><p>Las nuevas asignaciones y solicitudes aparecerán aquí.</p></div>';
        updatePanelSummary();
      }
    } catch {
      mountBell();
    }
  }

  function loadRealtimeLibrary() {
    if (window.supabase?.createClient) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  async function connectRealtime() {
    try {
      await loadRealtimeLibrary();
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const onNotification = () => setTimeout(refresh, 120);
      const onTask = () => {
        window.dispatchEvent(new CustomEvent("pmg:reservation-task-change"));
        setTimeout(refresh, 250);
      };
      channels = [
        client.channel("reservation-notifications").on("broadcast", { event: "changed" }, onNotification).subscribe(),
        client.channel("reservation-tasks").on("broadcast", { event: "changed" }, onTask).subscribe(),
      ];
    } catch {
      // The periodic refresh below remains active as a fallback.
    }
  }

  function start() {
    mountBell();
    refresh();
    connectRealtime();
    setTimeout(refresh, 500);
    setTimeout(refresh, 1500);
    pollTimer = setInterval(refresh, 45_000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && document.getElementById("pmg-notice-panel")) closePanel(true);
    });
    window.addEventListener("pmg:online", refresh);
    window.addEventListener("pagehide", () => {
      clearInterval(pollTimer);
      if (client) channels.forEach((channel) => client.removeChannel(channel).catch(() => {}));
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
