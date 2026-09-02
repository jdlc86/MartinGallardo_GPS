(function(){
  if(window.__PMG_AI_DISPATCH_RUNTIME__)return;
  window.__PMG_AI_DISPATCH_RUNTIME__=true;
  if(!location.pathname.endsWith('/ai-dispatch.html'))return;

  const PLANNER='/functions/v1/reservation-ai-planner';
  const GLOBAL='/functions/v1/reservation-ai-global-solver';
  const nativeFetch=window.fetch.bind(window);

  async function adaptGlobalResponse(response){
    const clone=response.clone();
    let data;
    try{data=await clone.json()}catch{return response}
    if(!data?.ok)return response;

    // Compatibilidad visual con la pantalla existente. La detección se realiza
    // exclusivamente en backend; aquí solo se presenta en el bloque de incidencias.
    const manual=Array.isArray(data.manual_conflicts)?data.manual_conflicts:[];
    if(manual.length){
      data.unassigned=[...(data.unassigned||[]),...manual.map(c=>({
        task_id:c.task_id,
        reason:`manual_assignment_physical_conflict · ${c.worker_name||'Operario'}`
      }))];
    }

    const late=(data.reviews||[]).filter(r=>r?.reason==='planned_late_arrival');
    if(late.length){
      data.unassigned=[...(data.unassigned||[]),...late.map(r=>({
        task_id:r.task_id,
        reason:`plan usa retraso penalizado de ${r.lateness_minutes} min`
      }))];
    }

    return new Response(JSON.stringify(data),{
      status:response.status,
      statusText:response.statusText,
      headers:response.headers
    });
  }

  window.fetch=function(input,init){
    try{
      const url=typeof input==='string'?input:String(input?.url||'');
      if(url.includes(PLANNER)&&init?.body){
        const body=typeof init.body==='string'?JSON.parse(init.body):null;
        if(body?.action==='optimize'){
          const next=url.replace(PLANNER,GLOBAL);
          return nativeFetch(next,init).then(adaptGlobalResponse);
        }
      }
    }catch{}
    return nativeFetch(input,init);
  };
})();
