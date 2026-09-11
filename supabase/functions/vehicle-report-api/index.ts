import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const RELEASE_PRODUCT="ParkingMartin-G";
const RELEASE_VERSION="1.4.0";
const RELEASE_BUILD="2026.09.04.04";
const RELEASE_SOURCE_REVISION="a111000000000000000000000000000000000001";
function releaseAttestation(){return new Response(JSON.stringify({ok:true,product:RELEASE_PRODUCT,function:"vehicle-report-api",version:RELEASE_VERSION,build:RELEASE_BUILD,source_revision:RELEASE_SOURCE_REVISION}),{headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}

const BOT_TOKEN=Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS_JSON=Deno.env.get("SUPABASE_SECRET_KEYS");
const LEGACY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ORIGIN="https://jdlc86.github.io";
const REPORT_TTL_MS=15*60*1000;
const MAX_SELECTED_SOURCE_BYTES=15*1024*1024;
const MAX_SELECTED_PHOTOS=60;

function key(){if(SECRET_KEYS_JSON){try{const p=JSON.parse(SECRET_KEYS_JSON);if(p?.default)return p.default;const v=Object.values(p??{})[0];if(typeof v==="string")return v}catch{}}if(LEGACY)return LEGACY;throw new Error("no_server_key")}
function hdr(extra:Record<string,string>={}){const k=key();return{apikey:k,Authorization:`Bearer ${k}`,...extra}}
function cors(){return{"Access-Control-Allow-Origin":ORIGIN,"Access-Control-Allow-Headers":"content-type","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Vary":"Origin"}}
function json(x:any,s=200){return new Response(JSON.stringify(x),{status:s,headers:{"Content-Type":"application/json","Cache-Control":"no-store",...cors()}})}

function eq(a:Uint8Array,b:Uint8Array){if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a[i]^b[i];return x===0}
function hexBytes(s:string){if(!/^[0-9a-f]{64}$/i.test(s))return null;const a=new Uint8Array(32);for(let i=0;i<32;i++)a[i]=parseInt(s.slice(i*2,i*2+2),16);return a}
async function hmac(k:Uint8Array|string,m:string){const kb=typeof k==="string"?new TextEncoder().encode(k):k;const ik=await crypto.subtle.importKey("raw",kb,{name:"HMAC",hash:"SHA-256"},false,["sign"]);return new Uint8Array(await crypto.subtle.sign("HMAC",ik,new TextEncoder().encode(m)))}
async function initData(s:string){const p=new URLSearchParams(s),hash=p.get("hash")||"";p.delete("hash");const pairs=[...p.entries()].sort((a,b)=>a[0].localeCompare(b[0]));const check=pairs.map(([k,v])=>`${k}=${v}`).join("\n");const sec=await hmac("WebAppData",BOT_TOKEN),calc=await hmac(sec,check),given=hexBytes(hash);if(!given||!eq(calc,given))throw new Error("invalid_init_data");const auth=Number(p.get("auth_date")||0);if(!Number.isFinite(auth)||Math.abs(Date.now()/1000-auth)>900)throw new Error("expired_init_data");const u=JSON.parse(p.get("user")||"null");if(!u?.id)throw new Error("missing_user");return Number(u.id)}

async function rest(table:string,params:Record<string,string>){const u=new URL(`${SUPABASE_URL}/rest/v1/${table}`);for(const[k,v]of Object.entries(params))u.searchParams.set(k,v);const r=await fetch(u,{headers:hdr({Accept:"application/json"})});if(!r.ok)throw new Error(await r.text());return r.json()}
async function insert(table:string,body:any){const r=await fetch(`${SUPABASE_URL}/rest/v1/${table}`,{method:"POST",headers:hdr({"Content-Type":"application/json",Prefer:"return=representation"}),body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());return(await r.json())[0]}
async function patch(table:string,filters:Record<string,string>,body:any){const u=new URL(`${SUPABASE_URL}/rest/v1/${table}`);for(const[k,v]of Object.entries(filters))u.searchParams.set(k,v);const r=await fetch(u,{method:"PATCH",headers:hdr({"Content-Type":"application/json",Prefer:"return=minimal"}),body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text())}
async function cleanupExpired(){const u=new URL(`${SUPABASE_URL}/rest/v1/vehicle_report_requests`);u.searchParams.set("expires_at",`lt.${new Date(Date.now()-3600000).toISOString()}`);await fetch(u,{method:"DELETE",headers:hdr({Prefer:"return=minimal"})}).catch(()=>{})}

function randomToken(){const b=crypto.getRandomValues(new Uint8Array(32));let s="";for(const x of b)s+=String.fromCharCode(x);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")}
async function sha256Hex(s:string){const d=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)));return[...d].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function objectBytes(bucket:string,path:string){const safe=path.split("/").map(encodeURIComponent).join("/");const r=await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${safe}`,{headers:hdr()});if(!r.ok)return null;return new Uint8Array(await r.arrayBuffer())}

const stage:any={airport_pickup:"Aeropuerto - Recogida",parking:"Parking - Aparcado",parking_exit:"Parking - Salida",airport_delivery:"Aeropuerto - Entrega",relocate:"Reubicación",Reubicación:"Reubicación"};
const ops:any={lookup:"Consulta del vehículo",park:"Vehículo aparcado",pickup:"Recogida en aeropuerto",retrieve:"Entrega al cliente",relocate:"Vehículo reubicado","Vehículo reubicado":"Vehículo reubicado",plate_verification_override:"OCR ignorado"};
const statuses:any={parked:"APARCADO",requested:"SOLICITADO",in_transit:"EN TRÁNSITO",retrieved:"ENTREGADO"};
const ocrResult:any={matched:"VERIFICADA",mismatch:"NO COINCIDE",ocr_failed:"LECTURA OCR FALLIDA",overridden:"IGNORADA POR OPERARIO"};
function fdate(d:any){if(!d)return"-";try{return new Intl.DateTimeFormat("es-ES",{dateStyle:"medium",timeStyle:"short",timeZone:"Europe/Madrid"}).format(new Date(d))}catch{return String(d)}}
function clean(s:any){return String(s??"-").replace(/[\u2013\u2014]/g,"-").replace(/[^\x20-\x7E\u00A0-\u00FF]/g,"")}
function bool(v:any,fallback=true){return typeof v==="boolean"?v:fallback}
function isSupportedPhoto(e:any){const mime=String(e.mime_type||"").toLowerCase();return e.media_type==="photo"&&(mime==="image/jpeg"||mime==="image/png"||/\.(jpg|jpeg|png)$/i.test(String(e.storage_path||"")))}

async function createRequest(body:any,uid:number){
  const plate=String(body.plate||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
  const vs=await rest("vehicles",{normalized_plate:`eq.${plate}`,select:"id,plate",limit:"1"});
  if(!vs.length)throw new Error("not_found");
  const stays=await rest("vehicle_stays",{vehicle_id:`eq.${vs[0].id}`,select:"id,status,started_at",order:"started_at.desc",limit:"200"});
  const requestedStay=String(body.stay_id||"");
  const stay=requestedStay?stays.find((x:any)=>x.id===requestedStay):stays.find((x:any)=>x.status==="active")||stays[0];
  if(!stay)throw new Error("stay_not_found");

  const allEvidence=await rest("vehicle_evidence",{stay_id:`eq.${stay.id}`,select:"id,media_type,mime_type,storage_path,file_size",order:"created_at.desc",limit:"200"});
  const photos=allEvidence.filter(isSupportedPhoto);
  const explicit=body.selection&&typeof body.selection==="object";
  const rawSections=explicit&&body.selection.sections&&typeof body.selection.sections==="object"?body.selection.sections:{};
  const sections={
    dispute:bool(rawSections.dispute,true),
    location:bool(rawSections.location,true),
    evidence:bool(rawSections.evidence,true),
    ocr:bool(rawSections.ocr,true),
    history:bool(rawSections.history,true)
  };
  let selectedIds:string[];
  if(!sections.evidence)selectedIds=[];
  else if(explicit&&Array.isArray(body.selection.evidence_ids)){
    const requested=new Set(body.selection.evidence_ids.map((x:any)=>String(x)));
    selectedIds=photos.filter((x:any)=>requested.has(String(x.id))).map((x:any)=>String(x.id));
  }else{
    selectedIds=photos.slice(0,12).map((x:any)=>String(x.id));
  }
  if(selectedIds.length>MAX_SELECTED_PHOTOS)throw new Error("report_too_many_photos");
  const selectedSet=new Set(selectedIds);
  const selected=photos.filter((x:any)=>selectedSet.has(String(x.id)));
  const estimated=selected.reduce((a:number,x:any)=>a+Math.max(0,Number(x.file_size||0)),0);
  if(estimated>MAX_SELECTED_SOURCE_BYTES)throw new Error("report_too_large");

  const selection={sections,evidence_ids:selectedIds};
  const raw=randomToken(),hash=await sha256Hex(raw),expires=new Date(Date.now()+REPORT_TTL_MS).toISOString();
  await cleanupExpired();
  await insert("vehicle_report_requests",{token_hash:hash,vehicle_id:vs[0].id,stay_id:stay.id,created_by_telegram_user_id:uid,selection,estimated_source_bytes:estimated,expires_at:expires});
  return{url:`${SUPABASE_URL}/functions/v1/vehicle-report-api?t=${encodeURIComponent(raw)}`,expires_at:expires,plate:vs[0].plate,selected_photos:selectedIds.length,available_photos:photos.length,estimated_source_bytes:estimated};
}

async function build(request:any){
  const vehicleId=String(request.vehicle_id),stayId=String(request.stay_id),selection=request.selection||{},sections=selection.sections||{};
  const vs=await rest("vehicles",{id:`eq.${vehicleId}`,select:"*",limit:"1"});if(!vs.length)throw new Error("not_found");const source=vs[0];
  const stays=await rest("vehicle_stays",{id:`eq.${stayId}`,vehicle_id:`eq.${vehicleId}`,select:"id,stay_code,status,started_at,delivered_at,evidence_purged_at,updated_at",limit:"1"});if(!stays.length)throw new Error("stay_not_found");const stay=stays[0];
  const [events,evidence,verifications,disputes]=await Promise.all([
    rest("parking_events",{stay_id:`eq.${stayId}`,select:"id,worker_id,operation,latitude,longitude,accuracy_m,location_text,created_at",order:"created_at.desc",limit:"200"}),
    rest("vehicle_evidence",{stay_id:`eq.${stayId}`,select:"id,uploaded_by,stage,evidence_type,media_type,storage_bucket,storage_path,mime_type,file_size,created_at",order:"created_at.desc",limit:"200"}),
    rest("plate_verifications",{stay_id:`eq.${stayId}`,select:"worker_id,expected_plate,detected_plate,result,override_reason,created_at",order:"created_at.desc",limit:"200"}),
    rest("vehicle_disputes",{stay_id:`eq.${stayId}`,select:"status,reason,opened_at,closed_at,close_note",order:"opened_at.desc",limit:"100"})
  ]);
  const ids=[...new Set([...events.map((x:any)=>x.worker_id),...evidence.map((x:any)=>x.uploaded_by),...verifications.map((x:any)=>x.worker_id)].filter(Boolean))];
  let workers:any[]=[];if(ids.length)workers=await rest("workers",{id:`in.(${ids.join(",")})`,select:"id,full_name"});const wm=Object.fromEntries(workers.map((w:any)=>[w.id,w.full_name]));
  const isCurrent=stay.status==="active",lastLoc=events.find((e:any)=>(e.latitude!=null&&e.longitude!=null)||e.location_text),lastMovement=events.find((e:any)=>["pickup","park","relocate","retrieve","Vehículo reubicado"].includes(e.operation))||events[0];
  const v=isCurrent?source:{...source,status:"retrieved",parked_at:null,updated_at:stay.delivered_at||stay.updated_at,current_lat:lastLoc?.latitude??null,current_lng:lastLoc?.longitude??null,current_accuracy_m:lastLoc?.accuracy_m??null,current_location_text:lastLoc?.location_text??null};

  const selectedIds=new Set((Array.isArray(selection.evidence_ids)?selection.evidence_ids:[]).map((x:any)=>String(x)));
  const availablePhotos=evidence.filter(isSupportedPhoto);
  const selectedPhotos=bool(sections.evidence,true)?availablePhotos.filter((e:any)=>selectedIds.has(String(e.id))):[];
  const openDispute=disputes.find((d:any)=>d.status==="open")||null;

  const pdf=await PDFDocument.create();
  const regular=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  const A4:[number,number]=[595.28,841.89],margin=44,width=507;
  let page=pdf.addPage(A4),y=800;
  function addPage(){page=pdf.addPage(A4);y=800}
  function ensure(h:number){if(y-h<48)addPage()}
  function txt(t:any,x:number,yy:number,size=10,font=regular,color=rgb(.12,.16,.22),maxWidth=width-(x-margin)){page.drawText(clean(t),{x,y:yy,size,font,color,maxWidth})}
  function line(t:any,size=10,indent=0,b=false){const str=clean(t);const max=Math.max(28,Math.floor((width-indent)/(size*.53)));const words=str.split(/\s+/);let cur="";const lines:string[]=[];for(const w of words){if((cur+" "+w).trim().length>max){if(cur)lines.push(cur);cur=w}else cur=(cur+" "+w).trim()}if(cur)lines.push(cur);ensure(lines.length*(size+4)+4);for(const l of lines){txt(l,margin+indent,y,size,b?bold:regular);y-=size+4}y-=2}
  function section(title:string){ensure(38);y-=8;page.drawRectangle({x:margin,y:y-5,width,height:24,color:rgb(.94,.96,.99)});txt(title,margin+10,y+2,12,bold,rgb(.06,.2,.45));y-=34}

  page.drawText("ParkingMartin-G",{x:margin,y,size:13,font:bold,color:rgb(.15,.38,.78)});y-=24;
  page.drawText("Informe de Expediente 360º",{x:margin,y,size:24,font:bold,color:rgb(.05,.09,.16)});y-=34;
  line(`Matrícula: ${v.plate}`,16,0,true);
  line(`Estado: ${statuses[v.status]||String(v.status||"-").toUpperCase()}   |   Generado: ${fdate(new Date())}`,10);
  line(`Estancia: ${stay.stay_code}   |   Entrada: ${fdate(stay.started_at)}   |   Entrega: ${fdate(stay.delivered_at)}`,9);
  line(`Último movimiento: ${lastMovement?ops[lastMovement.operation]||lastMovement.operation:"Sin movimientos"}${lastMovement?" · "+fdate(lastMovement.created_at):""}`,9);
  line("Los datos esenciales anteriores son obligatorios y siempre forman parte del informe.",8);

  if(bool(sections.dispute,true)){
    section("Retención y disputa");
    if(openDispute){line("EXPEDIENTE EN DISPUTA - retención suspendida",10,0,true);line(`Abierta: ${fdate(openDispute.opened_at)} - Motivo: ${openDispute.reason||"-"}`,9)}
    else line("Sin disputa activa. La estancia sigue la política normal de retención.",9);
  }

  if(bool(sections.location,true)){
    section("Ubicación");
    line(`Aparcado: ${fdate(v.parked_at)}`);
    line(`Referencia: ${v.current_location_text||"Sin referencia"}`);
    line(`Precisión GPS: ${v.current_accuracy_m==null?"-":Math.round(v.current_accuracy_m)+" m"}`);
    if(v.current_lat!=null&&v.current_lng!=null)line(`Coordenadas: ${Number(v.current_lat).toFixed(6)}, ${Number(v.current_lng).toFixed(6)}`);
  }

  if(bool(sections.ocr,true)){
    section("Verificación OCR");
    if(!verifications.length)line("Sin verificaciones OCR.");
    else for(const z of verifications){line(`${fdate(z.created_at)} - ${ocrResult[z.result]||String(z.result||"OCR").toUpperCase()} - Esperada: ${z.expected_plate||"-"} - Detectada: ${z.detected_plate||"-"}${z.override_reason?" - Motivo: "+z.override_reason:""}`,9)}
  }

  if(bool(sections.history,true)){
    section("Historial operativo");
    if(!events.length)line("Sin historial.");
    else for(const e of events){line(`${fdate(e.created_at)} - ${ops[e.operation]||e.operation||"Evento"} - ${wm[e.worker_id]||"Operario"}${e.location_text?" - "+e.location_text:""}`,9)}
  }

  if(bool(sections.evidence,true)){
    addPage();
    section(`Evidencias fotográficas seleccionadas (${selectedPhotos.length}/${availablePhotos.length})`);
    if(!selectedPhotos.length)line("No se seleccionaron fotografías para esta copia del expediente.",9);
    let slot=0;
    for(const e of selectedPhotos){
      if(slot>0&&slot%2===0)addPage();
      const slotIndex=slot%2,slotTop=slotIndex===0?744:382,maxW=507,maxH=282;
      try{
        const bytes=await objectBytes(e.storage_bucket||"vehicle-evidence",e.storage_path);
        if(bytes){
          const mime=String(e.mime_type||"").toLowerCase();
          const img=mime==="image/png"||/\.png$/i.test(String(e.storage_path||""))?await pdf.embedPng(bytes):await pdf.embedJpg(bytes);
          const sc=Math.min(maxW/img.width,maxH/img.height);
          const w=img.width*sc,h=img.height*sc,x=margin+(maxW-w)/2;
          page.drawImage(img,{x,y:slotTop-h,width:w,height:h});
          txt(stage[e.stage]||e.stage||"Evidencia",margin,slotTop-h-17,10,bold);
          txt(`${fdate(e.created_at)} · ${wm[e.uploaded_by]||"Operario"}`,margin,slotTop-h-32,9,regular);
        }else{
          page.drawRectangle({x:margin,y:slotTop-210,width:maxW,height:190,borderColor:rgb(.75,.78,.83),borderWidth:1,color:rgb(.97,.97,.98)});
          txt("Evidencia seleccionada no disponible en Storage",margin+18,slotTop-115,11,bold);
          txt(stage[e.stage]||e.stage||"Evidencia",margin,slotTop-228,10,bold);
          txt(`${fdate(e.created_at)} · ${wm[e.uploaded_by]||"Operario"}`,margin,slotTop-243,9,regular);
        }
      }catch{
        page.drawRectangle({x:margin,y:slotTop-210,width:maxW,height:190,borderColor:rgb(.75,.78,.83),borderWidth:1,color:rgb(.97,.97,.98)});
        txt("No se pudo representar esta evidencia",margin+18,slotTop-115,11,bold);
      }
      slot++;
    }
    y=slot%2===0?48:90;
  }

  section("Contenido excluido de esta copia");
  const excluded:string[]=[];
  if(!bool(sections.dispute,true))excluded.push("retención/disputa");
  if(!bool(sections.location,true))excluded.push("ubicación");
  if(!bool(sections.ocr,true))excluded.push(`OCR (${verifications.length} registros)`);
  if(!bool(sections.history,true))excluded.push(`historial operativo (${events.length} eventos)`);
  const excludedPhotos=availablePhotos.length-selectedPhotos.length;
  if(!bool(sections.evidence,true))excluded.push(`evidencias fotográficas (${availablePhotos.length} excluidas)`);
  else if(excludedPhotos>0)excluded.push(`evidencias fotográficas (${excludedPhotos} de ${availablePhotos.length} excluidas)`);
  if(excluded.length){line("Esta copia fue generada de forma selectiva. Se excluyó por selección del usuario:",9,0,true);for(const x of excluded)line("• "+x,9,10)}
  else line("No se excluyó información opcional disponible de esta estancia.",9);
  line("La información excluida no se considera inexistente: puede seguir disponible en el expediente digital mientras permanezca dentro de su política de retención.",8);

  section("Nota de integridad");
  line("Documento generado automáticamente a partir de los datos registrados en ParkingMartin-G. Es una copia informativa de solo lectura; el expediente digital es la fuente operativa.",8);

  const pages=pdf.getPages(),total=pages.length;
  pages.forEach((p:any,i:number)=>{p.drawText(`ParkingMartin-G · Expediente 360º · Página ${i+1}/${total}`,{x:44,y:22,size:7,font:regular,color:rgb(.45,.49,.56)})});
  const bytes=await pdf.save();return{bytes,plate:v.plate};
}

Deno.serve(async(req)=>{
  const url=new URL(req.url);
  if(req.method==="GET"&&url.searchParams.get("attest")==="1")return releaseAttestation();
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors()});
  try{
    if(req.method==="POST"){
      const origin=req.headers.get("Origin");if(origin&&origin!==ORIGIN)return json({ok:false,error:"origin_not_allowed"},403);
      const b=await req.json(),uid=await initData(String(b.initData||""));
      const users=await rest("telegram_users",{telegram_user_id:`eq.${uid}`,active:"eq.true",select:"telegram_user_id",limit:"1"});if(!users.length)return json({ok:false,error:"not_authorized"},403);
      const out=await createRequest(b,uid);
      return json({ok:true,...out,expires_in_minutes:15,max_selected_source_bytes:MAX_SELECTED_SOURCE_BYTES});
    }
    if(req.method==="GET"){
      const raw=String(url.searchParams.get("t")||"");if(raw.length<20)throw new Error("invalid_token");
      const hash=await sha256Hex(raw);
      const rows=await rest("vehicle_report_requests",{token_hash:`eq.${hash}`,select:"id,vehicle_id,stay_id,selection,expires_at",limit:"1"});
      const request=rows[0];if(!request)throw new Error("invalid_token");
      if(new Date(request.expires_at).getTime()<=Date.now())throw new Error("expired_token");
      await patch("vehicle_report_requests",{id:`eq.${request.id}`},{last_accessed_at:new Date().toISOString()});
      const r=await build(request);
      return new Response(r.bytes,{status:200,headers:{"Content-Type":"application/pdf","Content-Disposition":`inline; filename="Expediente-${String(r.plate).replace(/[^A-Za-z0-9_-]/g,"_")}.pdf"`,"Cache-Control":"private, max-age=300","X-Content-Type-Options":"nosniff"}});
    }
    return json({ok:false,error:"method_not_allowed"},405);
  }catch(e){
    console.error(e);const m=String((e as Error)?.message||e);
    if(req.method==="GET")return new Response("Informe no disponible: "+m,{status:m==="expired_token"?410:400,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}});
    const status=m==="not_authorized"?403:m==="not_found"||m==="stay_not_found"?404:m==="report_too_large"||m==="report_too_many_photos"?413:400;
    return json({ok:false,error:m},status);
  }
});
