(function(){
  if(window.__PMG_AI_DISPATCH_RUNTIME__)return;
  window.__PMG_AI_DISPATCH_RUNTIME__=true;
  if(!location.pathname.endsWith('/ai-dispatch.html'))return;

  const PLANNER='/functions/v1/reservation-ai-planner';
  const GLOBAL='/functions/v1/reservation-ai-global-solver';
  const nativeFetch=window.fetch.bind(window);

  window.fetch=function(input,init){
    try{
      const url=typeof input==='string'?input:String(input?.url||'');
      if(url.includes(PLANNER)&&init?.body){
        const body=typeof init.body==='string'?JSON.parse(init.body):null;
        if(body?.action==='optimize'){
          const next=url.replace(PLANNER,GLOBAL);
          return nativeFetch(next,init);
        }
      }
    }catch{}
    return nativeFetch(input,init);
  };
})();
