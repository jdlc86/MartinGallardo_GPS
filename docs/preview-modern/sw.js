const CACHE='pmg-shell-v4';
const CORE=['./','./index.html','./operations.html','./vehicles.html','./recent.html','./team-live.html','./gps-diagnostic.html','./vehicle-v7.html','./legal.html','./theme.css?v=9','./theme.js?v=8','./ux-errors.js?v=6','./access-runtime.js?v=5','./offline-runtime.js?v=1','./offline.html','./assets/favicon.svg?v=1','./assets/martin-gallardo-logo.svg?v=3'];
self.addEventListener('install',event=>event.waitUntil((async()=>{const c=await caches.open(CACHE);await Promise.allSettled(CORE.map(u=>c.add(u)));await self.skipWaiting()})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(k=>k.startsWith('pmg-shell-')&&k!==CACHE).map(k=>caches.delete(k)));await self.clients.claim()})()));
function cleanUrl(req){const u=new URL(req.url);u.search='';return u.toString()}
self.addEventListener('fetch',event=>{
  const req=event.request,url=new URL(req.url);
  if(req.method!=='GET'||url.origin!==self.location.origin)return;
  if(req.mode==='navigate'&&url.pathname.includes('/preview-modern/')){
    event.respondWith((async()=>{
      const cache=await caches.open(CACHE);
      try{
        const res=await fetch(req);
        if(res&&res.ok)cache.put(cleanUrl(req),res.clone()).catch(()=>{});
        return res;
      }catch(e){
        return (await cache.match('./offline.html'))||new Response('<h1>Sin conexión a Internet</h1>',{headers:{'Content-Type':'text/html; charset=utf-8'}});
      }
    })());
    return;
  }
  if(url.pathname.includes('/preview-modern/')){
    event.respondWith((async()=>{
      const cache=await caches.open(CACHE);
      const cached=await cache.match(req,{ignoreSearch:false})||await cache.match(cleanUrl(req));
      if(cached){fetch(req).then(r=>{if(r&&r.ok)cache.put(req,r.clone())}).catch(()=>{});return cached;}
      try{const res=await fetch(req);if(res&&res.ok)cache.put(req,res.clone()).catch(()=>{});return res}catch(e){return new Response('',{status:503,statusText:'Offline'})}
    })());
  }
});
