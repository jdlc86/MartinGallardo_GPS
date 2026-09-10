import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const RELEASE_PRODUCT="ParkingMartin-G";
const RELEASE_VERSION="1.4.0";
const RELEASE_BUILD="2026.09.04.04";
const RELEASE_SOURCE_REVISION="b103000000000000000000000000000000000002";
function releaseAttestation(){return new Response(JSON.stringify({ok:true,product:RELEASE_PRODUCT,function:"telegram-modern-action",version:RELEASE_VERSION,build:RELEASE_BUILD,source_revision:RELEASE_SOURCE_REVISION}),{headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}

const BOT_TOKEN=Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS_JSON=Deno.env.get("SUPABASE_SECRET_KEYS");
const LEGACY_SERVICE_ROLE_KEY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANALYTICS_ACCESS_TOKEN=Deno.env.get("ANALYTICS_ACCESS_TOKEN")||"";
const ANALYTICS_PROJECT_REF="mvexykcxnpaywkbnoxwu";
const ANALYTICS_FUNCTIONS=[
["telegram-bot","b6b9e420-d179-486f-8017-c0556a03448e"],["parking-location","59cd128e-584e-49aa-a562-5f557dc97f98"],["telegram-keyboard-reset","2ebb5780-c455-4a42-b8f1-78547683c50e"],["telegram-router","7a15bc65-315d-45ef-bf85-f5cb3e1584bd"],["miniapp-launch-test","d23e3ec8-9a60-48a7-92f7-6a06e3586074"],["telegram-router3","3ef274a5-319f-4fcc-8998-2d0f50ae7a60"],["telegram-diagnostics","d463ea63-695c-46e1-b374-6d16d05db311"],["telegram-location-submit","ba71f084-7523-4295-9716-8de47260f199"],["vehicle-consult-api","daf9cc62-f2a2-4569-b4fe-5b0855c82e0a"],["telegram-entry","d5996144-80af-4001-a687-bde2ef7d3906"],["telegram-gateway","930afbe6-6817-4f81-8bc7-b127eebaa160"],["telegram-modern-action","f87aac26-2211-46d2-8a0d-468565c58f41"],["vehicle-share-api","082f2df4-fd00-4ff8-b74b-b5faa0552dd5"],["vehicle-report-api","9a3cbf2d-f767-408a-b526-3e77aab7e06e"],["modern-parking-api","3c231b1a-a1c7-4fb1-bdb5-54eb77d14e0e"],["modern-search-api","ddc9b218-5580-4a77-af9f-1b0d17121071"],["modern-pickup-api","2490a021-5afe-4bb2-83d8-cdd33da1b8b3"],["modern-delivery-api","a92db76f-27e6-4596-ac20-b9d7621db811"],["modern-live-team-api","3e3b0a31-b971-428f-9bae-f87d6fbbfcff"],["performance-report-sender","189a760c-c40b-44d5-a670-9c398b432d23"],["modern-relocate-api","97320843-2158-4fa8-b768-d215ed9cbb21"],["reservation-admin-api","61dc352e-8d20-4be4-a361-c228b8f9134b"],["reservation-operational-api","4f479be6-1f50-4807-8ce6-6c0b5b53a834"],["vehicle-lifecycle-api","d6fc162d-ec1c-4a6a-aa54-4e7c1649c91b"],["reservation-task-api","c033d3b1-caa8-41f9-8d9b-5ef7b91f8b39"],["reservation-notification-sender","66d55747-c4d3-4dc1-b435-9a8272f666dd"],["telegram-identity-sync","21e4daa0-8e21-46cf-9e3e-2e1c923addee"],["reservation-ai-planner","86e193c0-9612-4cd6-8270-2a8e75c461bd"],["reservation-ai-global-solver","08dcdc4f-0a03-4ce3-ba9f-594f01686363"],["reservation-ai-planner-v2","5dd4d738-02d0-441d-bfb5-701a2467666c"],["reservation-ai-global-solver-v2","339fab14-031c-4b64-a9ab-ce9e237f4e84"],["reservation-ai-seed-v1","65f81565-3c5c-414b-86c1-6e8eceff0737"],["reservation-optimization-jobs-v1","0af7e5bf-43a1-4854-bd66-6543567c7dca"],["reservation-optimizer-benchmark-v1","0da848c9-3df8-47ff-bd97-f2c38087ac3f"],["aborted-vehicle-cleanup","fa42f0e7-9ca1-4284-b14a-4598ba048c9e"],["maintenance-runner","a2a18382-f20b-45b1-adbf-056a7cff1a2f"],["connectivity-health","18e7b4a2-a9dd-4bd0-8699-48cbd4e57b60"],["miniapp-access-session-api","d09f8885-a211-463b-8045-830f049ecd92"],["resource-analytics-probe","bf6a5ce6-9189-4ab3-8f9c-997945629856"]
] as const;
const ALLOW_ORIGIN="https://jdlc86.github.io";
const APP_URL="https://jdlc86.github.io/MartinGallardo_GPS/preview-modern/?v=20260910B03";
const INIT_DATA_MAX_AGE_SECONDS=600;
function serverKey(){if(SECRET_KEYS_JSON){try{const p=JSON.parse(SECRET_KEYS_JSON);if(p?.default)return p.default;const v=Object.values(p??{})[0];if(typeof v==="string")return v}catch{}}if(LEGACY_SERVICE_ROLE_KEY)return LEGACY_SERVICE_ROLE_KEY;throw new Error("No server key")}
function hdr(extra:Record<string,string>={}){const k=serverKey();return{apikey:k,Authorization:`Bearer ${k}`,...extra}}
function cors(){return{"Access-Control-Allow-Origin":ALLOW_ORIGIN,"Access-Control-Allow-Headers":"content-type","Access-Control-Allow-Methods":"POST,OPTIONS","Vary":"Origin"}}
function json(data:any,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json",...cors()}})}
function eqBytes(a:Uint8Array,b:Uint8Array){if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a[i]^b[i];return x===0}
function hexToBytes(s:string){if(!/^[0-9a-fA-F]{64}$/.test(s))return null;const out=new Uint8Array(32);for(let i=0;i<32;i++)out[i]=parseInt(s.slice(i*2,i*2+2),16);return out}
async function hmac(key:Uint8Array|string,msg:string){const kb=typeof key==="string"?new TextEncoder().encode(key):key;const k=await crypto.subtle.importKey("raw",kb,{name:"HMAC",hash:"SHA-256"},false,["sign"]);return new Uint8Array(await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(msg)))}
async function validateInitData(initData:string){const p=new URLSearchParams(initData),hash=p.get("hash")??"";p.delete("hash");const pairs:[string,string][]=[];for(const[k,v]of p.entries())pairs.push([k,v]);pairs.sort((a,b)=>a[0].localeCompare(b[0]));const check=pairs.map(([k,v])=>`${k}=${v}`).join("\n"),secret=await hmac("WebAppData",BOT_TOKEN),calc=await hmac(secret,check),given=hexToBytes(hash);if(!given||!eqBytes(calc,given))throw new Error("invalid_init_data");const auth=Number(p.get("auth_date")??0);if(!Number.isFinite(auth)||Math.abs(Date.now()/1000-auth)>INIT_DATA_MAX_AGE_SECONDS)throw new Error("expired_init_data");let user:any=null;try{user=JSON.parse(p.get("user")??"null")}catch{}const id=Number(user?.id);if(!Number.isFinite(id))throw new Error("missing_user");return{id,user}}
async function sha256AccessToken(value:string){const d=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));return[...d].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function validateAccessSession(token:string){if(!token)return null;const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/validate_miniapp_access_session`,{method:"POST",headers:hdr({"Content-Type":"application/json"}),body:JSON.stringify({p_token_hash:await sha256AccessToken(token)})});if(!r.ok)throw new Error("access_session_validation_failed");const data=await r.json();const row=Array.isArray(data)?data[0]:data;if(!row?.telegram_user_id)throw new Error("expired_access_session");return Number(row.telegram_user_id)}
async function authenticateRequest(initData:string,token:string){const uid=await validateAccessSession(token);if(uid)return{id:uid,user:null};return validateInitData(initData)}

async function request(table:string,params:Record<string,string>){const u=new URL(`${SUPABASE_URL}/rest/v1/${table}`);for(const[k,v]of Object.entries(params))u.searchParams.set(k,v);const r=await fetch(u,{headers:hdr({Accept:"application/json"})});if(!r.ok)throw new Error(await r.text());return{rows:await r.json()}}
async function one(table:string,params:Record<string,string>){return(await request(table,{...params,limit:"1"})).rows[0]??null}
async function write(method:string,table:string,filters:Record<string,string>,body:any){const u=new URL(`${SUPABASE_URL}/rest/v1/${table}`);for(const[k,v]of Object.entries(filters))u.searchParams.set(k,v);const r=await fetch(u,{method,headers:hdr({"Content-Type":"application/json",Prefer:"return=minimal"}),body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text())}
async function insert(table:string,body:any){return write("POST",table,{},body)}
async function patch(table:string,filters:Record<string,string>,body:any){return write("PATCH",table,filters,body)}
async function rpc(name:string,body:any={}){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:"POST",headers:hdr({"Content-Type":"application/json"}),body:JSON.stringify(body)});
  if(!r.ok)throw new Error(await r.text());
  return await r.json();
}
async function currentUser(id:number){return one("telegram_users",{telegram_user_id:`eq.${id}`,select:"telegram_user_id,username,first_name,last_name,role,active,deactivated_at,created_at"})}
function nameOf(x:any){return [x?.first_name,x?.last_name].filter(Boolean).join(" ")||(x?.username?`@${x.username}`:`Usuario ${x?.telegram_user_id??""}`)}
function visibleRole(role:string){return role==="owner"?"Root":role==="admin"?"Admin":"Operario"}
async function tg(method:string,body:any){const r=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(!r.ok)throw new Error(`telegram_${method}_${r.status}`)}
async function notify(user:any,type:string){try{const role=visibleRole(String(user.role)),name=nameOf(user);let text=type==="approved"?`✅ ¡Bienvenido a ParkingMartin-G, ${name}!\n\nTu solicitud ha sido aceptada.\n\n👤 Rol asignado: ${role}`:type==="reactivated"?`✅ ¡Bienvenido de nuevo, ${name}!\n\n👤 Rol: ${role}`:`👤 Tu rol ha cambiado\n\nNuevo rol: ${role}`;await tg("sendMessage",{chat_id:Number(user.telegram_user_id),text,reply_markup:{inline_keyboard:[[{text:"🚘 ABRIR PARKINGMARTIN-G",web_app:{url:APP_URL}}]]}})}catch(e){console.error(e)}}
async function requireAdmin(id:number){const u=await currentUser(id);if(!u||!u.active||(u.role!=="owner"&&u.role!=="admin"))throw new Error("not_admin");return u}
async function requireOwner(id:number){const u=await currentUser(id);if(!u||!u.active||u.role!=="owner")throw new Error("not_owner");return u}
function validPercent(v:number){return Number.isFinite(v)&&v>0&&v<=100}
async function analyticsGet(path:string){
  if(!ANALYTICS_ACCESS_TOKEN)throw new Error("analytics_token_unavailable");
  const r=await fetch(`https://api.supabase.com/v1/projects/${ANALYTICS_PROJECT_REF}/analytics/endpoints/${path}`,{
    headers:{Authorization:`Bearer ${ANALYTICS_ACCESS_TOKEN}`,Accept:"application/json"}
  });
  const text=await r.text();let data:any=null;
  try{data=text?JSON.parse(text):null}catch{data={raw:text}}
  if(!r.ok)throw new Error(`analytics_${r.status}`);
  return data;
}
function exactCount(data:any){
  if(Number.isFinite(Number(data?.count)))return Number(data.count);
  const rows=Array.isArray(data?.result)?data.result:[];
  if(rows.length===1&&Number.isFinite(Number(rows[0]?.count)))return Number(rows[0].count);
  return null;
}
function exactInvocationCount(data:any){
  if(Number.isFinite(Number(data?.count)))return Number(data.count);
  const rows=Array.isArray(data?.result)?data.result.filter((x:any)=>x&&typeof x==="object"):[];
  if(!rows.length)return 0;
  if(rows.every((x:any)=>Number.isFinite(Number(x.request_count))))return rows.reduce((n:number,x:any)=>n+Number(x.request_count),0);
  for(const key of ["total_invocations","invocations","invocation_count","count"]){
    if(rows.length===1&&Number.isFinite(Number(rows[0]?.[key])))return Number(rows[0][key]);
  }
  if(rows.every((x:any)=>Number.isFinite(Number(x.count))))return rows.reduce((n:number,x:any)=>n+Number(x.count),0);
  return null;
}
async function refreshResourceAnalytics(actorId:number){
  await requireOwner(actorId);

  const apiPromise=(async()=>{
    try{
      const api=await analyticsGet("usage.api-requests-count");
      const count=exactCount(api);
      return {count,error:count===null?"api_response_unrecognized":null};
    }catch(e){
      return {count:null,error:String((e as Error)?.message||e)};
    }
  })();

  const edgeResults=await Promise.all(ANALYTICS_FUNCTIONS.map(async([slug,id])=>{
    try{
      const d=await analyticsGet(`functions.combined-stats?interval=1day&function_id=${encodeURIComponent(id)}`);
      const count=exactInvocationCount(d);
      return {slug,id,count,result:d?.result??null,error:count===null?"edge_response_unrecognized":null};
    }catch(e){
      return {slug,id,count:null,result:null,error:String((e as Error)?.message||e)};
    }
  }));

  const apiResult=await apiPromise;
  const successful=edgeResults.filter((x:any)=>x.count!==null);
  const edgeKnown=successful.length===edgeResults.length;
  const edgeTotal=edgeKnown?successful.reduce((n:number,x:any)=>n+Number(x.count),0):null;

  await insert("resource_usage_snapshots",{
    api_requests:apiResult.count,
    edge_function_invocations:edgeTotal,
    edge_functions_checked:edgeResults.length,
    raw_edge_stats:edgeResults.map((x:any)=>({slug:x.slug,id:x.id,result:x.result,error:x.error})),
    error_metadata:{
      api_requests_known:apiResult.count!==null,
      api_error:apiResult.error,
      edge_invocations_known:edgeKnown,
      edge_errors:edgeResults.filter((x:any)=>x.error).map((x:any)=>({slug:x.slug,error:x.error}))
    }
  });
  return await rpc("resource_observability_snapshot");
}
async function resourceObservabilityData(actorId:number){
  await requireOwner(actorId);
  const snapshot=await rpc("resource_observability_snapshot");
  return snapshot;
}
async function updateResourceBudget(actorId:number,body:any){
  await requireOwner(actorId);
  const databaseMb=Number(body.database_budget_mb);
  const storageRaw=body.storage_budget_mb;
  const storageMb=storageRaw===null||storageRaw===undefined||String(storageRaw).trim()===""?null:Number(storageRaw);
  const apiRaw=body.api_requests_budget;
  const edgeRaw=body.edge_function_invocations_budget;
  const apiBudget=apiRaw===null||apiRaw===undefined||String(apiRaw).trim()===""?null:Number(apiRaw);
  const edgeBudget=edgeRaw===null||edgeRaw===undefined||String(edgeRaw).trim()===""?null:Number(edgeRaw);
  const warning=Number(body.warning_percent);
  const critical=Number(body.critical_percent);
  if(!Number.isFinite(databaseMb)||databaseMb<=0||databaseMb>102400)throw new Error("invalid_database_budget");
  if(storageMb!==null&&(!Number.isFinite(storageMb)||storageMb<=0||storageMb>1024000))throw new Error("invalid_storage_budget");
  if(apiBudget!==null&&(!Number.isFinite(apiBudget)||apiBudget<=0||apiBudget>1000000000000))throw new Error("invalid_api_requests_budget");
  if(edgeBudget!==null&&(!Number.isFinite(edgeBudget)||edgeBudget<=0||edgeBudget>1000000000000))throw new Error("invalid_edge_invocations_budget");
  if(!validPercent(warning)||!validPercent(critical)||warning>=critical)throw new Error("invalid_thresholds");
  await patch("resource_observability_config",{id:"eq.true"},{
    database_budget_bytes:Math.round(databaseMb*1048576),
    storage_budget_bytes:storageMb===null?null:Math.round(storageMb*1048576),
    api_requests_budget:apiBudget===null?null:Math.round(apiBudget),
    edge_function_invocations_budget:edgeBudget===null?null:Math.round(edgeBudget),
    warning_percent:warning,
    critical_percent:critical,
    updated_at:new Date().toISOString(),
    updated_by_telegram_user_id:actorId
  });
  return await resourceObservabilityData(actorId);
}
async function syncWorker(target:any){const role=target.role==="owner"||target.role==="admin"?"admin":"operator";const w=await one("workers",{telegram_user_id:`eq.${target.telegram_user_id}`,select:"id"});if(w)await patch("workers",{telegram_user_id:`eq.${target.telegram_user_id}`},{full_name:nameOf(target),role,active:target.active,deactivated_at:target.active?null:new Date().toISOString()});else if(target.active)await insert("workers",{telegram_user_id:target.telegram_user_id,full_name:nameOf(target),role,active:true})}
async function teamData(actorId:number){await requireAdmin(actorId);const pending=(await request("telegram_access_requests",{status:"eq.pending",select:"telegram_user_id,username,first_name,last_name,last_seen_at,expires_at,attempts",order:"last_seen_at.desc",limit:"50"})).rows,active=(await request("telegram_users",{active:"eq.true",select:"telegram_user_id,username,first_name,last_name,role,active,created_at",order:"created_at.asc",limit:"100"})).rows,blocked=(await request("telegram_users",{active:"eq.false",select:"telegram_user_id,username,first_name,last_name,role,active,deactivated_at",order:"deactivated_at.desc",limit:"100"})).rows;return{pending,active,blocked,stats:{active:active.length,admins:active.filter((x:any)=>x.role==="admin").length,pending:pending.length,blocked:blocked.length}}}
async function adminAction(actorId:number,targetId:number,op:string){await requireAdmin(actorId);if(targetId===actorId)throw new Error("self_change_not_allowed");const before=await currentUser(targetId);if(before?.role==="owner")throw new Error("owner_protected");if(op==="approve"||op==="approve_admin"){const req=await one("telegram_access_requests",{telegram_user_id:`eq.${targetId}`,select:"telegram_user_id,username,first_name,last_name,status"}),role=op==="approve_admin"?"admin":"operario";if(before)await patch("telegram_users",{telegram_user_id:`eq.${targetId}`},{role,active:true,deactivated_at:null});else await insert("telegram_users",{telegram_user_id:targetId,username:req?.username??null,first_name:req?.first_name??null,last_name:req?.last_name??null,role,active:true});await patch("telegram_access_requests",{telegram_user_id:`eq.${targetId}`},{status:"approved",expires_at:null});const after=await currentUser(targetId);await syncWorker(after);await notify(after,"approved");return}if(!before)throw new Error("target_not_found");if(op==="deactivate")await patch("telegram_users",{telegram_user_id:`eq.${targetId}`},{active:false,deactivated_at:new Date().toISOString()});else if(op==="reactivate")await patch("telegram_users",{telegram_user_id:`eq.${targetId}`},{active:true,deactivated_at:null});else if(op==="promote")await patch("telegram_users",{telegram_user_id:`eq.${targetId}`},{role:"admin",active:true,deactivated_at:null});else if(op==="demote")await patch("telegram_users",{telegram_user_id:`eq.${targetId}`},{role:"operario"});else if(op==="reject")await patch("telegram_access_requests",{telegram_user_id:`eq.${targetId}`},{status:"rejected",expires_at:null});else throw new Error("invalid_admin_action");const after=await currentUser(targetId);if(after){await syncWorker(after);if(op==="reactivate"||op==="promote"||op==="demote")await notify(after,op==="reactivate"?"reactivated":"role")}}
async function vehiclesData(){return(await request("vehicles",{select:"id,plate,normalized_plate,status,parked_at,updated_at,current_lat,current_lng,current_accuracy_m,current_location_text",order:"updated_at.desc",limit:"100"})).rows}
async function recentData(){const events=(await request("parking_events",{select:"id,vehicle_id,worker_id,operation,location_text,gps_quality,created_at,metadata",order:"created_at.desc",limit:"80"})).rows;const vehicleIds=[...new Set(events.map((x:any)=>x.vehicle_id).filter(Boolean))],workerIds=[...new Set(events.map((x:any)=>x.worker_id).filter(Boolean))];let vehicles:any[]=[],workers:any[]=[];if(vehicleIds.length)vehicles=(await request("vehicles",{id:`in.(${vehicleIds.join(",")})`,select:"id,plate,status"})).rows;if(workerIds.length)workers=(await request("workers",{id:`in.(${workerIds.join(",")})`,select:"id,full_name,role"})).rows;const vm=Object.fromEntries(vehicles.map((v:any)=>[v.id,v])),wm=Object.fromEntries(workers.map((w:any)=>[w.id,w]));return events.map((e:any)=>({...e,vehicle:e.vehicle_id?vm[e.vehicle_id]??null:null,worker:e.worker_id?wm[e.worker_id]??null:null}))}
const madridFmt=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Madrid",year:"numeric",month:"2-digit",day:"2-digit"});
async function workerDailyStats(telegramUserId:number){const worker=await one("workers",{telegram_user_id:`eq.${telegramUserId}`,select:"id"});if(!worker)return{picked_up:0,parked:0,relocated:0,delivered:0};const day=madridFmt.format(new Date()),events=(await request("parking_events",{worker_id:`eq.${worker.id}`,operation:"in.(pickup,park,relocate,retrieve)",select:"operation,created_at",order:"created_at.desc",limit:"1000"})).rows.filter((e:any)=>madridFmt.format(new Date(e.created_at))===day);return{picked_up:events.filter((e:any)=>e.operation==="pickup").length,parked:events.filter((e:any)=>e.operation==="park").length,relocated:events.filter((e:any)=>e.operation==="relocate").length,delivered:events.filter((e:any)=>e.operation==="retrieve").length}}
Deno.serve(async(req:Request)=>{const requestUrl=new URL(req.url);if(req.method==="GET"&&requestUrl.searchParams.get("attest")==="1")return releaseAttestation();if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors()});if(req.method!=="POST")return json({ok:false,error:"method_not_allowed"},405);try{const origin=req.headers.get("Origin");if(origin&&origin!==ALLOW_ORIGIN)return json({ok:false,error:"origin_not_allowed"},403);const body=await req.json(),auth=await authenticateRequest(String(body.initData??""),String(body.access_session_token??"")),user=await one("telegram_users",{telegram_user_id:`eq.${auth.id}`,active:"eq.true",select:"telegram_user_id,role,active"});if(!user)return json({ok:false,error:"not_authorized"},403);const action=String(body.action??"");if(action==="dashboard")return json({ok:true,role:user.role,stats:await workerDailyStats(auth.id)});if(action==="vehicles_dashboard")return json({ok:true,role:user.role,vehicles:await vehiclesData()});if(action==="recent_activity")return json({ok:true,role:user.role,events:await recentData()});if(action==="team_dashboard")return json({ok:true,role:user.role,...await teamData(auth.id)});if(action==="resource_observability")return json({ok:true,role:user.role,resources:await resourceObservabilityData(auth.id)});if(action==="resource_analytics_refresh")return json({ok:true,role:user.role,resources:await refreshResourceAnalytics(auth.id)});if(action==="resource_budget_update")return json({ok:true,role:user.role,resources:await updateResourceBudget(auth.id,body)});if(action==="admin_action"){const targetId=Number(body.target_id),op=String(body.admin_action??"");if(!Number.isFinite(targetId))return json({ok:false,error:"invalid_target"},400);await adminAction(auth.id,targetId,op);return json({ok:true,...await teamData(auth.id)})}return json({ok:false,error:"invalid_action"},400)}catch(e){console.error(e);const m=String((e as Error)?.message??e);return json({ok:false,error:m},["not_admin","not_owner"].includes(m)?403:400)}});
