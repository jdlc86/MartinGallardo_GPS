(function () {
  "use strict";

  if (!location.pathname.endsWith("/pickup.html") || window.__PMG_PHOTO_GUIDE__) return;
  window.__PMG_PHOTO_GUIDE__ = true;
  const scriptBase = new URL(".", document.currentScript?.src || document.baseURI);

  function install() {
    const modal = document.getElementById("guideModal");
    const box = modal?.querySelector(".guideBox");
    const image = modal?.querySelector(".guideImg");
    const openButton = document.getElementById("showGuide");
    const closeButton = document.getElementById("closeGuide");
    if (!modal || !box || !image || !openButton || !closeButton) return;

    const style = document.createElement("style");
    style.id = "pmg-photo-guide-style";
    style.textContent = `
      body.pmg-guide-open{overflow:hidden}
      .guideModal{padding:calc(12px + env(safe-area-inset-top)) 12px calc(12px + env(safe-area-inset-bottom));overflow:hidden;background:rgba(2,6,23,.78);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
      .guideModal.on{animation:pmgGuideFade .16s ease-out}
      .guideModal .guideBox{width:min(100%,760px);max-height:calc(100dvh - 24px - env(safe-area-inset-top) - env(safe-area-inset-bottom));display:flex;flex-direction:column;overflow:hidden;padding:10px;border-radius:22px;box-shadow:0 24px 70px rgba(0,0,0,.38);animation:pmgGuideRise .2s ease-out}
      .guideModal .guideTop{flex:0 0 auto;padding:4px 4px 10px}
      .guideModal .guideTop b{font-size:16px;letter-spacing:-.01em}
      .guideModal .guideClose{flex:0 0 auto;display:grid;place-items:center;cursor:pointer}
      .pmg-guide-viewport{flex:1 1 auto;min-height:0;overflow:auto;display:grid;place-items:center;border:1px solid var(--pmg-border);border-radius:15px;background:#07111f;overscroll-behavior:contain}
      .pmg-guide-viewport .guideImg{display:block;width:100%;height:auto;max-height:min(64dvh,560px);aspect-ratio:700/471;object-fit:contain;object-position:center;border-radius:14px;background:#07111f}
      .pmg-guide-viewport.is-loading{min-height:180px;background:linear-gradient(110deg,#07111f 20%,#12223a 38%,#07111f 56%);background-size:220% 100%;animation:pmgGuideLoading 1.1s linear infinite}
      .pmg-guide-viewport.is-error{min-height:180px;padding:20px;text-align:center;color:var(--pmg-muted);font-size:12px;line-height:1.45}
      .guideModal .guideText{flex:0 0 auto;padding:10px 5px 3px;margin:0;font-size:12px;line-height:1.45}
      @media(max-height:520px) and (orientation:landscape){.guideModal .guideBox{max-height:calc(100dvh - 16px - env(safe-area-inset-top) - env(safe-area-inset-bottom))}.pmg-guide-viewport .guideImg{max-height:62dvh}.guideModal .guideText{font-size:10px;padding-top:7px}.guideModal .guideTop{padding-bottom:7px}}
      @media(prefers-reduced-motion:reduce){.guideModal.on,.guideModal .guideBox,.pmg-guide-viewport.is-loading{animation:none}}
      @keyframes pmgGuideFade{from{opacity:0}to{opacity:1}}
      @keyframes pmgGuideRise{from{transform:translateY(16px);opacity:.75}to{transform:none;opacity:1}}
      @keyframes pmgGuideLoading{to{background-position:-220% 0}}
    `;
    document.head.appendChild(style);

    const viewport = document.createElement("div");
    viewport.className = "pmg-guide-viewport is-loading";
    image.parentNode.insertBefore(viewport, image);
    viewport.appendChild(image);

    image.decoding = "async";
    image.width = 700;
    image.height = 471;
    image.alt = "Guía visual de las ocho fotografías exteriores obligatorias del vehículo";
    image.addEventListener("load", () => viewport.classList.remove("is-loading", "is-error"));
    image.addEventListener("error", () => {
      viewport.classList.remove("is-loading");
      viewport.classList.add("is-error");
      image.hidden = true;
      viewport.textContent = "No se pudo cargar la guía. Comprueba la conexión y vuelve a abrirla.";
    }, { once: true });
    image.src = new URL("assets/fotoverificacion-guia.svg?v=4", scriptBase).href;

    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "pmg-guide-title");
    modal.setAttribute("aria-hidden", "true");
    const title = modal.querySelector(".guideTop b");
    if (title) title.id = "pmg-guide-title";
    openButton.setAttribute("aria-haspopup", "dialog");
    openButton.setAttribute("aria-controls", "guideModal");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Cerrar guía de fotos");

    function openGuide() {
      modal.setAttribute("aria-hidden", "false");
      document.body.classList.add("pmg-guide-open");
      requestAnimationFrame(() => closeButton.focus());
    }

    function closeGuide() {
      modal.setAttribute("aria-hidden", "true");
      document.body.classList.remove("pmg-guide-open");
    }

    openButton.addEventListener("click", openGuide);
    closeButton.addEventListener("click", closeGuide);
    modal.addEventListener("click", (event) => { if (event.target === modal) closeGuide(); });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !modal.classList.contains("on")) return;
      modal.classList.remove("on");
      closeGuide();
      openButton.focus();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
