(function(){
  if(window.__PMG_VEHICLE_STATUS_RUNTIME__)return;
  window.__PMG_VEHICLE_STATUS_RUNTIME__=true;
  const nativeFetch=window.fetch.bind(window);
  const opStatus={pickup:'RECOGIDO',park:'APARCADO',relocate:'REUBICADO',retrieve:'ENTREGADO'};
  function latestOperational(events){
    return (events||[]).filter(e=>opStatus[e&&e.operation]).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))[0]||null;
  }
  window.fetch=async function(){
    const args=arguments;
    const response=await nativeFetch.apply(window,args);
    try{
      const url=String(args[0]?.url||args[0]||'');
      if(!url.includes('/vehicle-consult-api'))return response;
      const clone=response.clone();
      const data=await clone.json();
      if(!data||!data.ok||!data.vehicle)return response;
      const latest=latestOperational(data.events);
      if(latest){
        data.vehicle.operational_status=opStatus[latest.operation];
        data.vehicle.operational_status_at=latest.created_at;
        if(latest.operation==='pickup')data.vehicle.status='RECOGIDO';
        else if(latest.operation==='park')data.vehicle.status='parked';
        else if(latest.operation==='relocate')data.vehicle.status='REUBICADO';
        else if(latest.operation==='retrieve')data.vehicle.status='retrieved';
      }
      const headers=new Headers(response.headers);
      headers.set('content-type','application/json');
      headers.delete('content-length');
      return new Response(JSON.stringify(data),{status:response.status,statusText:response.statusText,headers});
    }catch(e){return response}
  };
  document.addEventListener('DOMContentLoaded',()=>{
    const summary=document.getElementById('summary');
    if(!summary)return;
    const obs=new MutationObserver(()=>{
      const badge=summary.querySelector('.pill');
      if(!badge)return;
      if(badge.textContent.trim()==='EN MOVIMIENTO')badge.textContent='RECOGIDO';
    });
    obs.observe(summary,{childList:true,subtree:true,characterData:true});
  });
})();
