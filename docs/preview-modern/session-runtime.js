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
  let accessExpiresAt=null;
  let accessToken=null;
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
    if(kind==="access"){
      storeAccessSession(null,null);
    }
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

  function currentAuthDate(){
    try{
      const initData=window.Telegram?.WebApp?.initData;
      if(!initData)return null;
      const value=Number(new URLSearchParams(initData).get("auth_date")||0);
      return Number.isFinite(value)&&value>0?value:null;
    }catch{return null}
  }

  function currentTelegramUserId(){
    try{
      const initData=window.Telegram?.WebApp?.initData;
      if(!initData)return null;
      const raw=new URLSearchParams(initData).get("user");
      if(!raw)return null;
      const user=JSON.parse(raw);
      const value=Number(user?.id);
      return Number.isFinite(value)&&value>0?String(value):null;
    }catch{return null}
  }

  function readStoredAccessSession(){
    try{
      const token=sessionStorage.getItem("pmg_access_session_token")||null;
      const expiresAt=sessionStorage.getItem("pmg_access_session_expires_at")||null;
      const authDate=Number(sessionStorage.getItem("pmg_access_session_auth_date")||0)||null;
      const userId=sessionStorage.getItem("pmg_access_session_user_id")||null;
      return {token,expiresAt,authDate,userId};
    }catch{return {token:null,expiresAt:null,authDate:null,userId:null}}
  }

  function storedAccessSessionUsable(){
    const stored=readStoredAccessSession();
    const current=currentAuthDate();
    const currentUserId=currentTelegramUserId();
    const expiresMs=stored.expiresAt?new Date(stored.expiresAt).getTime():NaN;
    return Boolean(
      stored.token &&
      current &&
      currentUserId &&
      stored.authDate===current &&
      stored.userId===currentUserId &&
      Number.isFinite(expiresMs) &&
      expiresMs>Date.now()+1000
    );
  }

  function storeAccessSession(token,expiresAt,authDate=currentAuthDate(),userId=currentTelegramUserId()){
    accessToken=String(token||"")||null;
    accessExpiresAt=expiresAt||null;
    try{
      if(accessToken){
        sessionStorage.setItem("pmg_access_session_token",accessToken);
        if(accessExpiresAt)sessionStorage.setItem("pmg_access_session_expires_at",String(accessExpiresAt));
        else sessionStorage.removeItem("pmg_access_session_expires_at");
        if(authDate)sessionStorage.setItem("pmg_access_session_auth_date",String(authDate));
        else sessionStorage.removeItem("pmg_access_session_auth_date");
        if(userId)sessionStorage.setItem("pmg_access_session_user_id",String(userId));
        else sessionStorage.removeItem("pmg_access_session_user_id");
      }else{
        sessionStorage.removeItem("pmg_access_session_token");
        sessionStorage.removeItem("pmg_access_session_expires_at");
        sessionStorage.removeItem("pmg_access_session_auth_date");
        sessionStorage.removeItem("pmg_access_session_user_id");
      }
    }catch{}
  }

  async function registerAccess(){
    const initData=window.Telegram?.WebApp?.initData;
    if(!initData)return false;
    try{
      const res=await nativeFetch(ACCESS_SESSION_API,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({initData})
      });
      const data=await res.json().catch(()=>({}));
      if(!res.ok||data?.ok===false){
        const code=String(data?.error||"");
        if(code==="expired_init_data")lock("access");
        return false;
      }
      storeAccessSession(data?.access_token,data?.expires_at);
      armAccess(data?.expires_at);
      return true;
    }catch{
      return false;
    }
  }

  function armAccess(expiresAt=null){
    if(locked)return;
    clearTimeout(accessTimer);
    let at=expiresAt?new Date(expiresAt).getTime():NaN;
    if(!Number.isFinite(at)){
      const initData=window.Telegram?.WebApp?.initData;
      if(!initData)return;
      try{
        const authDate=Number(new URLSearchParams(initData).get("auth_date")||0);
        if(!Number.isFinite(authDate)||authDate<=0)return;
        at=authDate*1000+ACCESS_MAX_AGE_SECONDS*1000;
      }catch{return}
    }
    const delay=at-Date.now();
    if(delay<=0)return lock("access");
    accessExpiresAt=new Date(at).toISOString();
    accessTimer=setTimeout(()=>lock("access"),delay+50);
  }

  function requestAction(init){
    try{
      if(typeof init?.body!=="string")return "";
      const body=JSON.parse(init.body);
      return String(body?.action||"");
    }catch{return ""}
  }

  function inspectResponse(res,action=""){
    try{
      const type=res.headers.get("content-type")||"";
      if(!type.includes("application/json"))return;
      res.clone().json().then(data=>{
        if(data?.flow_session_id&&data?.expires_at)armFlow(data.expires_at);
        const error=String(data?.error||"");
        // A stale saved flow is an expected recovery case. The page-level resume
        // handler owns that response and clears the stale local flow without locking
        // the whole Mini App. Active-operation expiry still locks everywhere else.
        if(error==="flow_session_expired"&&action!=="resume")lock("operation");
        if(error==="expired_init_data"||error==="expired_access_session")lock("access");
      }).catch(()=>{});
    }catch{}
  }

  const nativeFetch=window.fetch.bind(window);
  const initialStoredAccess=readStoredAccessSession();
  const initialStoredAccessUsable=storedAccessSessionUsable();
  accessToken=initialStoredAccessUsable?initialStoredAccess.token:null;
  accessExpiresAt=initialStoredAccessUsable?initialStoredAccess.expiresAt:null;
  window.fetch=async function(input,init){
    let nextInit=init;
    try{
      const url=typeof input==="string"?input:String(input?.url||"");
      const token=accessToken;
      const isEdge=url.startsWith("https://mvexykcxnpaywkbnoxwu.supabase.co/functions/v1/");
      const isBootstrap=url.startsWith(ACCESS_SESSION_API);
      if(token&&isEdge&&!isBootstrap&&init?.method==="POST"&&typeof init?.body==="string"){
        const parsed=JSON.parse(init.body);
        if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed)&&!parsed.access_session_token){
          parsed.access_session_token=token;
          nextInit={...init,body:JSON.stringify(parsed)};
        }
      }
    }catch{}
    const res=await nativeFetch(input,nextInit);
    inspectResponse(res,requestAction(nextInit));
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
      if(value==="expired_init_data"||value==="expired_access_session")lock("access");
    },
    get locked(){return locked},
    get kind(){return lockKind}
  };

  async function ensureAccess(){
    if(!window.Telegram?.WebApp?.initData)return;
    if(storedAccessSessionUsable()){
      const stored=readStoredAccessSession();
      accessToken=stored.token;
      accessExpiresAt=stored.expiresAt;
      armAccess(stored.expiresAt);
      return;
    }
    storeAccessSession(null,null);
    armAccess();
    await registerAccess();
  }

  async function bootAccess(){
    if(window.Telegram?.WebApp?.initData){
      await ensureAccess();
      return;
    }
    window.addEventListener("load",ensureAccess,{once:true});
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bootAccess,{once:true});
  else bootAccess();
})();