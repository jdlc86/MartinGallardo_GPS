import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const RELEASE_PRODUCT="ParkingMartin-G";
const RELEASE_VERSION="1.4.0";
const RELEASE_BUILD="2026.09.04.04";
const RELEASE_SOURCE_REVISION="1e3b24cafeb6f8dedb66aeb57275b6554445697f";

const BOT_TOKEN=Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS_JSON=Deno.env.get("SUPABASE_SECRET_KEYS");
const LEGACY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ORIGIN="https://jdlc86.github.io";

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
function cors(){
  return {
    "Access-Control-Allow-Origin":ORIGIN,
    "Access-Control-Allow-Headers":"content-type",
    "Access-Control-Allow-Methods":"POST,OPTIONS",
    "Vary":"Origin"
  };
}
function json(x:any,s=200){
  return new Response(JSON.stringify(x),{
    status:s,
    headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store",
      "X-Content-Type-Options":"nosniff",
      ...cors()
    }
  });
}
function attest(){
  return json({ok:true,product:RELEASE_PRODUCT,function:"modern-live-team-api",version:RELEASE_VERSION,build:RELEASE_BUILD,source_revision:RELEASE_SOURCE_REVISION});
}
function eq(a:Uint8Array,b:Uint8Array){
  if(a.length!==b.length)return false;
  let x=0;for(let i=0;i<a.length;i++)x|=a[i]^b[i];
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
const INIT_DATA_MAX_AGE_S=900;
const SESSION_TTL_S=7200;
const SESSION_MAX_AGE_S=14*3600;
const SESSION_SCOPE="team_live_read";
type SessionClaims={v:1;uid:number;wid:string;scope:string;iat:number;exp:number;max_exp:number};

function b64u(a:Uint8Array){
  let s="";for(const b of a)s+=String.fromCharCode(b);
  return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function unb64u(s:string){
  const p=s.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-s.length%4)%4);
  const raw=atob(p),out=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);
  return out;
}
async function sessionKey(){return hmac(BOT_TOKEN,"ParkingMartin-G:team_live_read:v1")}
async function signClaims(c:SessionClaims){
  const body=b64u(new TextEncoder().encode(JSON.stringify(c)));
  const sig=b64u(await hmac(await sessionKey(),body));
  return body+"."+sig;
}
async function verifySession(token:string){
  const [body,sig,...rest]=String(token||"").split(".");
  if(!body||!sig||rest.length)throw new Error("session_invalid");
  let given:Uint8Array;
  try{given=unb64u(sig)}catch{throw new Error("session_invalid")}
  const calc=await hmac(await sessionKey(),body);
  if(!eq(given,calc))throw new Error("session_invalid");
  let c:SessionClaims;
  try{c=JSON.parse(new TextDecoder().decode(unb64u(body)))}catch{throw new Error("session_invalid")}
  const now=Math.floor(Date.now()/1000);
  if(c?.v!==1||c.scope!==SESSION_SCOPE||!Number.isFinite(c.uid)||!c.wid)throw new Error("session_invalid");
  if(!Number.isFinite(c.iat)||!Number.isFinite(c.exp)||!Number.isFinite(c.max_exp))throw new Error("session_invalid");
  if(c.iat>now+60||c.max_exp<c.iat||c.max_exp-c.iat>SESSION_MAX_AGE_S+60)throw new Error("session_invalid");
  if(now>c.exp||now>c.max_exp)throw new Error("session_expired");
  return c;
}
async function newSession(uid:number,wid:string){
  const now=Math.floor(Date.now()/1000),max_exp=now+SESSION_MAX_AGE_S;
  return signClaims({v:1,uid,wid,scope:SESSION_SCOPE,iat:now,exp:Math.min(now+SESSION_TTL_S,max_exp),max_exp});
}
async function renewSession(c:SessionClaims){
  const now=Math.floor(Date.now()/1000);
  if(now>c.max_exp)throw new Error("session_expired");
  return signClaims({...c,exp:Math.min(now+SESSION_TTL_S,c.max_exp)});
}
async function authInitData(initData:string){
  const p=new URLSearchParams(initData),hash=p.get("hash")||"";
  p.delete("hash");
  const check=[...p.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([k,v])=>`${k}=${v}`).join("\n");
  const sec=await hmac("WebAppData",BOT_TOKEN),calc=await hmac(sec,check),given=hexBytes(hash);
  if(!given||!eq(calc,given))throw new Error("invalid_init_data");
  const at=Number(p.get("auth_date")||0);
  if(!Number.isFinite(at)||Math.abs(Date.now()/1000-at)>INIT_DATA_MAX_AGE_S)throw new Error("expired_init_data");
  const u=JSON.parse(p.get("user")||"null");
  if(!u?.id)throw new Error("missing_user");
  return Number(u.id);
}
async function rest(t:string,p:Record<string,string>){
  const u=new URL(`${SUPABASE_URL}/rest/v1/${t}`);
  for(const[k,v]of Object.entries(p))u.searchParams.set(k,v);
  const r=await fetch(u,{headers:hdr({Accept:"application/json"})});
  if(!r.ok)throw new Error(await r.text());
  return r.json();
}
async function one(t:string,p:Record<string,string>){
  return (await rest(t,{...p,limit:"1"}))[0]??null;
}
async function ctx(uid:number){
  const u=await one("telegram_users",{telegram_user_id:`eq.${uid}`,active:"eq.true",select:"telegram_user_id,role"});
  if(!u)throw new Error("not_authorized");
  const w=await one("workers",{telegram_user_id:`eq.${uid}`,active:"eq.true",select:"id,full_name"});
  if(!w)throw new Error("worker_not_found");
  return {u,w};
}

Deno.serve(async req=>{
  const u=new URL(req.url);
  if(req.method==="GET"&&u.searchParams.get("attest")==="1")return attest();
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors()});
  if(req.method!=="POST")return json({ok:false,error:"method_not_allowed"},405);
  try{
    const origin=req.headers.get("Origin");
    if(origin&&origin!==ORIGIN)return json({ok:false,error:"origin_not_allowed"},403);

    const b=await req.json();
    let uid:number,worker:any,sessionToken:string;
    if(b?.sessionToken){
      const claims=await verifySession(String(b.sessionToken));
      uid=claims.uid;
      const c=await ctx(uid);
      worker=c.w;
      if(String(worker.id)!==String(claims.wid))throw new Error("session_invalid");
      sessionToken=await renewSession(claims);
    }else{
      uid=await authInitData(String(b?.initData||""));
      const c=await ctx(uid);
      worker=c.w;
      sessionToken=await newSession(uid,String(worker.id));
    }

    const rows=await rest("worker_live_locations",{
      select:"telegram_user_id,worker_id,full_name,latitude,longitude,accuracy_m,heading,live_until,updated_at",
      live_until:`gt.${new Date().toISOString()}`,
      order:"updated_at.desc"
    });

    return json({ok:true,locations:Array.isArray(rows)?rows:[],session_token:sessionToken});
  }catch(e){
    const msg=String((e as Error)?.message||e);
    if(msg==="invalid_init_data"||msg==="expired_init_data"||msg==="session_invalid"||msg==="session_expired"||msg==="not_authorized"||msg==="worker_not_found"){console.warn("live_team_access_denied",msg);return json({ok:false,error:msg},403)}
    console.error(e);
    return json({ok:false,error:"live_team_unavailable"},500);
  }
});
