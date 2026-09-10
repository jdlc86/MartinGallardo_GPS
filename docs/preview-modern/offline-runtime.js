(function () {
  if (window.__PMG_OFFLINE_RUNTIME__) return;
  window.__PMG_OFFLINE_RUNTIME__ = true;

  const nativeFetch = window.fetch.bind(window);
  const BACKEND_HEALTH = "https://mvexykcxnpaywkbnoxwu.supabase.co/functions/v1/connectivity-health";
  const STATIC_PING = "connectivity-ping.txt";
  let banner = null;
  let timer = null;
  let connectivityState = "unknown";
  let probePromise = null;
  let lastProbeAt = 0;\n  let recoveryTimer = null;

  function ensureStyles() {
    if (document.getElementById("pmg-connectivity-style")) return;
    const style = document.createElement("style");
    style.id = "pmg-connectivity-style";
    style.textContent = `
      #pmg-connectivity-banner{position:fixed;z-index:2147483540;left:50%;top:calc(62px + env(safe-area-inset-top));width:max-content;max-width:calc(100vw - 24px);display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;font:750 10.5px/1.35 system-ui,-apple-system,sans-serif;text-align:left;box-shadow:var(--pmg-control-shadow,0 10px 30px rgba(0,0,0,.22));transform:translate(-50%,-10px) scale(.98);opacity:0;transition:transform .2s ease,opacity .2s ease;background:var(--pmg-surface,#101d30);color:var(--pmg-text,#fff);border:1px solid var(--pmg-border,#ffffff22);pointer-events:none}
      #pmg-connectivity-banner.visible{transform:translate(-50%,0) scale(1);opacity:1}
      #pmg-connectivity-banner[data-state="offline"]{background:var(--pmg-surface,#101d30);border-color:color-mix(in srgb,var(--pmg-danger,#dc2626) 44%,var(--pmg-border,#ffffff22))}
      #pmg-connectivity-banner[data-state="backend_down"]{background:var(--pmg-surface,#101d30);border-color:color-mix(in srgb,var(--pmg-warning,#d97706) 42%,var(--pmg-border,#ffffff22))}
      #pmg-connectivity-banner[data-state="online"]{background:var(--pmg-surface,#101d30);border-color:color-mix(in srgb,var(--pmg-success,#10b981) 44%,var(--pmg-border,#ffffff22))}
      #pmg-connectivity-banner .pmg-connectivity-icon{width:22px;height:22px;display:grid;place-items:center;flex:0 0 auto;border-radius:999px;background:var(--pmg-soft,#ffffff0b);font-size:11px}
      @media(max-width:480px){#pmg-connectivity-banner{top:calc(57px + env(safe-area-inset-top));max-width:calc(100vw - 20px);font-size:10px}}
      @media(prefers-reduced-motion:reduce){#pmg-connectivity-banner{transition:none}}
    `;
    document.head.appendChild(style);
  }

  function ensureBanner() {
    if (banner) return banner;
    ensureStyles();
    banner = document.createElement("div");
    banner.id = "pmg-connectivity-banner";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");
    document.documentElement.appendChild(banner);
    return banner;
  }

  function show(text, state, duration = 0) {
    clearTimeout(timer);
    const element = ensureBanner();
    element.dataset.state = state;
    element.setAttribute("aria-hidden", "false");
    const icon = state === "online" ? "✓" : state === "backend_down" ? "!" : "⌁";
    element.innerHTML = `<span class="pmg-connectivity-icon" aria-hidden="true">${icon}</span><span>${text}</span>`;
    element.classList.add("visible");
    if (duration > 0) {
      timer = setTimeout(() => {
        element.classList.remove("visible");
        element.setAttribute("aria-hidden", "true");
      }, duration);
    }
  }

  function scheduleRecovery(delayMs) {
    clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      probe(true).catch(() => {});
    }, delayMs);
  }

  function applyState(next) {
    const previous = connectivityState;
    connectivityState = next;
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
    if (next === "offline") {
      show("Sin conexión a Internet. Operaciones en pausa.", "offline", 0);
      scheduleRecovery(15000);
      return;
    }
    if (next === "backend_down") {
      show("No se puede conectar con el servidor. Reintentando…", "backend_down", 0);
      scheduleRecovery(12000);
      return;
    }
    if (next === "online") {
      if (previous !== "online" && previous !== "unknown") show("Conexión restablecida", "online", 2600);
      else if (banner) {
        banner.classList.remove("visible");
        banner.setAttribute("aria-hidden", "true");
      }
      if (previous !== "online") window.dispatchEvent(new CustomEvent("pmg:online"));
    }
  }

  async function fetchWithTimeout(url, timeoutMs) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await nativeFetch(url, { cache: "no-store", signal: ctrl.signal });
    } finally {
      clearTimeout(id);
    }
  }

  async function probeStaticReachability() {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const staticUrl = new URL(STATIC_PING, location.href);
        staticUrl.searchParams.set("_", String(Date.now()) + "-" + attempt);
        const r = await fetchWithTimeout(staticUrl.toString(), attempt === 1 ? 2500 : 3500);
        if (r.ok) return true;
      } catch {}
      if (attempt === 1) await new Promise(resolve => setTimeout(resolve, 350));
    }
    return false;
  }

  async function probeBackendReachability() {
    const timeouts = [3000, 5500];
    for (let attempt = 0; attempt < timeouts.length; attempt += 1) {
      try {
        const healthUrl = new URL(BACKEND_HEALTH);
        healthUrl.searchParams.set("_", String(Date.now()) + "-" + (attempt + 1));
        const r = await fetchWithTimeout(healthUrl.toString(), timeouts[attempt]);
        if (r.ok) return true;
      } catch {}
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  }

  async function probe(force = false) {
    const now = Date.now();
    if (!force && probePromise) return probePromise;
    if (!force && now - lastProbeAt < 2500 && connectivityState !== "unknown") return connectivityState;
    lastProbeAt = now;

    probePromise = (async () => {
      const internetOk = await probeStaticReachability();

      if (!internetOk) {
        applyState("offline");
        return "offline";
      }

      const backendOk = await probeBackendReachability();

      applyState(backendOk ? "online" : "backend_down");
      return backendOk ? "online" : "backend_down";
    })().finally(() => { probePromise = null; });

    return probePromise;
  }

  function online() {
    return probe(true);
  }

  function offline() {
    probe(true).catch(() => applyState("offline"));
  }

  window.PMGConnectivity = {
    check: probe,
    online,
    offline,
    get state() { return connectivityState; }
  };

  window.addEventListener("offline", () => probe(true).catch(() => applyState("offline")));
  window.addEventListener("online", () => probe(true));

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => probe(true), { once: true });
  } else {
    probe(true);
  }

  window.fetch = async function () {
    try {
      return await nativeFetch.apply(window, arguments);
    } catch (error) {
      const message = String(error?.message || error).toLowerCase();
      if (!navigator.onLine || message.includes("fetch") || message.includes("network") || message.includes("load failed")) {
        await probe(true).catch(() => {});
      }
      throw error;
    }
  };
})();