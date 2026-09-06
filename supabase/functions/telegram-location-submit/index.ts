import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BOT_TOKEN=Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS_JSON=Deno.env.get("SUPABASE_SECRET_KEYS");
const LEGACY_SERVICE_ROLE_KEY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ALLOW_ORIGIN="https://jdlc86.github.io";

function serverKey(){if(SECRET_KEYS_JSON){try{const p=JSON.parse(SECRET_KEYS_JSON);if(p?.default)return p.default;const v=Object.values(p??{})[0];if(typeof v==="string")return v}catch{}}if(LEGACY_SERVICE_ROLE_KEY)return LEGACY_SERVICE_ROLE_KEY;throw new Error("No server key")}
function hdr(extra:Record<string,string>={}){const k=serverKey();return{apikey:k,Authorization:`Bearer ${k}`,...extra}}
function cors(){return{"Access-Control-Allow-Origin":ALLOW_ORIGIN,"Access-Control-Allow-Headers":"content-type","Access-Control-Allow-Methods":"POST,OPTIONS","Vary":"Origin"}}
function json(data:any,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json",...cors()}})}
const tgUrl=(m:string)=>`https://api.telegram.org/bot${BOT_TOKEN}/${m}`;
async function tg(method:string,body:any){const r=await fetch(tgUrl(method),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const raw=await r.text();let data:any=null;try{data=JSON.parse(raw)}catch{}if(!r.ok||data?.ok===false)throw new Error(`${method}: ${r.status} ${raw}`);return data.result}
async function one(table:string,filters:Record<string,string>,select="*"){const u=new URL(`${SUPABASE_URL}/rest/v1/${table}`);for(const[k,v]of Object.entries(filters))u.searchParams.set(k,v);u.searchParams.set("select",select);u.searchParams.set("limit","1");const r=await fetch(u,{headers:hdr({Accept:"application/json"})});if(!r.ok)throw new Error(await r.text());return(await r.json())[0]??null}
async function upsert(table:string,body:any,conflict:string){const u=new URL(`${SUPABASE_URL}/rest/v1/${table}`);u.searchParams.set("on_conflict",conflict);const r=await fetch(u,{method:"POST",headers:hdr({"Content-Type":"application/json",Prefer:"resolution=merge-duplicates,return=representation"}),body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());return r.json()}
async function threshold(){return Number((await one("parking_config",{id:"eq.true"},"default_accuracy_threshold_m"))?.default_accuracy_threshold_m??15)}
async function saveSession(id:number,flow:string,step:string,data:any){await upsert("telegram_conversation_sessions",{telegram_user_id:id,flow,step,data,updated_at:new Date().toISOString(),expires_at:new Date(Date.now()+30*60000).toISOString()},"telegram_user_id")}
function eqBytes(a:Uint8Array,b:Uint8Array){if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a[i]^b[i];return x===0}
function hexToBytes(s:string){if(!/^[0-9a-fA-F]{64}$/.test(s))return null;const out=new Uint8Array(32);for(let i=0;i<32;i++)out[i]=parseInt(s.slice(i*2,i*2+2),16);return out}
async function hmac(key:Uint8Array|string,msg:string){const kb=typeof key==="string"?new TextEncoder().encode(key):key;const k=await crypto.subtle.importKey("raw",kb,{name:"HMAC",hash:"SHA-256"},false,["sign"]);return new Uint8Array(await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(msg)))}
async function validateInitData(initData:string){const p=new URLSearchParams(initData);const hash=p.get("hash")??"";p.delete("hash");const pairs:[string,string][]=[];for(const [k,v] of p.entries())pairs.push([k,v]);pairs.sort((a,b)=>a[0].localeCompare(b[0]));const check=pairs.map(([k,v])=>`${k}=${v}`).join("\n");const secret=await hmac("WebAppData",BOT_TOKEN);const calc=await hmac(secret,check);const given=hexToBytes(hash);if(!given||!eqBytes(calc,given))throw new Error("Invalid Telegram initData");const auth=Number(p.get("auth_date")??0);if(!Number.isFinite(auth)||Math.abs(Date.now()/1000-auth)>600)throw new Error("Expired Telegram initData");let user:any=null;try{user=JSON.parse(p.get("user")??"null")}catch{};const id=Number(user?.id);if(!Number.isFinite(id))throw new Error("Missing Telegram user");return{id,user}
}

async function sha256AccessToken(value:string){const d=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));return[...d].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function validateAccessSession(token:string){if(!token)return null;const k=serverKey();const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/validate_miniapp_access_session`,{method:"POST",headers:{apikey:k,Authorization:`Bearer ${k}`,"Content-Type":"application/json"},body:JSON.stringify({p_token_hash:await sha256AccessToken(token)})});if(!r.ok)throw new Error("access_session_validation_failed");const data=await r.json();const row=Array.isArray(data)?data[0]:data;if(!row?.telegram_user_id)throw new Error("expired_access_session");return Number(row.telegram_user_id)}
async function authenticateRequest(initData:string,token:string){const uid=await validateAccessSession(token);if(uid)return{id:uid,user:null};return validateInitData(initData)}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors()});
  if(req.method!=="POST")return json({ok:false,error:"method_not_allowed"},405);
  try{
    const origin=req.headers.get("Origin");if(origin&&origin!==ALLOW_ORIGIN)return json({ok:false,error:"origin_not_allowed"},403);
    const body=await req.json();
    const auth=await authenticateRequest(String(body.initData??""),String(body.access_session_token??""));
    const lat=Number(body.latitude),lng=Number(body.longitude),acc=Number(body.horizontal_accuracy);
    if(!Number.isFinite(lat)||!Number.isFinite(lng)||lat<-90||lat>90||lng<-180||lng>180)return json({ok:false,error:"invalid_coordinates"},400);
    const accuracy=Number.isFinite(acc)&&acc>=0?Math.min(acc,1500):null;
    const user=await one("telegram_users",{telegram_user_id:`eq.${auth.id}`,active:"eq.true"},"telegram_user_id");if(!user)return json({ok:false,error:"not_authorized"},403);
    const s=await one("telegram_conversation_sessions",{telegram_user_id:`eq.${auth.id}`},"flow,step,data,expires_at");
    if(!s||s.flow!=="dejar"||s.step!=="location")return json({ok:false,error:"no_pending_parking"},409);
    const d={...(s.data??{}),latitude:lat,longitude:lng,accuracy_m:accuracy,location_source:"telegram_miniapp_github"};
    const th=await threshold();
    await tg("sendLocation",{chat_id:auth.id,latitude:lat,longitude:lng,...(accuracy!=null?{horizontal_accuracy:accuracy}:{})});
    if(accuracy!=null&&accuracy>th){
      await saveSession(auth.id,"dejar","location_text",d);
      await tg("sendMessage",{chat_id:auth.id,text:`📍 Ubicación capturada\nPrecisión GPS: ±${Math.round(accuracy)} m\n\nLa precisión es baja. Describe dónde está el coche.`});
    }else{
      await saveSession(auth.id,"dejar","confirm",d);
      await tg("sendMessage",{chat_id:auth.id,text:`📍 Ubicación capturada\nMatrícula: ${d.plate}\nPrecisión GPS: ${accuracy==null?"no informada":`±${Math.round(accuracy)} m`}\n\n¿Guardar esta ubicación?`,reply_markup:{inline_keyboard:[[{text:"✅ CONFIRMAR",callback_data:"park:confirm"},{text:"❌ CANCELAR",callback_data:"flow:cancel"}]]}});
    }
    return json({ok:true,accuracy_m:accuracy,needs_description:accuracy!=null&&accuracy>th});
  }catch(e){console.error(e);return json({ok:false,error:String((e as Error)?.message??e)},400)}
});