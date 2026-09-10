import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const headers=(extra:Record<string,string>={})=>({Authorization:`Bearer ${SERVICE_KEY}`,apikey:SERVICE_KEY,...extra});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
async function rpc(name:string,body:unknown){const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:"POST",headers:headers({"Content-Type":"application/json"}),body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error((d as any)?.message||(d as any)?.error||`rpc_${name}_failed`);return d}
async function authorized(secret:string){return Boolean(secret)&&Boolean(await rpc("validate_maintenance_runner_secret",{p_secret:secret}))}
async function deleteObject(bucket:string,path:string){const b=encodeURIComponent(bucket),p=path.split('/').map(encodeURIComponent).join('/');const r=await fetch(`${SUPABASE_URL}/storage/v1/object/${b}/${p}`,{method:"DELETE",headers:headers()});if(r.ok||r.status===404)return;throw new Error(`storage_delete_failed_${r.status}`)}

Deno.serve(async req=>{
  if(req.method!=="POST")return json({ok:false,error:"method_not_allowed"},405);
  try{
    const secret=req.headers.get("x-maintenance-secret")||"";
    if(!(await authorized(secret)))return json({ok:false,error:"not_authorized"},403);
    const body=await req.json().catch(()=>({}));
    const phase=String(body?.phase||"");
    if(phase!=="evidence"&&phase!=="history")return json({ok:false,error:"invalid_phase"},400);
    const limit=Math.max(1,Math.min(Number(body?.limit)||25,100));
    const execute=body?.execute===true;
    const candidates=await rpc("delivered_stay_retention_candidates",{p_phase:phase,p_limit:limit});
    if(!execute)return json({ok:true,dry_run:true,phase,candidates:(candidates||[]).map((x:any)=>({stay_id:x.stay_id,plate:x.normalized_plate,stay_code:x.stay_code,delivered_at:x.delivered_at,eligible_at:x.eligible_at,storage_objects:Array.isArray(x.storage_objects)?x.storage_objects.length:0}))});

    let purged=0,skipped=0,failed=0;const details:any[]=[];
    for(const c of candidates||[]){
      const token=crypto.randomUUID();
      try{
        const claim=await rpc("claim_delivered_stay_retention",{p_stay_id:c.stay_id,p_phase:phase,p_claim_token:token});
        if(!claim?.claimed){skipped++;details.push({stay_id:c.stay_id,stay_code:c.stay_code,status:"skipped",reason:claim?.reason||"not_claimed"});continue}
        if(phase==="evidence")for(const obj of claim.storage_objects||[])await deleteObject(String(obj.bucket||"vehicle-evidence"),String(obj.path||""));
        const result=await rpc(phase==="evidence"?"finalize_delivered_stay_evidence_purge":"finalize_delivered_stay_history_purge",{p_stay_id:c.stay_id,p_claim_token:token});
        if(result?.purged){purged++;details.push({stay_id:c.stay_id,stay_code:c.stay_code,status:"purged",storage_objects:phase==="evidence"?(claim.storage_objects||[]).length:0,vehicle_deleted:Boolean(result?.vehicle_deleted)})}
        else{skipped++;details.push({stay_id:c.stay_id,stay_code:c.stay_code,status:"skipped",reason:result?.reason||"not_purged"});await rpc("release_delivered_stay_retention_claim",{p_stay_id:c.stay_id,p_claim_token:token}).catch(()=>false)}
      }catch(e){failed++;details.push({stay_id:c.stay_id,stay_code:c.stay_code,status:"failed",error:String((e as Error)?.message||e)});await rpc("release_delivered_stay_retention_claim",{p_stay_id:c.stay_id,p_claim_token:token}).catch(()=>false)}
    }
    return json({ok:failed===0,phase,dry_run:false,candidates:(candidates||[]).length,purged,skipped,failed,details},failed===0?200:207);
  }catch(e){console.error(e);return json({ok:false,error:String((e as Error)?.message||e)},500)}
});
