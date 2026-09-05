(function(){"use strict";
if(window.PMGNavigation)return;

const path=location.pathname.split("/").pop()||"index.html";
const routes={
  "index.html":{root:true,bar:false},
  "operations.html":{back:"./",backLabel:"Inicio",home:"./",bar:false},
  "reservations-admin.html":{back:"./",backLabel:"Inicio",home:"./"},
  "task-dispatch.html":{back:"./",backLabel:"Inicio",home:"./"},
  "ai-dispatch.html":{back:"task-dispatch.html?v=20260902AI6",backLabel:"Asignación",home:"./"},
  "team-v4.html":{back:"./",backLabel:"Inicio",home:"./"},
  "vehicles.html":{back:"./",backLabel:"Inicio",home:"./"},
  "recent.html":{back:"./",backLabel:"Inicio",home:"./"},
  "vehicle-v7.html":{back:"./",backLabel:"Inicio",home:"./"},
  "optimizer-settings.html":{back:"./",backLabel:"Inicio",home:"./"},
  "system-info.html":{back:"./",backLabel:"Inicio",home:"./"},
  "team-live.html":{back:"./",backLabel:"Inicio",home:"./"},
  "gps-diagnostic.html":{back:"./",backLabel:"Inicio",home:"./"},
  "legal.html":{back:"./",backLabel:"Inicio",home:"./"},
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
  style.textContent='.pmg-nav-shell{position:sticky;top:0;z-index:2147483000;margin:calc(-1 * env(safe-area-inset-top)) -2px 14px;padding:calc(8px + env(safe-area-inset-top)) 2px 8px;background:linear-gradient(to bottom,color-mix(in srgb,var(--pmg-bg,#08111f) 96%,transparent),color-mix(in srgb,var(--pmg-bg,#08111f) 88%,transparent),transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}.pmg-nav-bar{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;min-height:44px;padding:6px;border:1px solid var(--pmg-border,#ffffff22);border-radius:15px;background:color-mix(in srgb,var(--pmg-surface,#101d30) 94%,transparent);box-shadow:0 8px 24px color-mix(in srgb,#000 12%,transparent)}.pmg-nav-btn{min-width:42px;height:36px;border:0;border-radius:11px;background:var(--pmg-soft,#ffffff0d);color:var(--pmg-text,#fff);font:850 12px/1 system-ui;padding:0 10px}.pmg-nav-title{min-width:0;text-align:center;color:var(--pmg-muted,#9db0c8);font:800 10px/1.2 system-ui;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pmg-scroll-top{position:fixed;right:14px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:2147483000;width:44px;height:44px;border:1px solid var(--pmg-border,#ffffff22);border-radius:14px;background:color-mix(in srgb,var(--pmg-surface,#101d30) 94%,transparent);color:var(--pmg-text,#fff);box-shadow:0 10px 28px #0005;opacity:0;pointer-events:none;transform:translateY(8px);transition:.18s}.pmg-scroll-top.on{opacity:1;pointer-events:auto;transform:none}';
  document.head.appendChild(style);
  const main=document.querySelector("main");
  if(!main)return;
  const shell=document.createElement("div");
  shell.className="pmg-nav-shell";
  shell.innerHTML='<div class="pmg-nav-bar"><button class="pmg-nav-btn" id="pmg-nav-back" type="button">←</button><div class="pmg-nav-title">'+(cfg.backLabel||"Volver")+'</div><button class="pmg-nav-btn" id="pmg-nav-home" type="button">⌂</button></div>';
  main.insertBefore(shell,main.firstChild);
  document.getElementById("pmg-nav-back").onclick=()=>history.length>1&&hasInternalReferrer()?history.back():defaultBack();
  document.getElementById("pmg-nav-home").onclick=()=>location.href=cfg.home||"./";
  const up=document.createElement("button");
  up.className="pmg-scroll-top";up.type="button";up.setAttribute("aria-label","Volver arriba");up.textContent="↑";
  up.onclick=()=>window.scrollTo({top:0,behavior:"smooth"});
  document.body.appendChild(up);
  const update=()=>up.classList.toggle("on",window.scrollY>700);
  window.addEventListener("scroll",update,{passive:true});update();
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",initVisual,{once:true});else initVisual();
})();