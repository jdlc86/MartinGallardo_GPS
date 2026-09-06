(function(){
  "use strict";
  if(window.PMGSessionRuntime)return;

  const ACCESS_MAX_AGE_SECONDS=600;
  const ACCESS_SESSION_API="https://mvexykcxnpaywkbnoxwu.supabase.co/functions/v1/miniapp-access-session-api";
  let flowTimer=null;
  let accessTimer=null;
  let locked=false;
  let lockKind=null;
  let overlay=null;
  const mediaStreams=new Set();
  const geoWatchIds=new Set();

  if(navigator.mediaDevices?.getUserMedia){
    const nativeGetUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async function(){
      const stream=await nativeGetUserMedia.apply(navigator.mediaDevices,arguments);
      mediaStreams.add(stream);
      stream.getTracks().forEach(track=>track.addEventListener("ended",()=>{
        if(stream.getTracks().every(t=>t.readyState==="ended"))mediaStreams.delete(stream);
      },{once:true}));
      return stream;
    };
  }

  if(navigator.geolocation?.watchPosition){
    const nativeWatch=navigator.geolocation.watchPosition.bind(navigator.geolocation);
    const nativeClear=navigator.geolocation.clearWatch.bind(navigator.geolocation);
    navigator.geolocation.watchPosition=function(){
      const id=nativeWatch.apply(navigator.geolocation,arguments);
      geoWatchIds.add(id);
      return id;
    };
    navigator.geolocation.clearWatch=function(id){
      geoWatchIds.delete(id);
      return nativeClear(id);
    };
  }

  function stopMedia(){
    try{
      mediaStreams.forEach(stream=>{try{stream.getTracks().forEach(t=>t.stop())}catch{}});
      mediaStreams.clear();
    }catch{}
    try{
      geoWatchIds.forEach(id=>{try{navigator.geolocation.clearWatch(id)}catch{}});
      geoWatchIds.clear();
    }catch{}
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
      #pmg-session-expiry-card{width:min(92vw,460px);padding:26px;border-radius:26px;background:#101d30;color:var(--pmg-text,#f5f8fc);border:1px solid var(--pmg-border,#ffffff22);box-shadow:0 28px 100px #0009;text-align:center;isolation:isolate}@media (prefers-color-scheme:light){#pmg-session-expiry-card{background:#fff;color:#132238;border-color:#d9e2ec;box-shadow:0 28px 80px #0f172a2b}#pmg-session-expiry-card p{color:#5d6c80}}
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

  async function registerAccess(){
    const initData=window.Telegram?.WebApp?.initData;
    if(!initData)return;
    try{
      await nativeFetch(ACCESS_SESSION_API,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({initData})
      });
    }catch{}
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

  function bootAccess(){
    armAccess();
    registerAccess();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bootAccess,{once:true});
  else bootAccess();
})();