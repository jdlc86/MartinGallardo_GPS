import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const RELEASE_PRODUCT="ParkingMartin-G";
const RELEASE_VERSION="1.4.0";
const RELEASE_BUILD="2026.09.04.04";
const RELEASE_SOURCE_REVISION="c0dd9262efcf34612bca31e20a49a09a4526b5cb";
const ORIGIN="https://jdlc86.github.io";
function cors(){return{"Access-Control-Allow-Origin":ORIGIN,"Access-Control-Allow-Headers":"content-type","Access-Control-Allow-Methods":"GET,OPTIONS","Cache-Control":"no-store","Vary":"Origin"}}
function json(x:any,s=200){return new Response(JSON.stringify(x),{status:s,headers:{"Content-Type":"application/json; charset=utf-8","X-Content-Type-Options":"nosniff",...cors()}})}
Deno.serve(req=>{
  const u=new URL(req.url);
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors()});
  if(req.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);
  return json({ok:true,service:"connectivity-health",product:RELEASE_PRODUCT,version:RELEASE_VERSION,build:RELEASE_BUILD,source_revision:RELEASE_SOURCE_REVISION,ts:new Date().toISOString()});
});