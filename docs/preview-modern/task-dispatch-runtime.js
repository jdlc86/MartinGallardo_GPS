(function () {
  if (window.__PMG_TASK_DISPATCH_LAYOUT__) return;
  window.__PMG_TASK_DISPATCH_LAYOUT__ = true;
  if (!location.pathname.endsWith("/task-dispatch.html")) return;

  function install() {
    const bar = document.getElementById("assignbar");
    if (!bar) return;

    const style = document.createElement("style");
    style.id = "pmg-task-dispatch-layout-style";
    style.textContent = `
      :root{--pmg-assignbar-height:0px}
      .app{padding-bottom:calc(28px + env(safe-area-inset-bottom))!important}
      html.pmg-has-assignbar .app{padding-bottom:calc(var(--pmg-assignbar-height) + 28px + env(safe-area-inset-bottom))!important}
      .task{scroll-margin-bottom:calc(var(--pmg-assignbar-height) + 28px + env(safe-area-inset-bottom))}
    `;
    document.head.appendChild(style);

    /* The canonical AI entry point now lives directly in task-dispatch.html
       as #aiAssistant. Remove the old runtime-injected fallback if a cached
       page/runtime combination ever leaves it behind. */
    document.getElementById('pmg-ai-planner')?.remove();

    function syncSpace() {
      const active = bar.classList.contains("on");
      document.documentElement.classList.toggle("pmg-has-assignbar", active);
      document.documentElement.style.setProperty(
        "--pmg-assignbar-height",
        active ? `${Math.ceil(bar.getBoundingClientRect().height)}px` : "0px"
      );
    }

    function revealTask(id) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        syncSpace();
        if (!bar.classList.contains("on")) return;
        const input = Array.from(document.querySelectorAll("[data-id]")).find((item) => item.dataset.id === id);
        const task = input?.closest(".task");
        if (!task) return;
        const taskRect = task.getBoundingClientRect();
        const barRect = bar.getBoundingClientRect();
        const overlap = taskRect.bottom - (barRect.top - 14);
        if (overlap > 0) window.scrollBy({ top: overlap, behavior: "smooth" });
      }));
    }

    new MutationObserver(syncSpace).observe(bar, { attributes: true, attributeFilter: ["class"] });
    if (window.ResizeObserver) new ResizeObserver(syncSpace).observe(bar);
    window.addEventListener("resize", syncSpace, { passive: true });
    window.visualViewport?.addEventListener("resize", syncSpace, { passive: true });
    document.addEventListener("change", (event) => {
      const input = event.target.closest?.("input[data-id]");
      if (input?.checked) revealTask(input.dataset.id);
    }, true);
    syncSpace();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
