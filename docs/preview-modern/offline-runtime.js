(function () {
  if (window.__PMG_OFFLINE_RUNTIME__) return;
  window.__PMG_OFFLINE_RUNTIME__ = true;

  const nativeFetch = window.fetch.bind(window);
  let banner = null;
  let timer = null;
  let connectivityState = navigator.onLine ? "online" : "offline";

  function ensureStyles() {
    if (document.getElementById("pmg-connectivity-style")) return;
    const style = document.createElement("style");
    style.id = "pmg-connectivity-style";
    style.textContent = `
      #pmg-connectivity-banner{position:fixed;z-index:2147483540;left:50%;right:auto;top:calc(62px + env(safe-area-inset-top));width:max-content;max-width:calc(100vw - 24px);display:flex;align-items:center;justify-content:flex-start;gap:8px;padding:8px 12px;border-radius:999px;font:750 10.5px/1.35 system-ui,-apple-system,sans-serif;text-align:left;box-shadow:var(--pmg-control-shadow,0 10px 30px rgba(0,0,0,.22));transform:translate(-50%,-10px) scale(.98);opacity:0;transition:transform .2s ease,opacity .2s ease;background:var(--pmg-surface,#101d30);color:var(--pmg-text,#fff);border:1px solid var(--pmg-border,#ffffff22);pointer-events:none;backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
      #pmg-connectivity-banner.visible{transform:translate(-50%,0) scale(1);opacity:1}
      #pmg-connectivity-banner[data-state="offline"]{background:color-mix(in srgb,var(--pmg-surface,#101d30) 86%,var(--pmg-danger,#dc2626));border-color:color-mix(in srgb,var(--pmg-danger,#dc2626) 44%,var(--pmg-border,#ffffff22));color:var(--pmg-text,#fff)}
      #pmg-connectivity-banner[data-state="unstable"]{background:color-mix(in srgb,var(--pmg-surface,#101d30) 88%,var(--pmg-warning,#d97706));border-color:color-mix(in srgb,var(--pmg-warning,#d97706) 42%,var(--pmg-border,#ffffff22));color:var(--pmg-text,#fff)}
      #pmg-connectivity-banner[data-state="online"]{background:color-mix(in srgb,var(--pmg-surface,#101d30) 86%,var(--pmg-success,#10b981));border-color:color-mix(in srgb,var(--pmg-success,#10b981) 44%,var(--pmg-border,#ffffff22));color:var(--pmg-text,#fff)}
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
    element.innerHTML = `<span class="pmg-connectivity-icon" aria-hidden="true">${state === "online" ? "✓" : state === "unstable" ? "!" : "⌁"}</span><span>${text}</span>`;
    element.classList.add("visible");
    if (duration > 0) {
      timer = setTimeout(() => {
        element.classList.remove("visible");
        element.setAttribute("aria-hidden", "true");
      }, duration);
    }
  }

  function offline(forcePersistent = false) {
    const persistent = forcePersistent || !navigator.onLine;
    connectivityState = persistent ? "offline" : "unstable";
    show(
      persistent ? "Sin conexión · Operaciones en pausa" : "Conexión inestable · Inténtalo de nuevo",
      connectivityState,
      persistent ? 0 : 4_200
    );
  }

  function online() {
    if (connectivityState === "online") return;
    connectivityState = "online";
    show("Conexión restablecida", "online", 2_600);
    window.dispatchEvent(new CustomEvent("pmg:online"));
  }

  window.PMGConnectivity = { offline, online };

  window.addEventListener("offline", () => offline(true));
  window.addEventListener("online", online);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      if (!navigator.onLine) offline();
    }, { once: true });
  } else if (!navigator.onLine) offline();

  window.fetch = async function () {
    try {
      const response = await nativeFetch.apply(window, arguments);
      if (connectivityState !== "online" && navigator.onLine) online();
      return response;
    } catch (error) {
      const message = String(error?.message || error).toLowerCase();
      if (!navigator.onLine || message.includes("fetch") || message.includes("network")) {
        offline(!navigator.onLine);
        throw new Error("network_error");
      }
      throw error;
    }
  };
})();
