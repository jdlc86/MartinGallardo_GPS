(function(){"use strict";
if(window.PMGNavigation)return;

const path=location.pathname.split("/").pop()||"index.html";
const routes={
  "index.html":{root:true,bar:false},
  "operations.html":{back:"./",backLabel:"Centro de Operaciones",home:"./"},
  "reservations-admin.html":{back:"./",backLabel:"Gestión de reservas",home:"./"},
  "task-dispatch.html":{back:"./",backLabel:"Asignación de tareas",home:"./"},
  "ai-dispatch.html":{back:"task-dispatch.html?v=20260902AI6",backLabel:"Optimización IA",home:"./"},
  "team-v4.html":{back:"./",backLabel:"Equipo & Accesos",home:"./"},
  "vehicles.html":{back:"./",backLabel:"Vehículos",home:"./"},
  "recent.html":{back:"./",backLabel:"Actividad reciente",home:"./"},
  "vehicle-v7.html":{back:"./",backLabel:"Expediente 360º",home:"./"},
  "optimizer-settings.html":{back:"./",backLabel:"Configuración",home:"./"},
  "system-info.html":{back:"./",backLabel:"Información del sistema",home:"./"},
  "team-live.html":{back:"./",backLabel:"Equipo en vivo",home:"./"},
  "gps-diagnostic.html":{back:"./",backLabel:"GPS Pro · Diagnóstico",home:"./"},
  "legal.html":{back:"./",backLabel:"Legal",home:"./"},
  "park.html":{bar:false,flow:true},
  "pickup.html":{bar:false,flow:true},
  "relocate.html":{bar:false,flow:true},
  "delivery.html":{bar:false,flow:true},
  "search.html":{bar:false,flow:true}
};

let customBack=null,armed=false,handling=false;
const MARK="__pmg_android_back__";
const cfg=routes[path]||null;

function hasInternalReferrer(){
  try{
    if(!document.referrer)return false;
    const r=new URL(document.referrer),u=new URL(location.href);
    return r.origin===u.origin&&r.pathname.includes("/preview-modern/");
  }catch{return false}
}
function sameDocument(href){
  try{const a=new URL(href,location.href),b=new URL(location.href);return a.origin===b.origin&&a.pathname===b.pathname&&a.search===b.search&&a.hash===b.hash}catch{return false}
}
function arm(){
  if(armed)return;
  try{history.pushState({...history.state,[MARK]:true},"",location.href);armed=true}catch{}
}
function shouldArmFallback(){
  return Boolean(customBack)||Boolean(cfg?.flow)||!hasInternalReferrer();
}
function ensureArmed(){
  if(shouldArmFallback())arm();
}
function defaultBack(){
  if(cfg?.root){
    try{const tg=window.Telegram?.WebApp;if(tg?.close){tg.close();return}}catch{}
    return;
  }
  location.href=cfg?.back||"./";
}
function runBack(){
  if(handling)return;
  handling=true;
  const before=location.href;
  Promise.resolve().then(()=>customBack?customBack():defaultBack()).catch(()=>defaultBack()).finally(()=>{
    handling=false;
    setTimeout(()=>{if(sameDocument(before)){armed=false;ensureArmed()}},0);
  });
}
window.addEventListener("popstate",()=>{
  if(!armed)return;
  armed=false;
  runBack();
});

window.PMGNavigation={
  setBackHandler(fn){customBack=typeof fn==="function"?fn:null;ensureArmed()},
  clearBackHandler(){customBack=null;ensureArmed()},
  back(){runBack()},
  arm:ensureArmed
};
ensureArmed();

function initVisual(){
  if(!cfg||cfg.bar===false||!cfg.back)return;
  if(document.getElementById("pmg-navigation-style"))return;
  const style=document.createElement("style");
  style.id="pmg-navigation-style";
  style.textContent='.pmg-nav-shell{position:sticky;top:0;z-index:2147483000;margin:calc(-1 * env(safe-area-inset-top)) -2px 14px;padding:calc(7px + env(safe-area-inset-top)) 2px 7px;background:linear-gradient(to bottom,color-mix(in srgb,var(--pmg-bg,#08111f) 97%,transparent) 0%,color-mix(in srgb,var(--pmg-bg,#08111f) 88%,transparent) 72%,transparent 100%);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}.pmg-nav-bar{display:grid;grid-template-columns:44px minmax(0,1fr) 44px;align-items:center;gap:8px;min-height:48px;padding:2px 4px;border:0;border-radius:16px;background:color-mix(in srgb,var(--pmg-surface,#101d30) 74%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--pmg-border,#ffffff22) 72%,transparent),0 8px 28px color-mix(in srgb,#000 10%,transparent);transition:min-height .18s ease,background .18s ease}.pmg-nav-shell.compact .pmg-nav-bar{min-height:42px;background:color-mix(in srgb,var(--pmg-surface,#101d30) 88%,transparent)}.pmg-nav-btn{width:40px;height:40px;display:grid;place-items:center;border:0;border-radius:13px;background:transparent;color:var(--pmg-text,#fff);padding:0;cursor:pointer;transition:background .14s ease,transform .14s ease}.pmg-nav-btn:active{background:var(--pmg-soft,#ffffff0d);transform:scale(.94)}.pmg-nav-btn svg{width:20px;height:20px;display:block;stroke:currentColor;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round}.pmg-nav-title{min-width:0;text-align:center;color:var(--pmg-text,#fff);font:760 13px/1.2 system-ui,-apple-system,sans-serif;letter-spacing:.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.92}.pmg-scroll-top{position:fixed;right:14px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:2147483000;width:44px;height:44px;border:1px solid var(--pmg-border,#ffffff22);border-radius:14px;background:color-mix(in srgb,var(--pmg-surface,#101d30) 94%,transparent);color:var(--pmg-text,#fff);box-shadow:0 10px 28px #0005;opacity:0;pointer-events:none;transform:translateY(8px);transition:.18s}.pmg-scroll-top.on{opacity:1;pointer-events:auto;transform:none}@media(prefers-reduced-motion:reduce){.pmg-nav-bar,.pmg-nav-btn,.pmg-scroll-top{transition:none}}';
  document.head.appendChild(style);
  const main=document.querySelector("main");
  if(!main)return;
  const shell=document.createElement("div");
  shell.className="pmg-nav-shell";
  const backIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
  const homeIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 10.5L12 3.8l8.5 6.7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M9.5 20v-6h5v6"/></svg>';
  shell.innerHTML='<div class="pmg-nav-bar"><button class="pmg-nav-btn" id="pmg-nav-back" type="button" aria-label="Atrás">'+backIcon+'</button><div class="pmg-nav-title">'+(cfg.backLabel||document.title||"")+'</div><button class="pmg-nav-btn" id="pmg-nav-home" type="button" aria-label="Inicio">'+homeIcon+'</button></div>';
  main.insertBefore(shell,main.firstChild);
  document.getElementById("pmg-nav-back").onclick=()=>history.length>1&&hasInternalReferrer()?history.back():defaultBack();
  document.getElementById("pmg-nav-home").onclick=()=>location.href=cfg.home||"./";
  const up=document.createElement("button");
  up.className="pmg-scroll-top";up.type="button";up.setAttribute("aria-label","Volver arriba");up.textContent="↑";
  up.onclick=()=>window.scrollTo({top:0,behavior:"smooth"});
  document.body.appendChild(up);
  const update=()=>{up.classList.toggle("on",window.scrollY>700);shell.classList.toggle("compact",window.scrollY>44)};
  window.addEventListener("scroll",update,{passive:true});update();
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",initVisual,{once:true});else initVisual();
})();