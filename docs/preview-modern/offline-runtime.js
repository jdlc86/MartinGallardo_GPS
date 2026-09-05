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
  let lastProbeAt = 0;

  function ensureStyles() {
    if (document.getElementById("pmg-connectivity-style")) return;
    const style = document.createElement("style");
    style.id = "pmg-connectivity-style";
    style.textContent = `
      #pmg-connectivity-banner{position:fixed;z-index:2147483540;left:50%;top:calc(62px + env(safe-area-inset-top));width:max-content;max-width:calc(100vw - 24px);display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;font:750 10.5px/1.35 system-ui,-apple-system,sans-serif;text-align:left;box-shadow:var(--pmg-control-shadow,0 10px 30px rgba(0,0,0,.22));transform:translate(-50%,-10px) scale(.98);opacity:0;transition:transform .2s ease,opacity .2s ease;background:var(--pmg-surface,#101d30);color:var(--pmg-text,#fff);border:1px solid var(--pmg-border,#ffffff22);pointer-events:none;backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
      #pmg-connectivity-banner.visible{transform:translate(-50%,0) scale(1);opacity:1}
      #pmg-connectivity-banner[data-state="offline"]{background:color-mix(in srgb,var(--pmg-surface,#101d30) 86%,var(--pmg-danger,#dc2626));border-color:color-mix(in srgb,var(--pmg-danger,#dc2626) 44%,var(--pmg-border,#ffffff22))}
      #pmg-connectivity-banner[data-state="backend_down"]{background:color-mix(in srgb,var(--pmg-surface,#101d30) 88%,var(--pmg-warning,#d97706));border-color:color-mix(in srgb,var(--pmg-warning,#d97706) 42%,var(--pmg-border,#ffffff22))}
      #pmg-connectivity-banner[data-state="online"]{background:color-mix(in srgb,var(--pmg-surface,#101d30) 86%,var(--pmg-success,#10b981));border-color:color-mix(in srgb,var(--pmg-success,#10b981) 44%,var(--pmg-border,#ffffff22))}
      #pmg-connectivity-banner .pmg-connectivity-icon{width:22px;height:22px;display:grid;place-items:center;flex:0 0 auto;border-radius:999px;background:color-mix(in srgb,currentColor 10%,transparent);font-size:11px}
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

  function applyState(next) {
    const previous = connectivityState;
    connectivityState = next;
    if (next === "offline") {
      show("Sin Internet · Operaciones en pausa", "offline", 0);
      return;
    }
    if (next === "backend_down") {
      show("Internet disponible · servidor temporalmente no disponible", "backend_down", 0);
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

  async function probe(force = false) {
    const now = Date.now();
    if (!force && probePromise) return probePromise;
    if (!force && now - lastProbeAt < 2500 && connectivityState !== "unknown") return connectivityState;
    lastProbeAt = now;

    probePromise = (async () => {
      if (!navigator.onLine) {
        applyState("offline");
        return "offline";
      }

      let internetOk = false;
      try {
        const staticUrl = new URL(STATIC_PING, location.href);
        staticUrl.searchParams.set("_", String(Date.now()));
        const r = await fetchWithTimeout(staticUrl.toString(), 2500);
        internetOk = r.ok;
      } catch {}

      if (!internetOk) {
        applyState("offline");
        return "offline";
      }

      let backendOk = false;
      try {
        const healthUrl = new URL(BACKEND_HEALTH);
        healthUrl.searchParams.set("_", String(Date.now()));
        const r = await fetchWithTimeout(healthUrl.toString(), 3000);
        backendOk = r.ok;
      } catch {}

      applyState(backendOk ? "online" : "backend_down");
      return backendOk ? "online" : "backend_down";
    })().finally(() => { probePromise = null; });

    return probePromise;
  }

  function online() {
    return probe(true);
  }

  function offline() {
    applyState("offline");
  }

  window.PMGConnectivity = {
    check: probe,
    online,
    offline,
    get state() { return connectivityState; }
  };

  window.addEventListener("offline", () => applyState("offline"));
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