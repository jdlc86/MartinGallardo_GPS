import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BOT_TOKEN=Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS_JSON=Deno.env.get("SUPABASE_SECRET_KEYS");
const LEGACY_SERVICE_ROLE_KEY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ALLOW_ORIGIN="https://jdlc86.github.io";
const CONFIRM_PHRASE="RESET_OPERATIONAL_DATA";

function serverKey(){
  if(SECRET_KEYS_JSON){try{const p=JSON.parse(SECRET_KEYS_JSON);if(p?.default)return p.default;const v=Object.values(p??{})[0];if(typeof v==="string")return v}catch{}}
  if(LEGACY_SERVICE_ROLE_KEY)return LEGACY_SERVICE_ROLE_KEY;
  throw new Error("No server key");
}
function hdr(extra:Record<string,string>={}){const k=serverKey();return{apikey:k,Authorization:`Bearer ${k}`,...extra}}
function cors(){return{"Access-Control-Allow-Origin":ALLOW_ORIGIN,"Access-Control-Allow-Headers":"content-type","Access-Control-Allow-Methods":"POST,OPTIONS","Vary":"Origin"}}
function json(data:any,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff",...cors()}})}
function eqBytes(a:Uint8Array,b:Uint8Array){if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a[i]^b[i];return x===0}
function hexToBytes(s:string){if(!/^[0-9a-fA-F]{64}$/.test(s))return null;const out=new Uint8Array(32);for(let i=0;i<32;i++)out[i]=parseInt(s.slice(i*2,i*2+2),16);return out}
async function hmac(key:Uint8Array|string,msg:string){const kb=typeof key==="string"?new TextEncoder().encode(key):key;const k=await crypto.subtle.importKey("raw",kb,{name:"HMAC",hash:"SHA-256"},false,["sign"]);return new Uint8Array(await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(msg)))}
async function validateInitData(initData:string){
  const p=new URLSearchParams(initData),hash=p.get("hash")??"";p.delete("hash");
  const pairs:[string,string][]=[];for(const [k,v] of p.entries())pairs.push([k,v]);pairs.sort((a,b)=>a[0].localeCompare(b[0]));
  const check=pairs.map(([k,v])=>`${k}=${v}`).join("\n"),secret=await hmac("WebAppData",BOT_TOKEN),calc=await hmac(secret,check),given=hexToBytes(hash);
  if(!given||!eqBytes(calc,given))throw new Error("invalid_init_data");
  const auth=Number(p.get("auth_date")??0);if(!Number.isFinite(auth)||Math.abs(Date.now()/1000-auth)>600)throw new Error("expired_init_data");
  let user:any=null;try{user=JSON.parse(p.get("user")??"null")}catch{};const id=Number(user?.id);if(!Number.isFinite(id))throw new Error("missing_user");return id;
}
async function sha256AccessToken(value:string){const d=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));return[...d].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function rpc(name:string,body:any){const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:"POST",headers:hdr({"Content-Type":"application/json"}),body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d?.message||d?.error||`rpc_${name}_failed`);return d}
async function validateAccessSession(token:string){if(!token)return null;const d=await rpc("validate_miniapp_access_session",{p_token_hash:await sha256AccessToken(token)});const row=Array.isArray(d)?d[0]:d;if(!row?.telegram_user_id)throw new Error("expired_access_session");return Number(row.telegram_user_id)}
async function authenticate(body:any){const uid=await validateAccessSession(String(body.access_session_token??""));return uid||await validateInitData(String(body.initData??""))}
async function ensureOwner(uid:number){const u=new URL(`${SUPABASE_URL}/rest/v1/telegram_users`);u.searchParams.set("telegram_user_id",`eq.${uid}`);u.searchParams.set("active","eq.true");u.searchParams.set("role","eq.owner");u.searchParams.set("select","telegram_user_id");u.searchParams.set("limit","1");const r=await fetch(u,{headers:hdr({Accept:"application/json"})});if(!r.ok)throw new Error("owner_check_failed");const d=await r.json();if(!Array.isArray(d)||!d.length)throw new Error("owner_required")}
async function deleteObject(bucket:string,path:string){const b=encodeURIComponent(bucket),p=path.split('/').map(encodeURIComponent).join('/');const r=await fetch(`${SUPABASE_URL}/storage/v1/object/${b}/${p}`,{method:"DELETE",headers:hdr()});if(r.ok||r.status===404)return;throw new Error(`storage_delete_failed_${r.status}`)}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors()});
  if(req.method!=="POST")return json({ok:false,error:"method_not_allowed"},405);
  let uid:number|null=null,resetId="";
  try{
    const origin=req.headers.get("Origin");if(origin&&origin!==ALLOW_ORIGIN)return json({ok:false,error:"origin_not_allowed"},403);
    const body=await req.json().catch(()=>({}));
    uid=await authenticate(body);await ensureOwner(uid);
    const action=String(body.action||"preview");
    if(action==="preview"){
      const result=await rpc("factory_reset_preview",{p_owner_id:uid});
      return json({ok:true,...result,confirmation_phrase:CONFIRM_PHRASE});
    }
    if(action!=="execute")return json({ok:false,error:"invalid_action"},400);
    resetId=String(body.reset_id||"");
    if(!/^[0-9a-f-]{36}$/i.test(resetId))return json({ok:false,error:"invalid_reset_id"},400);
    if(String(body.confirmation||"")!==CONFIRM_PHRASE)return json({ok:false,error:"confirmation_required"},400);
    const override=body.override_disputes===true;
    await rpc("factory_reset_claim",{p_reset_id:resetId,p_owner_id:uid,p_override_disputes:override});
    const objects=await rpc("factory_reset_storage_objects",{p_reset_id:resetId,p_owner_id:uid});
    let deleted=0;
    for(const obj of objects||[]){await deleteObject(String(obj.bucket||"vehicle-evidence"),String(obj.path||""));deleted++}
    const result=await rpc("factory_reset_finalize",{p_reset_id:resetId,p_owner_id:uid,p_storage_objects_deleted:deleted});
    return json({ok:true,result});
  }catch(e){
    const message=String((e as Error)?.message||e);console.error(message);
    if(uid&&resetId)await rpc("factory_reset_fail",{p_reset_id:resetId,p_owner_id:uid,p_error:message}).catch(()=>null);
    const status=message.includes("owner_required")?403:message.includes("open_disputes")?409:message.includes("invalid_or_expired")?409:400;
    return json({ok:false,error:message},status);
  }
});
