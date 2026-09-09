import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const RELEASE_PRODUCT="ParkingMartin-G";
const RELEASE_VERSION="1.4.0";
const RELEASE_BUILD="2026.09.04.04";
const RELEASE_SOURCE_REVISION="91d7a4c2b83e56f019ac47d25e6384bf0a72ce19";
function releaseAttestation(){return new Response(JSON.stringify({ok:true,product:RELEASE_PRODUCT,function:"miniapp-access-session-api",version:RELEASE_VERSION,build:RELEASE_BUILD,source_revision:RELEASE_SOURCE_REVISION}),{headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}

const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!;
const BOT_TOKEN=Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SECRET_KEYS_JSON=Deno.env.get("SUPABASE_SECRET_KEYS");
const LEGACY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ORIGIN="https://jdlc86.github.io";
const INIT_DATA_MAX_AGE_SECONDS=600;
const ACCESS_SESSION_TTL_SECONDS=22*60*60;

function key(){
  if(SECRET_KEYS_JSON){
    try{
      const p=JSON.parse(SECRET_KEYS_JSON);
      if(p?.default)return p.default;
      const v=Object.values(p??{})[0];
      if(typeof v==="string")return v;
    }catch{}
  }
  if(LEGACY)return LEGACY;
  throw new Error("no_server_key");
}
function hdr(extra:Record<string,string>={}){
  const k=key();
  return {apikey:k,Authorization:`Bearer ${k}`,...extra};
}
function cors(){return{
  "Access-Control-Allow-Origin":ORIGIN,
  "Access-Control-Allow-Headers":"content-type",
  "Access-Control-Allow-Methods":"POST,OPTIONS",
  "Vary":"Origin"
}}
function json(body:unknown,status=200){
  return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json",...cors()}});
}
function eq(a:Uint8Array,b:Uint8Array){
  if(a.length!==b.length)return false;
  let x=0;
  for(let i=0;i<a.length;i++)x|=a[i]^b[i];
  return x===0;
}
function hexBytes(s:string){
  if(!/^[0-9a-f]{64}$/i.test(s))return null;
  const a=new Uint8Array(32);
  for(let i=0;i<32;i++)a[i]=parseInt(s.slice(i*2,i*2+2),16);
  return a;
}
async function hmac(k:Uint8Array|string,m:string){
  const kb=typeof k==="string"?new TextEncoder().encode(k):k;
  const ik=await crypto.subtle.importKey("raw",kb,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC",ik,new TextEncoder().encode(m)));
}
async function authenticate(initData:string){
  const p=new URLSearchParams(initData);
  const hash=p.get("hash")||"";
  p.delete("hash");
  const check=[...p.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([k,v])=>`${k}=${v}`).join("\n");
  const secret=await hmac("WebAppData",BOT_TOKEN);
  const calculated=await hmac(secret,check);
  const given=hexBytes(hash);
  if(!given||!eq(calculated,given))throw new Error("invalid_init_data");
  const authDate=Number(p.get("auth_date")||0);
  if(!Number.isFinite(authDate)||Math.abs(Date.now()/1000-authDate)>INIT_DATA_MAX_AGE_SECONDS)throw new Error("expired_init_data");
  const user=JSON.parse(p.get("user")||"null");
  if(!user?.id)throw new Error("missing_user");
  return {telegramUserId:Number(user.id),authDate};
}
async function one(table:string,params:Record<string,string>){
  const u=new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for(const [k,v] of Object.entries({...params,limit:"1"}))u.searchParams.set(k,v);
  const r=await fetch(u,{headers:hdr({Accept:"application/json"})});
  if(!r.ok)throw new Error(await r.text());
  return (await r.json())[0]??null;
}
function randomToken(){
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  let raw="";
  for(const b of bytes)raw+=String.fromCharCode(b);
  return btoa(raw).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
async function sha256Hex(value:string){
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));
  return [...digest].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function upsertSession(uid:number,authDate:number){
  const authIso=new Date(authDate*1000).toISOString();
  const existing=await one("miniapp_access_sessions",{telegram_user_id:`eq.${uid}`,auth_date:`eq.${authIso}`,select:"id,expires_at,active,revoked_at"});
  const existingExpiry=existing?.active&&!existing?.revoked_at?new Date(existing.expires_at).getTime():NaN;
  const expiresAt=Number.isFinite(existingExpiry)&&existingExpiry>Date.now()
    ?new Date(existingExpiry).toISOString()
    :new Date(Date.now()+ACCESS_SESSION_TTL_SECONDS*1000).toISOString();
  const accessToken=randomToken();
  const tokenHash=await sha256Hex(accessToken);
  const r=await fetch(`${SUPABASE_URL}/rest/v1/miniapp_access_sessions?on_conflict=telegram_user_id,auth_date`,{
    method:"POST",
    headers:hdr({"Content-Type":"application/json","Prefer":"resolution=merge-duplicates,return=representation"}),
    body:JSON.stringify({
      telegram_user_id:uid,
      auth_date:authIso,
      expires_at:expiresAt,
      last_seen_at:new Date().toISOString(),
      notified_at:null,
      revoked_at:null,
      token_hash:tokenHash,
      active:true
    })
  });
  if(!r.ok)throw new Error(await r.text());
  const session=(await r.json())[0];
  return {session,accessToken};
}

Deno.serve(async(req)=>{
  const url=new URL(req.url);
  if(req.method==="GET"&&url.searchParams.get("attest")==="1")return releaseAttestation();
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors()});
  if(req.method!=="POST")return json({ok:false,error:"method_not_allowed"},405);
  try{
    const origin=req.headers.get("Origin");
    if(origin&&origin!==ORIGIN)return json({ok:false,error:"origin_not_allowed"},403);
    const body=await req.json();
    const {telegramUserId,authDate}=await authenticate(String(body?.initData||""));
    const user=await one("telegram_users",{telegram_user_id:`eq.${telegramUserId}`,active:"eq.true",select:"telegram_user_id"});
    if(!user)return json({ok:false,error:"not_authorized"},403);
    const {session,accessToken}=await upsertSession(telegramUserId,authDate);
    return json({ok:true,access_token:accessToken,expires_at:session.expires_at});
  }catch(error){
    const code=String((error as Error)?.message||error);
    return json({ok:false,error:code},["invalid_init_data","expired_init_data","missing_user","not_authorized"].includes(code)?403:500);
  }
});