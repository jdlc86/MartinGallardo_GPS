(function () {
  "use strict";

  if (window.__PMG_ASSIGNMENTS__) return;
  window.__PMG_ASSIGNMENTS__ = true;

  const path = location.pathname;
  const isHub = path.endsWith("/operations.html");
  const flowType = path.endsWith("/pickup.html")
    ? "pickup"
    : path.endsWith("/delivery.html")
      ? "delivery"
      : null;
  if (!isHub && !flowType) return;

  const API = "https://mvexykcxnpaywkbnoxwu.supabase.co/functions/v1/reservation-task-api";
  const TIME_ZONE = "Europe/Madrid";
  const LABELS = {
    pickup: { plural: "recogidas", title: "Recogida aeropuerto", action: "INICIAR RECOGIDA" },
    delivery: { plural: "entregas", title: "Entrega al cliente", action: "INICIAR ENTREGA" },
  };

  let tasks = [];
  let refreshTimer = 0;
  const telegram = () => window.Telegram?.WebApp;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function asDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function dateLabel(value, includeYear = false) {
    const date = asDate(value);
    if (!date) return "Fecha pendiente";
    return new Intl.DateTimeFormat("es-ES", {
      timeZone: TIME_ZONE,
      weekday: "short",
      day: "2-digit",
      month: "short",
      ...(includeYear ? { year: "numeric" } : {}),
    }).format(date);
  }

  function timeLabel(value) {
    const date = asDate(value);
    if (!date) return "--:--";
    return new Intl.DateTimeFormat("es-ES", {
      timeZone: TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function bookingDateTime(date, time) {
    if (!date) return "Pendiente";
    const [year, month, day] = String(date).split("-").map(Number);
    if (!year || !month || !day) return `${date}${time ? ` · ${time}` : ""}`;
    const value = new Date(Date.UTC(year, month - 1, day, 12));
    return `${dateLabel(value, true)} · ${String(time || "--:--").slice(0, 5)}`;
  }

  function money(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "—";
    return amount.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
  }

  function paymentLabel(value) {
    const normalized = String(value || "").toLowerCase();
    if (normalized.includes("cash") || normalized.includes("efect")) return "Efectivo";
    if (normalized.includes("card") || normalized.includes("tarjet") || normalized.includes("credit")) return "Tarjeta";
    return value || "Sin indicar";
  }

  function ordered(type) {
    return tasks
      .filter((task) => task.type === type && task.status === "assigned")
      .sort((left, right) => {
        const a = asDate(left.scheduled_at)?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const b = asDate(right.scheduled_at)?.getTime() ?? Number.MAX_SAFE_INTEGER;
        return a - b;
      });
  }

  function injectStyles() {
    if (document.getElementById("pmg-assignment-style")) return;
    const style = document.createElement("style");
    style.id = "pmg-assignment-style";
    style.textContent = `
      .pmg-op-assigned{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px;padding-top:8px;border-top:1px solid color-mix(in srgb,var(--pmg-border) 72%,transparent);font-size:9px;font-weight:850;color:var(--pmg-accent-text)}
      .pmg-op-assigned strong{min-width:20px;height:20px;padding:0 6px;border-radius:999px;display:grid;place-items:center;background:var(--pmg-accent);color:#fff;font-size:10px;box-shadow:0 5px 14px color-mix(in srgb,var(--pmg-accent) 28%,transparent)}
      .pmg-op-assigned span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .action.has-assigned{border-color:color-mix(in srgb,var(--pmg-accent) 48%,var(--pmg-border));box-shadow:0 13px 30px color-mix(in srgb,var(--pmg-accent) 9%,transparent)}
      .pmg-assigned{margin-top:17px;padding-top:15px;border-top:1px solid var(--pmg-border)}
      .pmg-assigned-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
      .pmg-assigned-head h3{font-size:13px;margin:0 0 3px;letter-spacing:-.01em}
      .pmg-assigned-head p{font-size:9px;color:var(--pmg-muted);margin:0}
      .pmg-count{min-width:25px;height:25px;padding:0 8px;border-radius:999px;display:grid;place-items:center;background:var(--pmg-accent);color:#fff;font-size:10px;font-weight:950;box-shadow:0 6px 16px color-mix(in srgb,var(--pmg-accent) 25%,transparent)}
      .pmg-job{width:100%;border:1px solid var(--pmg-border);background:linear-gradient(145deg,var(--pmg-surface-2),var(--pmg-surface));color:var(--pmg-text);border-radius:15px;padding:11px 10px;display:grid;grid-template-columns:34px 48px minmax(0,1fr) auto;gap:8px;align-items:center;text-align:left;margin-top:7px;box-shadow:0 8px 22px color-mix(in srgb,#000 5%,transparent);cursor:pointer}
      .pmg-job:active{transform:scale(.992)}
      .pmg-job-seq{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;background:var(--pmg-soft);color:var(--pmg-accent-text);font-size:9px;font-weight:950}
      .pmg-job-time{font-weight:950;font-size:13px;letter-spacing:-.02em}
      .pmg-job-main{min-width:0}
      .pmg-job-main b{display:block;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pmg-job-main small{display:block;color:var(--pmg-muted);font-size:8px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pmg-job-terminal{max-width:70px;font-size:8px;font-weight:850;color:var(--pmg-accent-text);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pmg-assigned-empty,.pmg-assigned-error{border:1px dashed var(--pmg-border);border-radius:14px;padding:13px;text-align:center;color:var(--pmg-muted);font-size:9px;background:var(--pmg-surface-2)}
      .pmg-assigned-error{color:var(--pmg-danger,#b44)}
      .pmg-manual-divider{display:flex;align-items:center;gap:9px;margin:14px 0 2px;color:var(--pmg-muted);font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.06em}
      .pmg-manual-divider::before,.pmg-manual-divider::after{content:"";height:1px;flex:1;background:var(--pmg-border)}
      #pmg-job-modal{position:fixed;inset:0;z-index:2147483600;background:rgba(4,8,17,.66);backdrop-filter:blur(8px);display:flex;align-items:flex-end;padding-top:env(safe-area-inset-top);animation:pmgFade .18s ease-out}
      #pmg-job-modal .pmg-job-sheet{width:min(100%,620px);max-height:92dvh;overflow:auto;margin:0 auto;background:var(--pmg-surface);color:var(--pmg-text);border:1px solid var(--pmg-border);border-bottom:0;border-radius:25px 25px 0 0;padding:10px 16px calc(18px + env(safe-area-inset-bottom));box-shadow:0 -22px 60px rgba(0,0,0,.24);animation:pmgSheet .22s ease-out}
      .pmg-sheet-handle{width:38px;height:4px;border-radius:9px;background:var(--pmg-border);margin:1px auto 13px}
      .pmg-sheet-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
      .pmg-sheet-kicker{font-size:8px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:var(--pmg-accent-text)}
      #pmg-job-modal h3{margin:3px 0 2px;font-size:23px;letter-spacing:-.04em}
      .pmg-sheet-sub{font-size:10px;color:var(--pmg-muted)}
      .pmg-sheet-close{width:32px;height:32px;border:1px solid var(--pmg-border);border-radius:11px;background:var(--pmg-soft);color:var(--pmg-text);font-size:18px;line-height:1;cursor:pointer}
      .pmg-sheet-primary{margin:15px 0 9px;padding:13px;border-radius:16px;background:linear-gradient(135deg,color-mix(in srgb,var(--pmg-accent) 14%,var(--pmg-surface)),var(--pmg-surface-2));border:1px solid color-mix(in srgb,var(--pmg-accent) 35%,var(--pmg-border));display:grid;grid-template-columns:1fr 1fr;gap:11px}
      .pmg-sheet-primary span,.pmg-detail-row span{display:block;color:var(--pmg-muted);font-size:8px;margin-bottom:3px}
      .pmg-sheet-primary b{display:block;font-size:11px}
      .pmg-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .pmg-detail-row{min-width:0;padding:10px;border:1px solid var(--pmg-border);border-radius:13px;background:var(--pmg-surface-2)}
      .pmg-detail-row.wide{grid-column:1/-1}
      .pmg-detail-row b{display:block;font-size:10px;overflow-wrap:anywhere}
      .pmg-sheet-actions{display:grid;grid-template-columns:1fr;gap:8px;margin-top:14px}
      .pmg-sheet-actions a,.pmg-sheet-actions button{min-height:44px;border-radius:14px;display:grid;place-items:center;text-decoration:none;font-size:10px;font-weight:950;letter-spacing:.02em;cursor:pointer}
      .pmg-sheet-actions .pmg-start{border:0;background:var(--pmg-accent);color:#fff;box-shadow:0 10px 24px color-mix(in srgb,var(--pmg-accent) 27%,transparent)}
      .pmg-sheet-actions .pmg-call{border:1px solid var(--pmg-border);background:var(--pmg-soft);color:var(--pmg-text)}
      @keyframes pmgFade{from{opacity:0}to{opacity:1}}
      @keyframes pmgSheet{from{transform:translateY(24px)}to{transform:translateY(0)}}
      @media(max-width:380px){.pmg-job{grid-template-columns:29px 43px minmax(0,1fr)}.pmg-job-terminal{display:none}.pmg-detail-grid{grid-template-columns:1fr}.pmg-detail-row.wide{grid-column:auto}}
      @media(prefers-reduced-motion:reduce){#pmg-job-modal,#pmg-job-modal .pmg-job-sheet{animation:none}.pmg-job:active{transform:none}}
    `;
    document.head.appendChild(style);
  }

  async function api(action) {
    const response = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: telegram()?.initData || "", action }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || "network_error");
    return payload;
  }

  function renderHubType(type) {
    const card = document.querySelector(`.action[data-action="${type}"]`);
    if (!card) return;
    card.querySelector(".pmg-op-assigned")?.remove();
    card.classList.remove("has-assigned");
    const mine = ordered(type);
    if (!mine.length) return;
    const next = mine[0];
    const badge = document.createElement("span");
    badge.className = "pmg-op-assigned";
    badge.innerHTML = `<strong>${mine.length}</strong><span>${escapeHtml(timeLabel(next.scheduled_at))} · ${escapeHtml(next.plate || next.customer_name || "Próxima tarea")}</span>`;
    card.appendChild(badge);
    card.classList.add("has-assigned");
  }

  function renderHub() {
    renderHubType("pickup");
    renderHubType("delivery");
  }

  function ensureFlowHost() {
    let host = document.getElementById("pmg-assigned");
    if (host) return host;
    const panel = document.getElementById("p1");
    if (!panel) return null;
    host = document.createElement("section");
    host.id = "pmg-assigned";
    host.className = "pmg-assigned";
    const plate = document.getElementById("plate");
    const plateContainer = plate?.closest("label, .field, .input-wrap") || plate;
    if (plateContainer?.parentNode) {
      plateContainer.parentNode.insertBefore(host, plateContainer);
      const divider = document.createElement("div");
      divider.className = "pmg-manual-divider";
      divider.textContent = "O introducir matrícula manualmente";
      plateContainer.parentNode.insertBefore(divider, plateContainer);
    } else {
      panel.appendChild(host);
    }
    return host;
  }

  function renderFlow(error = false) {
    const host = ensureFlowHost();
    if (!host) return;
    const mine = ordered(flowType);
    const label = LABELS[flowType];
    const header = `<div class="pmg-assigned-head"><div><h3>Mis ${label.plural} asignadas</h3><p>Orden de ejecución por fecha y hora</p></div><span class="pmg-count">${mine.length}</span></div>`;
    if (error) {
      host.innerHTML = `${header}<div class="pmg-assigned-error">No se pudieron actualizar las tareas. Puedes continuar con la matrícula manual.</div>`;
      return;
    }
    if (!mine.length) {
      host.innerHTML = `${header}<div class="pmg-assigned-empty">No tienes tareas pendientes asignadas. Puedes continuar de forma manual.</div>`;
      return;
    }
    host.innerHTML = header + mine.map((task, index) => `
      <button class="pmg-job" type="button" data-task="${escapeHtml(task.id)}" aria-label="Abrir tarea ${index + 1}: ${escapeHtml(task.plate || task.customer_name || "sin matrícula")}">
        <span class="pmg-job-seq">${String(index + 1).padStart(2, "0")}</span>
        <span class="pmg-job-time">${escapeHtml(timeLabel(task.scheduled_at))}</span>
        <span class="pmg-job-main"><b>${escapeHtml(task.plate || "Matrícula pendiente")} · ${escapeHtml(task.customer_name || "Cliente sin indicar")}</b><small>${escapeHtml(dateLabel(task.scheduled_at))} · ${escapeHtml(task.vehicle_make_model || "Vehículo sin indicar")}</small></span>
        <span class="pmg-job-terminal">${escapeHtml(task.terminal || "Terminal —")}</span>
      </button>
    `).join("");
    host.querySelectorAll("[data-task]").forEach((button) => {
      button.addEventListener("click", () => openTask(mine.find((task) => task.id === button.dataset.task), mine));
    });
  }

  function detailRow(label, value, wide = false) {
    return `<div class="pmg-detail-row${wide ? " wide" : ""}"><span>${escapeHtml(label)}</span><b>${escapeHtml(value || "—")}</b></div>`;
  }

  function closeTask() {
    const modal = document.getElementById("pmg-job-modal");
    if (!modal) return;
    modal.remove();
    document.body.style.overflow = modal.dataset.previousOverflow || "";
  }

  function startTask(task) {
    const plate = document.getElementById("plate");
    if (plate) {
      plate.value = task.plate || "";
      plate.dispatchEvent(new Event("input", { bubbles: true }));
      plate.dispatchEvent(new Event("change", { bubbles: true }));
    }
    window.__PMG_ACTIVE_RESERVATION_TASK__ = {
      id: task.id,
      type: task.type,
      booking_id: task.booking_id,
    };
    closeTask();
    telegram()?.HapticFeedback?.impactOccurred?.("medium");
    requestAnimationFrame(() => document.getElementById(flowType === "pickup" ? "start" : "find")?.click());
  }

  function openTask(task, mine) {
    if (!task) return;
    closeTask();
    const position = Math.max(0, mine.findIndex((item) => item.id === task.id)) + 1;
    const label = LABELS[flowType];
    const modal = document.createElement("div");
    modal.id = "pmg-job-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", `${label.title}: ${task.plate || task.customer_name || "tarea asignada"}`);
    modal.dataset.previousOverflow = document.body.style.overflow;
    const relatedLabel = flowType === "pickup" ? "Regreso previsto" : "Recogida original";
    const relatedValue = flowType === "pickup"
      ? `${bookingDateTime(task.return_date, task.return_time)} · ${task.return_terminal || "Terminal pendiente"}`
      : `${bookingDateTime(task.pickup_date, task.pickup_time)} · ${task.pickup_terminal || "Terminal pendiente"}`;
    const phone = String(task.customer_phone || "").trim();
    const dialPhone = phone.replace(/[^+\d]/g, "");
    const callAction = phone
      ? `<a class="pmg-call" href="tel:${escapeHtml(dialPhone)}">LLAMAR AL CLIENTE · ${escapeHtml(phone)}</a>`
      : "";
    modal.innerHTML = `
      <div class="pmg-job-sheet">
        <div class="pmg-sheet-handle" aria-hidden="true"></div>
        <div class="pmg-sheet-top">
          <div><div class="pmg-sheet-kicker">${escapeHtml(label.title)} · Tarea ${position} de ${mine.length}</div><h3>${escapeHtml(task.plate || "Sin matrícula")}</h3><div class="pmg-sheet-sub">${escapeHtml(task.vehicle_make_model || "Vehículo sin indicar")}</div></div>
          <button class="pmg-sheet-close" type="button" aria-label="Cerrar">×</button>
        </div>
        <div class="pmg-sheet-primary">
          <div><span>Fecha y hora</span><b>${escapeHtml(dateLabel(task.scheduled_at, true))} · ${escapeHtml(timeLabel(task.scheduled_at))}</b></div>
          <div><span>Terminal</span><b>${escapeHtml(task.terminal || "Pendiente")}</b></div>
        </div>
        <div class="pmg-detail-grid">
          ${detailRow("Cliente", task.customer_name)}
          ${detailRow("Teléfono", task.customer_phone)}
          ${detailRow("E-mail", task.customer_email, true)}
          ${detailRow("Precio (IVA incl.)", money(task.price_eur))}
          ${detailRow("Pago", paymentLabel(task.payment_method))}
          ${detailRow(relatedLabel, relatedValue, true)}
        </div>
        <div class="pmg-sheet-actions">
          ${callAction}
          <button class="pmg-start" type="button">${escapeHtml(label.action)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    document.body.style.overflow = "hidden";
    modal.querySelector(".pmg-sheet-close")?.addEventListener("click", closeTask);
    modal.querySelector(".pmg-start")?.addEventListener("click", () => startTask(task));
    modal.addEventListener("click", (event) => { if (event.target === modal) closeTask(); });
    modal.querySelector(".pmg-sheet-close")?.focus();
  }

  function render(error = false) {
    injectStyles();
    if (isHub) renderHub();
    if (flowType) renderFlow(error);
  }

  async function refresh() {
    if (document.hidden) return;
    try {
      const payload = await api("mine");
      tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
      render(false);
    } catch {
      render(true);
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refresh, 180);
  }

  function start() {
    render(false);
    refresh();
    window.addEventListener("pmg:reservation-task-change", scheduleRefresh);
    window.addEventListener("pmg:online", scheduleRefresh);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleRefresh(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeTask(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
