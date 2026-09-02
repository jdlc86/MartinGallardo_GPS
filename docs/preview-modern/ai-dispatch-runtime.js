(function(){
  if(window.__PMG_AI_DISPATCH_RUNTIME__)return;
  window.__PMG_AI_DISPATCH_RUNTIME__=true;
  if(!location.pathname.endsWith('/ai-dispatch.html'))return;

  const PLANNER='/functions/v1/reservation-ai-planner';
  const GLOBAL='/functions/v1/reservation-ai-global-solver';
  const nativeFetch=window.fetch.bind(window);

  function sameMadridDay(a,b){
    const f=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'});
    return f.format(new Date(a))===f.format(new Date(b));
  }

  function manualConflicts(data){
    const conflicts=[];
    for(const report of Object.values(data?.reports||{})){
      const items=(report?.items||[]).filter(x=>x?.fixed).sort((a,b)=>new Date(a.sched)-new Date(b.sched));
      for(let i=1;i<items.length;i++){
        const prev=items[i-1],cur=items[i];
        if(!sameMadridDay(prev.sched,cur.sched))continue;
        let impossible=false;
        if(prev.type==='pickup'&&cur.type==='delivery')impossible=new Date(prev.worker_end)>new Date(cur.car_depart);
        else if(prev.type==='pickup'&&cur.type==='pickup')impossible=new Date(prev.worker_end)>new Date(cur.target);
        else if(prev.type==='delivery'&&cur.type==='delivery')impossible=new Date(prev.worker_end)>new Date(cur.car_depart);
        if(impossible){
          conflicts.push({
            task_id:cur.id,
            previous_task_id:prev.id,
            worker_id:report.worker?.id,
            worker_name:report.worker?.full_name||'Operario',
            reason:'manual_assignment_physical_conflict'
          });
        }
      }
    }
    return conflicts;
  }

  async function postProcess(response){
    const clone=response.clone();
    let data;
    try{data=await clone.json()}catch{return response}
    if(!data?.ok)return response;
    const conflicts=manualConflicts(data);
    if(!conflicts.length)return response;
    data.hard_conflicts=conflicts;
    data.physical_feasible=false;
    data.unassigned=[...(data.unassigned||[]),...conflicts.map(c=>({task_id:c.task_id,reason:c.reason}))];
    for(const c of conflicts){
      const r=Object.values(data.reports||{}).find(x=>x?.worker?.id===c.worker_id);
      if(r?.text)r.text='⚠️ CONFLICTO EN ASIGNACIONES MANUALES: revisar la secuencia antes de ejecutar.\n'+r.text;
    }
    return new Response(JSON.stringify(data),{status:response.status,statusText:response.statusText,headers:response.headers});
  }

  window.fetch=function(input,init){
    try{
      const url=typeof input==='string'?input:String(input?.url||'');
      if(url.includes(PLANNER)&&init?.body){
        const body=typeof init.body==='string'?JSON.parse(init.body):null;
        if(body?.action==='optimize'){
          const next=url.replace(PLANNER,GLOBAL);
          return nativeFetch(next,init).then(postProcess);
        }
      }
    }catch{}
    return nativeFetch(input,init);
  };
})();
