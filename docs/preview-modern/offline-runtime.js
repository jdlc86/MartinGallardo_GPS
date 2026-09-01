(function () {
  if (window.__PMG_OFFLINE_RUNTIME__) return;
  window.__PMG_OFFLINE_RUNTIME__ = true;

  const nativeFetch = window.fetch.bind(window);
  let banner = null;
  let timer = null;

  function ensureStyles() {
    if (document.getElementById("pmg-connectivity-style")) return;
    const style = document.createElement("style");
    style.id = "pmg-connectivity-style";
    style.textContent = `
      #pmg-connectivity-banner{position:fixed;z-index:2147483540;left:12px;right:12px;top:calc(62px + env(safe-area-inset-top));margin:auto;max-width:620px;display:flex;align-items:center;justify-content:center;gap:9px;padding:10px 13px;border-radius:14px;font:800 11px/1.4 system-ui,-apple-system,sans-serif;text-align:left;box-shadow:var(--pmg-control-shadow,0 12px 34px rgba(0,0,0,.28));transform:translateY(-12px);opacity:0;transition:transform .2s ease,opacity .2s ease;background:var(--pmg-surface,#101d30);color:var(--pmg-text,#fff);border:1px solid var(--pmg-border,#ffffff22);pointer-events:none;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
      #pmg-connectivity-banner.visible{transform:none;opacity:1}
      #pmg-connectivity-banner[data-state="offline"]{background:color-mix(in srgb,var(--pmg-surface,#101d30) 86%,var(--pmg-danger,#dc2626));border-color:color-mix(in srgb,var(--pmg-danger,#dc2626) 44%,var(--pmg-border,#ffffff22));color:var(--pmg-text,#fff)}
      #pmg-connectivity-banner[data-state="online"]{background:color-mix(in srgb,var(--pmg-surface,#101d30) 86%,var(--pmg-success,#10b981));border-color:color-mix(in srgb,var(--pmg-success,#10b981) 44%,var(--pmg-border,#ffffff22));color:var(--pmg-text,#fff)}
      #pmg-connectivity-banner .pmg-connectivity-icon{width:24px;height:24px;display:grid;place-items:center;flex:0 0 auto;border-radius:8px;background:color-mix(in srgb,currentColor 10%,transparent);font-size:12px}
      @media(max-width:480px){#pmg-connectivity-banner{left:10px;right:10px;top:calc(57px + env(safe-area-inset-top));font-size:10.5px}}
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

  function show(text, state, persistent) {
    clearTimeout(timer);
    const element = ensureBanner();
    element.dataset.state = state;
    element.innerHTML = `<span class="pmg-connectivity-icon" aria-hidden="true">${state === "online" ? "✓" : "⌁"}</span><span>${text}</span>`;
    element.classList.add("visible");
    if (!persistent) {
      timer = setTimeout(() => element.classList.remove("visible"), 2_600);
    }
  }

  function offline() {
    show("Sin conexión a Internet · Las operaciones en línea están pausadas.", "offline", true);
  }

  function online() {
    show("Conexión restablecida", "online", false);
    window.dispatchEvent(new CustomEvent("pmg:online"));
  }

  window.PMGConnectivity = { offline, online };

  window.addEventListener("offline", offline);
  window.addEventListener("online", online);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      if (!navigator.onLine) offline();
    }, { once: true });
  } else if (!navigator.onLine) offline();

  window.fetch = async function () {
    try {
      return await nativeFetch.apply(window, arguments);
    } catch (error) {
      const message = String(error?.message || error).toLowerCase();
      if (!navigator.onLine || message.includes("fetch") || message.includes("network")) {
        offline();
        throw new Error("network_error");
      }
      throw error;
    }
  };
})();
