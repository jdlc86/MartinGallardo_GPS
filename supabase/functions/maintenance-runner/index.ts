import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RELEASE_PRODUCT="ParkingMartin-G";
const RELEASE_VERSION="1.4.0";
const RELEASE_BUILD="2026.09.04.04";
const RELEASE_SOURCE_REVISION="20ea8af317edba97120c19a81ca8cc5684fd4d3c";

const serviceHeaders=(extra:Record<string,string>={})=>({apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,...extra});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
function attest(){return json({ok:true,product:RELEASE_PRODUCT,function:"maintenance-runner",version:RELEASE_VERSION,build:RELEASE_BUILD,source_revision:RELEASE_SOURCE_REVISION})}
async function rpc(name:string,body:unknown){const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:"POST",headers:serviceHeaders({"Content-Type":"application/json"}),body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error((d as any)?.message||(d as any)?.error||`rpc_${name}_failed`);return d}
async function rest(method:string,path:string,body?:unknown){const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:serviceHeaders({"Content-Type":"application/json","Prefer":"return=representation"}),body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json().catch(()=>null);if(!r.ok)throw new Error((d as any)?.message||`rest_${method}_failed`);return d}
async function invokeTask(slug:string,config:unknown,timeoutMs:number,maintenanceSecret:string){
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  try{
    const r=await fetch(`${SUPABASE_URL}/functions/v1/${encodeURIComponent(slug)}`,{method:"POST",headers:{"Content-Type":"application/json","x-maintenance-secret":maintenanceSecret},body:JSON.stringify(config||{}),signal:ctrl.signal});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!(d as any)?.ok)throw new Error((d as any)?.error||`task_${slug}_failed_${r.status}`);
    return d;
  }finally{clearTimeout(timer)}
}

Deno.serve(async req=>{
  const u=new URL(req.url);
  if(req.method==="GET"&&u.searchParams.get("attest")==="1")return attest();
  if(req.method!=="POST")return json({ok:false,error:"method_not_allowed"},405);
  try{
    const maintenanceSecret=req.headers.get("x-maintenance-secret")||"";
    if(!maintenanceSecret||!(await rpc("validate_maintenance_runner_secret",{p_secret:maintenanceSecret})))return json({ok:false,error:"not_authorized"},403);

    const tasks=await rest("GET","maintenance_tasks?enabled=eq.true&select=task_key,function_slug,priority,timeout_ms,config&order=priority.asc,task_key.asc");
    const runRows=await rest("POST","maintenance_runner_runs",{status:"running",tasks_total:(tasks||[]).length});
    const runId=runRows?.[0]?.id;
    const details:any[]=[];let succeeded=0,failed=0;

    for(const task of tasks||[]){
      const startedAt=new Date().toISOString();
      try{
        const result=await invokeTask(String(task.function_slug),task.config||{},Number(task.timeout_ms)||20000,maintenanceSecret);
        succeeded++;
        details.push({task_key:task.task_key,function_slug:task.function_slug,status:"success",started_at:startedAt,finished_at:new Date().toISOString(),result});
      }catch(e){
        failed++;
        details.push({task_key:task.task_key,function_slug:task.function_slug,status:"failed",started_at:startedAt,finished_at:new Date().toISOString(),error:String((e as Error)?.message||e)});
      }
    }

    const status=failed===0?"success":succeeded>0?"partial_failure":"failed";
    if(runId)await rest("PATCH",`maintenance_runner_runs?id=eq.${encodeURIComponent(runId)}`,{finished_at:new Date().toISOString(),status,tasks_succeeded:succeeded,tasks_failed:failed,details});
    return json({ok:failed===0,status,tasks_total:(tasks||[]).length,tasks_succeeded:succeeded,tasks_failed:failed,run_id:runId||null,details});
  }catch(e){
    console.error(e);
    return json({ok:false,error:String((e as Error)?.message||e)},500);
  }
});