import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BOT_TOKEN=Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS_JSON=Deno.env.get("SUPABASE_SECRET_KEYS");
const LEGACY_SERVICE_ROLE_KEY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ALLOW_ORIGIN="https://jdlc86.github.io";

function serverKey(){
  if(SECRET_KEYS_JSON){
    try{const p=JSON.parse(SECRET_KEYS_JSON);if(p?.default)return p.default;const v=Object.values(p??{})[0];if(typeof v==="string")return v}catch{}
  }
  if(LEGACY_SERVICE_ROLE_KEY)return LEGACY_SERVICE_ROLE_KEY;
  throw new Error("No server key");
}
function hdr(extra:Record<string,string>={}){const k=serverKey();return{apikey:k,Authorization:`Bearer ${k}`,...extra}}
function cors(){return{"Access-Control-Allow-Origin":ALLOW_ORIGIN,"Access-Control-Allow-Headers":"content-type","Access-Control-Allow-Methods":"POST,OPTIONS","Vary":"Origin"}}
function json(data:any,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store",...cors()}})}
function eqBytes(a:Uint8Array,b:Uint8Array){if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a[i]^b[i];return x===0}
function hexToBytes(s:string){if(!/^[0-9a-fA-F]{64}$/.test(s))return null;const out=new Uint8Array(32);for(let i=0;i<32;i++)out[i]=parseInt(s.slice(i*2,i*2+2),16);return out}
async function hmac(key:Uint8Array|string,msg:string){const kb=typeof key==="string"?new TextEncoder().encode(key):key;const k=await crypto.subtle.importKey("raw",kb,{name:"HMAC",hash:"SHA-256"},false,["sign"]);return new Uint8Array(await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(msg)))}
async function validateInitData(initData:string){
  const p=new URLSearchParams(initData),hash=p.get("hash")??"";p.delete("hash");
  const pairs:[string,string][]=[];for(const [k,v] of p.entries())pairs.push([k,v]);pairs.sort((a,b)=>a[0].localeCompare(b[0]));
  const check=pairs.map(([k,v])=>`${k}=${v}`).join("\n"),secret=await hmac("WebAppData",BOT_TOKEN),calc=await hmac(secret,check),given=hexToBytes(hash);
  if(!given||!eqBytes(calc,given))throw new Error("invalid_init_data");
  const auth=Number(p.get("auth_date")??0);if(!Number.isFinite(auth)||Math.abs(Date.now()/1000-auth)>600)throw new Error("expired_init_data");
  let user:any=null;try{user=JSON.parse(p.get("user")??"null")}catch{};const id=Number(user?.id);if(!Number.isFinite(id))throw new Error("missing_user");return{id,user};
}
async function sha256AccessToken(value:string){const d=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));return[...d].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function validateAccessSession(token:string){if(!token)return null;const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/validate_miniapp_access_session`,{method:"POST",headers:hdr({"Content-Type":"application/json"}),body:JSON.stringify({p_token_hash:await sha256AccessToken(token)})});if(!r.ok)throw new Error("access_session_validation_failed");const data=await r.json(),row=Array.isArray(data)?data[0]:data;if(!row?.telegram_user_id)throw new Error("expired_access_session");return Number(row.telegram_user_id)}
async function authenticateRequest(initData:string,token:string){const uid=await validateAccessSession(token);return uid?{id:uid,user:null}:validateInitData(initData)}

async function rest(table:string,params:Record<string,string>){const u=new URL(`${SUPABASE_URL}/rest/v1/${table}`);for(const[k,v]of Object.entries(params))u.searchParams.set(k,v);const r=await fetch(u,{headers:hdr({Accept:"application/json"})});if(!r.ok)throw new Error(await r.text());return r.json()}
async function insert(table:string,body:any){const r=await fetch(`${SUPABASE_URL}/rest/v1/${table}`,{method:"POST",headers:hdr({"Content-Type":"application/json",Prefer:"return=representation"}),body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());const d=await r.json();return d[0]??null}
async function patch(table:string,params:Record<string,string>,body:any){const u=new URL(`${SUPABASE_URL}/rest/v1/${table}`);for(const[k,v]of Object.entries(params))u.searchParams.set(k,v);const r=await fetch(u,{method:"PATCH",headers:hdr({"Content-Type":"application/json",Prefer:"return=representation"}),body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());return r.json()}
async function signedUrl(bucket:string,path:string){const safePath=path.split('/').map(encodeURIComponent).join('/');const r=await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${safePath}`,{method:"POST",headers:hdr({"Content-Type":"application/json"}),body:JSON.stringify({expiresIn:900})});if(!r.ok)return null;const j:any=await r.json(),p=j.signedURL||j.signedUrl||j.signed_url;if(!p)return null;if(p.startsWith("http"))return p;if(p.startsWith("/storage/v1/"))return `${SUPABASE_URL}${p}`;if(p.startsWith("/object/"))return `${SUPABASE_URL}/storage/v1${p}`;return `${SUPABASE_URL}/storage/v1/${p.replace(/^\/+/,"")}`}

const norm=(s:string)=>s.toUpperCase().replace(/[^A-Z0-9]/g,"");
const isManager=(role:string)=>role==="owner"||role==="admin";

async function findVehicleAndStays(plate:string){
  const vs=await rest("vehicles",{normalized_plate:`eq.${plate}`,select:"*",limit:"1"});
  if(!vs.length)throw new Error("not_found");
  const vehicle=vs[0];
  const stays=await rest("vehicle_stays",{vehicle_id:`eq.${vehicle.id}`,select:"id,vehicle_id,normalized_plate,stay_code,sequence_on_day,started_at,delivered_at,status,evidence_purged_at,history_purge_eligible_at,created_at,updated_at",order:"started_at.desc",limit:"200"});
  if(!stays.length)throw new Error("stay_not_found");
  return{vehicle,stays};
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors()});
  if(req.method!=="POST")return json({ok:false,error:"method_not_allowed"},405);
  try{
    const origin=req.headers.get("Origin");if(origin&&origin!==ALLOW_ORIGIN)return json({ok:false,error:"origin_not_allowed"},403);
    const body=await req.json();
    const auth=await authenticateRequest(String(body.initData??""),String(body.access_session_token??""));
    const users=await rest("telegram_users",{telegram_user_id:`eq.${auth.id}`,active:"eq.true",select:"telegram_user_id,role",limit:"1"});
    if(!users.length)return json({ok:false,error:"not_authorized"},403);
    const role=String(users[0].role||""),action=String(body.action||"get");
    const plate=norm(String(body.plate??""));if(plate.length<4)return json({ok:false,error:"invalid_plate"},400);
    const {vehicle:v,stays}=await findVehicleAndStays(plate);
    const requestedStayId=String(body.stay_id||"");
    const selected=requestedStayId?stays.find((s:any)=>s.id===requestedStayId):stays.find((s:any)=>s.status==="active")||stays[0];
    if(!selected)return json({ok:false,error:"stay_not_found"},404);

    if(action==="open_dispute"){
      if(!isManager(role))return json({ok:false,error:"forbidden"},403);
      const reason=String(body.reason||"").trim();if(reason.length<3||reason.length>1000)return json({ok:false,error:"invalid_dispute_reason"},400);
      const open=await rest("vehicle_disputes",{stay_id:`eq.${selected.id}`,status:"eq.open",select:"id",limit:"1"});
      if(open.length)return json({ok:false,error:"dispute_already_open"},409);
      await insert("vehicle_disputes",{vehicle_id:v.id,stay_id:selected.id,status:"open",reason,opened_by_telegram_user_id:auth.id});
    }else if(action==="close_dispute"){
      if(!isManager(role))return json({ok:false,error:"forbidden"},403);
      const open=await rest("vehicle_disputes",{stay_id:`eq.${selected.id}`,status:"eq.open",select:"id",order:"opened_at.desc",limit:"1"});
      if(!open.length)return json({ok:false,error:"no_open_dispute"},409);
      const note=String(body.close_note||"").trim().slice(0,1000);
      await patch("vehicle_disputes",{id:`eq.${open[0].id}`},{status:"closed",closed_by_telegram_user_id:auth.id,closed_at:new Date().toISOString(),close_note:note||null,updated_at:new Date().toISOString()});
    }else if(action!=="get")return json({ok:false,error:"invalid_action"},400);

    const [events,evidence,verifications,disputes]=await Promise.all([
      rest("parking_events",{stay_id:`eq.${selected.id}`,select:"id,stay_id,worker_id,operation,latitude,longitude,accuracy_m,location_text,gps_quality,created_at,metadata",order:"created_at.desc",limit:"200"}),
      rest("vehicle_evidence",{stay_id:`eq.${selected.id}`,select:"id,stay_id,event_id,uploaded_by,stage,evidence_type,media_type,storage_bucket,storage_path,mime_type,file_size,created_at,metadata",order:"created_at.desc",limit:"200"}),
      rest("plate_verifications",{stay_id:`eq.${selected.id}`,select:"id,stay_id,worker_id,evidence_id,stage,expected_plate,detected_plate,ocr_raw_text,ocr_confidence,result,override_reason,metadata,created_at",order:"created_at.desc",limit:"200"}),
      rest("vehicle_disputes",{stay_id:`eq.${selected.id}`,select:"id,status,reason,opened_at,closed_at,close_note,created_at,updated_at",order:"opened_at.desc",limit:"100"})
    ]);
    const workerIds=[...new Set([...events.map((x:any)=>x.worker_id),...evidence.map((x:any)=>x.uploaded_by),...verifications.map((x:any)=>x.worker_id)].filter(Boolean))];
    let workers:any[]=[];if(workerIds.length)workers=await rest("workers",{id:`in.(${workerIds.join(",")})`,select:"id,full_name,role"});const wm=Object.fromEntries(workers.map((w:any)=>[w.id,w]));
    const evOut=[];for(const e of evidence)evOut.push({...e,stage:e.stage==='relocate'?'Reubicación':e.stage,uploaded_by_worker:e.uploaded_by?wm[e.uploaded_by]??null:null,signed_url:await signedUrl(e.storage_bucket||"vehicle-evidence",e.storage_path)});
    const eventOut=events.map((e:any)=>({...e,operation:e.operation==='relocate'?'Vehículo reubicado':e.operation,worker:e.worker_id?wm[e.worker_id]??null:null}));
    const activeDispute=disputes.find((d:any)=>d.status==="open")||null;
    const isCurrent=selected.status==="active";
    const historicalLocation=!isCurrent?events.find((e:any)=>e.latitude!=null&&e.longitude!=null||e.location_text):null;
    const dossierVehicle=isCurrent?v:{...v,status:"retrieved",parked_at:null,updated_at:selected.delivered_at||selected.updated_at,current_lat:historicalLocation?.latitude??null,current_lng:historicalLocation?.longitude??null,current_accuracy_m:historicalLocation?.accuracy_m??null,current_location_text:historicalLocation?.location_text??null};
    return json({ok:true,role,can_manage_dispute:isManager(role),vehicle:dossierVehicle,selected_stay:selected,stays,active_dispute:activeDispute,disputes,events:eventOut,evidence:evOut,verifications:verifications.map((x:any)=>({...x,stage:x.stage==='relocate'?'Reubicación':x.stage,worker:x.worker_id?wm[x.worker_id]??null:null}))});
  }catch(e){
    console.error(e);const m=String((e as Error)?.message??e);
    const status=m==="not_authorized"||m==="forbidden"?403:m==="not_found"||m==="stay_not_found"?404:400;
    return json({ok:false,error:m},status);
  }
});
