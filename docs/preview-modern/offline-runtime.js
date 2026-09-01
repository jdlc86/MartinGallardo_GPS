(function(){
  if(window.__PMG_OFFLINE_RUNTIME__)return;
  window.__PMG_OFFLINE_RUNTIME__=true;

  var nativeFetch=window.fetch.bind(window);
  var banner=null,timer=null;

  function ensureBanner(){
    if(banner)return banner;
    banner=document.createElement('div');
    banner.id='pmg-connectivity-banner';
    banner.setAttribute('role','status');
    banner.setAttribute('aria-live','polite');
    banner.style.cssText='position:fixed;z-index:2147483646;left:12px;right:12px;top:calc(10px + env(safe-area-inset-top));margin:auto;max-width:680px;padding:11px 14px;border-radius:14px;font:800 12px/1.35 system-ui,-apple-system,sans-serif;text-align:center;box-shadow:0 12px 34px rgba(0,0,0,.28);transform:translateY(-140%);opacity:0;transition:.22s;pointer-events:none;background:#7f1d1d;color:#fff;border:1px solid rgba(255,255,255,.18)';
    document.documentElement.appendChild(banner);
    return banner;
  }
  function show(text,ok,persistent){
    clearTimeout(timer);
    var b=ensureBanner();
    b.textContent=text;
    b.style.background=ok?'#166534':'#7f1d1d';
    b.style.transform='translateY(0)';
    b.style.opacity='1';
    if(!persistent)timer=setTimeout(function(){b.style.transform='translateY(-140%)';b.style.opacity='0'},2600);
  }
  function offline(){show('Sin conexión a Internet · Algunas funciones no están disponibles. Tus datos no se perderán por este aviso.',false,true)}
  function online(){show('Conexión restablecida',true,false);window.dispatchEvent(new CustomEvent('pmg:online'))}

  window.addEventListener('offline',offline);
  window.addEventListener('online',online);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){if(!navigator.onLine)offline()},{once:true});
  else if(!navigator.onLine)offline();

  window.fetch=async function(){
    try{return await nativeFetch.apply(window,arguments)}
    catch(err){
      if(!navigator.onLine||String(err&&err.message||err).toLowerCase().includes('fetch')){
        offline();
        throw new Error('network_error');
      }
      throw err;
    }
  };
})();
