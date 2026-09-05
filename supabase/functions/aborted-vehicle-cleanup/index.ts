import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RELEASE_PRODUCT="ParkingMartin-G";
const RELEASE_VERSION="1.4.0";
const RELEASE_BUILD="2026.09.04.04";
const RELEASE_SOURCE_REVISION="632ffe78ed03d2addcf352ee85199b3f235332c3";

const headers=(extra:Record<string,string>={})=>({
  Authorization:`Bearer ${SERVICE_KEY}`,
  apikey:SERVICE_KEY,
  ...extra
});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{
  status,
  headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}
});
function attest(){return json({ok:true,product:RELEASE_PRODUCT,function:"aborted-vehicle-cleanup",version:RELEASE_VERSION,build:RELEASE_BUILD,source_revision:RELEASE_SOURCE_REVISION})}
async function rpc(name:string,body:unknown){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:"POST",headers:headers({"Content-Type":"application/json"}),body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d?.message||d?.error||`rpc_${name}_failed`);
  return d;
}
async function table(method:string,path:string,body?:unknown){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:headers({"Content-Type":"application/json","Prefer":"return=representation"}),body:body===undefined?undefined:JSON.stringify(body)});
  const d=await r.json().catch(()=>null);
  if(!r.ok)throw new Error((d as any)?.message||`rest_${method}_failed`);
  return d;
}
async function deleteObject(path:string){
  const encoded=path.split("/").map(encodeURIComponent).join("/");
  const r=await fetch(`${SUPABASE_URL}/storage/v1/object/vehicle-evidence/${encoded}`,{method:"DELETE",headers});
  if(r.ok||r.status===404)return;
  throw new Error(`storage_delete_failed_${r.status}`);
}

Deno.serve(async req=>{
  const u=new URL(req.url);
  if(req.method==="GET"&&u.searchParams.get("attest")==="1")return attest();
  if(req.method!=="POST")return json({ok:false,error:"method_not_allowed"},405);
  try{
    const cleanupSecret=req.headers.get("x-cleanup-secret")||"";
    const maintenanceSecret=req.headers.get("x-maintenance-secret")||"";
    const cleanupAuthorized=Boolean(cleanupSecret)&&Boolean(await rpc("validate_aborted_vehicle_cleanup_secret",{p_secret:cleanupSecret}));
    const maintenanceAuthorized=Boolean(maintenanceSecret)&&Boolean(await rpc("validate_maintenance_runner_secret",{p_secret:maintenanceSecret}));
    if(!cleanupAuthorized&&!maintenanceAuthorized)return json({ok:false,error:"not_authorized"},403);
    const body=await req.json().catch(()=>({}));
    const dryRun=Boolean(body?.dry_run);
    const limit=Math.max(1,Math.min(Number(body?.limit)||25,100));
    const candidates=await rpc("aborted_vehicle_cleanup_candidates",{p_limit:limit});
    if(dryRun)return json({ok:true,dry_run:true,candidates:(candidates||[]).map((x:any)=>({vehicle_id:x.vehicle_id,plate:x.normalized_plate,cleanup_eligible_at:x.cleanup_eligible_at,storage_objects:(x.storage_paths||[]).length}))});

    const runRows=await table("POST","maintenance_cleanup_runs",{cleanup_type:"aborted_provisional_vehicle",candidates:(candidates||[]).length});
    const runId=runRows?.[0]?.id;
    let deleted=0,skipped=0,failed=0;
    const details:any[]=[];

    for(const candidate of candidates||[]){
      const token=crypto.randomUUID();
      try{
        const claim=await rpc("claim_aborted_vehicle_cleanup",{p_vehicle_id:candidate.vehicle_id,p_claim_token:token});
        if(!claim?.claimed){skipped++;details.push({vehicle_id:candidate.vehicle_id,plate:candidate.normalized_plate,status:"skipped",reason:claim?.reason||"not_claimed"});continue}
        for(const path of claim.storage_paths||[])await deleteObject(String(path));
        const result=await rpc("delete_aborted_vehicle_if_still_eligible",{p_vehicle_id:candidate.vehicle_id,p_claim_token:token});
        if(result?.deleted){deleted++;details.push({vehicle_id:candidate.vehicle_id,plate:candidate.normalized_plate,status:"deleted",storage_objects:(claim.storage_paths||[]).length})}
        else{skipped++;details.push({vehicle_id:candidate.vehicle_id,plate:candidate.normalized_plate,status:"skipped",reason:result?.reason||"not_deleted"});await rpc("release_aborted_vehicle_cleanup_claim",{p_vehicle_id:candidate.vehicle_id,p_claim_token:token}).catch(()=>false)}
      }catch(e){
        failed++;
        details.push({vehicle_id:candidate.vehicle_id,plate:candidate.normalized_plate,status:"failed",error:String((e as Error)?.message||e)});
        await rpc("release_aborted_vehicle_cleanup_claim",{p_vehicle_id:candidate.vehicle_id,p_claim_token:token}).catch(()=>false);
      }
    }
    if(runId)await table("PATCH",`maintenance_cleanup_runs?id=eq.${encodeURIComponent(runId)}`,{finished_at:new Date().toISOString(),deleted,skipped,failed,details});
    return json({ok:true,candidates:(candidates||[]).length,deleted,skipped,failed,run_id:runId||null});
  }catch(e){
    console.error(e);
    return json({ok:false,error:String((e as Error)?.message||e)},500);
  }
});