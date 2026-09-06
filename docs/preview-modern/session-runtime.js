(function(){
  "use strict";
  if(window.PMGSessionRuntime)return;

  const ACCESS_MAX_AGE_SECONDS=86400;
  let flowTimer=null;
  let accessTimer=null;
  let locked=false;
  let lockKind=null;
  let overlay=null;

  function stopMedia(){
    try{
      document.querySelectorAll("video,audio").forEach(el=>{
        try{
          const stream=el.srcObject;
          if(stream&&typeof stream.getTracks==="function")stream.getTracks().forEach(t=>t.stop());
          el.pause?.();
          el.srcObject=null;
        }catch{}
      });
    }catch{}
    try{window.dispatchEvent(new CustomEvent("pmg:session-expired",{detail:{kind:lockKind}}))}catch{}
  }

  function ensureOverlay(){
    if(overlay)return overlay;
    const style=document.createElement("style");
    style.id="pmg-session-expiry-style";
    style.textContent=`
      #pmg-session-expiry-overlay{position:fixed;z-index:2147483646;inset:0;display:none;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--pmg-bg,#08111f) 78%,transparent);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
      #pmg-session-expiry-overlay.on{display:flex}
      #pmg-session-expiry-card{width:min(92vw,460px);padding:26px;border-radius:26px;background:var(--pmg-surface,#101d30);color:var(--pmg-text,#fff);border:1px solid var(--pmg-border,#ffffff22);box-shadow:0 28px 100px #0009;text-align:center}
      #pmg-session-expiry-icon{width:64px;height:64px;margin:0 auto 16px;border-radius:20px;display:grid;place-items:center;background:var(--pmg-warning-soft,#f59e0b22);font-size:30px}
      #pmg-session-expiry-card h2{margin:0 0 10px;font-size:24px;line-height:1.15}
      #pmg-session-expiry-card p{margin:0;color:var(--pmg-muted,#a9bad0);font-size:13px;line-height:1.55}
      #pmg-session-expiry-close{width:100%;min-height:48px;margin-top:20px;border:0;border-radius:15px;background:var(--pmg-accent,#2563eb);color:#fff;font-weight:850;font-size:14px}
    `;
    document.head.appendChild(style);
    overlay=document.createElement("div");
    overlay.id="pmg-session-expiry-overlay";
    overlay.setAttribute("role","dialog");
    overlay.setAttribute("aria-modal","true");
    overlay.innerHTML=`<div id="pmg-session-expiry-card"><div id="pmg-session-expiry-icon">⏱️</div><h2 id="pmg-session-expiry-title"></h2><p id="pmg-session-expiry-text"></p><button id="pmg-session-expiry-close" type="button">Cerrar aplicación</button></div>`;
    document.documentElement.appendChild(overlay);
    overlay.querySelector("#pmg-session-expiry-close").addEventListener("click",()=>{
      try{window.Telegram?.WebApp?.close?.()}catch{}
    });
    return overlay;
  }

  function lock(kind){
    if(locked&&lockKind===kind)return;
    locked=true;
    lockKind=kind;
    clearTimeout(flowTimer);
    clearTimeout(accessTimer);
    stopMedia();
    const root=ensureOverlay();
    const operation=kind==="operation";
    root.querySelector("#pmg-session-expiry-title").textContent=operation?"La operación ha caducado":"La sesión ha caducado";
    root.querySelector("#pmg-session-expiry-text").textContent=operation
      ?"Esta operación ya no puede continuar con la sesión actual. Los datos ya registrados siguen guardados. Cierra ParkingMartin-G y vuelve a abrirlo desde Telegram para iniciar una sesión nueva."
      :"Tu sesión de acceso ya no es válida. Cierra ParkingMartin-G y vuelve a abrirlo desde Telegram para continuar de forma segura.";
    root.classList.add("on");
    document.documentElement.style.overflow="hidden";
    try{window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("warning")}catch{}
  }

  function armFlow(expiresAt){
    if(locked)return;
    clearTimeout(flowTimer);
    const at=new Date(expiresAt).getTime();
    if(!Number.isFinite(at))return;
    const delay=at-Date.now();
    if(delay<=0)return lock("operation");
    flowTimer=setTimeout(()=>lock("operation"),delay+50);
  }

  function clearFlow(){
    clearTimeout(flowTimer);
    flowTimer=null;
  }

  function armAccess(){
    if(locked)return;
    clearTimeout(accessTimer);
    const initData=window.Telegram?.WebApp?.initData;
    if(!initData)return;
    try{
      const authDate=Number(new URLSearchParams(initData).get("auth_date")||0);
      if(!Number.isFinite(authDate)||authDate<=0)return;
      const at=authDate*1000+ACCESS_MAX_AGE_SECONDS*1000;
      const delay=at-Date.now();
      if(delay<=0)return lock("access");
      accessTimer=setTimeout(()=>lock("access"),delay+50);
    }catch{}
  }

  function inspectResponse(res){
    try{
      const type=res.headers.get("content-type")||"";
      if(!type.includes("application/json"))return;
      res.clone().json().then(data=>{
        if(data?.flow_session_id&&data?.expires_at)armFlow(data.expires_at);
        const error=String(data?.error||"");
        if(error==="flow_session_expired")lock("operation");
        if(error==="expired_init_data")lock("access");
      }).catch(()=>{});
    }catch{}
  }

  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(){
    const res=await nativeFetch.apply(window,arguments);
    inspectResponse(res);
    return res;
  };

  window.PMGSessionRuntime={
    armFlow,
    clearFlow,
    expireOperation:()=>lock("operation"),
    expireAccess:()=>lock("access"),
    handleError(code){
      const value=String(code||"");
      if(value==="flow_session_expired")lock("operation");
      if(value==="expired_init_data")lock("access");
    },
    get locked(){return locked},
    get kind(){return lockKind}
  };

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",armAccess,{once:true});
  else armAccess();
})();