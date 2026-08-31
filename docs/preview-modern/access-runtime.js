(function(){
  if(window.__PMG_ACCESS_RUNTIME__)return;
  window.__PMG_ACCESS_RUNTIME__=true;
  const BLOCK_CODES=new Set(['not_authorized','unauthorized','not authorized','access denied','user_inactive','inactive_user']);
  function isBlockedValue(v){
    if(v==null)return false;
    const s=String(v).trim().toLowerCase();
    return BLOCK_CODES.has(s)||s.includes('not authorized')||s.includes('unauthorized')||s.includes('access denied');
  }
  function closeApp(){try{window.Telegram&&window.Telegram.WebApp&&window.Telegram.WebApp.close()}catch(e){try{history.back()}catch(_){}}}
  function showBlocked(){
    if(document.getElementById('pmg-access-overlay'))return;
    const overlay=document.createElement('div');
    overlay.id='pmg-access-overlay';
    overlay.setAttribute('role','alertdialog');
    overlay.innerHTML='<div class="pmg-access-card"><div class="pmg-access-icon">🔒</div><h2>Acceso no disponible</h2><p>Tu acceso a ParkingMartin-G está desactivado actualmente. Si crees que se trata de un error, contacta con un administrador.</p><div class="pmg-access-help">La operación actual se ha detenido y no se guardarán nuevos cambios mientras tu acceso esté desactivado.</div><button type="button" id="pmg-access-close">Cerrar</button></div>';
    const style=document.createElement('style');
    style.textContent='#pmg-access-overlay{position:fixed;inset:0;z-index:2147483647;background:#08111ff5;display:flex;align-items:center;justify-content:center;padding:22px;font-family:Inter,system-ui,-apple-system,sans-serif;color:#eef5ff}#pmg-access-overlay .pmg-access-card{width:min(100%,520px);padding:30px 24px;border-radius:28px;text-align:center;background:linear-gradient(145deg,#172554,#0b1424 58%,#08111f);border:1px solid #ffffff16;box-shadow:0 24px 90px #0009}#pmg-access-overlay .pmg-access-icon{width:68px;height:68px;margin:0 auto 18px;border-radius:22px;display:grid;place-items:center;background:#ef444418;border:1px solid #ef444433;font-size:31px}#pmg-access-overlay h2{margin:0 0 10px;font-size:28px;line-height:1.1}#pmg-access-overlay p{margin:0;color:#a9bad0;line-height:1.55;font-size:14px}#pmg-access-overlay .pmg-access-help{margin-top:18px;padding:13px 15px;border-radius:15px;background:#ffffff09;color:#c9d5e5;font-size:13px;line-height:1.45}#pmg-access-overlay button{margin-top:20px;border:0;border-radius:14px;padding:13px 20px;background:#2563eb;color:#fff;font:inherit;font-weight:850;min-width:140px}';
    document.head.appendChild(style);
    document.body.appendChild(overlay);
    document.getElementById('pmg-access-close').onclick=closeApp;
    try{window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error')}catch(e){}
  }
  window.PMGShowAccessBlocked=showBlocked;
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(){
    const response=await nativeFetch.apply(window,arguments);
    try{
      const url=String(arguments[0]&&arguments[0].url?arguments[0].url:arguments[0]||'');
      if(url.includes('supabase.co/functions/v1/')){
        const clone=response.clone();
        let data=null;
        try{data=await clone.json()}catch(e){}
        const err=data&&(data.error||data.code||data.message);
        if(response.status===401||isBlockedValue(err))showBlocked();
      }
    }catch(e){}
    return response;
  };
  window.addEventListener('message',function(ev){if(ev.data&&ev.data.type==='PMG_ACCESS_BLOCKED')showBlocked()});
})();
