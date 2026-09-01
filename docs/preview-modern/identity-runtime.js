(function(){
  if(window.__PMG_IDENTITY_RUNTIME__)return;
  window.__PMG_IDENTITY_RUNTIME__=true;
  const API='https://mvexykcxnpaywkbnoxwu.supabase.co/functions/v1/telegram-identity-sync';
  async function sync(){
    const tg=window.Telegram?.WebApp;
    if(!tg?.initData)return;
    try{
      const response=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:tg.initData})});
      if(response.status===403){
        const data=await response.json().catch(()=>({}));
        if(data?.error==='not_authorized')window.PMGShowAccessBlocked?.();
      }
    }catch(e){
      // Identity refresh is best-effort and must never block normal operation.
    }
  }
  function start(){setTimeout(sync,0)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
