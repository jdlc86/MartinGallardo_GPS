self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  const req=event.request;
  const url=new URL(req.url);
  if(req.mode==='navigate'&&url.origin===self.location.origin&&url.pathname.includes('/preview-modern/')){
    event.respondWith((async()=>{
      const res=await fetch(req);
      const type=res.headers.get('content-type')||'';
      if(!type.includes('text/html'))return res;
      let html=await res.text();
      if(!html.includes('access-runtime.js')){
        html=html.replace('</head>','<script src="access-runtime.js?v=1"></script></head>');
      }
      const headers=new Headers(res.headers);
      headers.set('content-type','text/html; charset=utf-8');
      headers.delete('content-length');
      return new Response(html,{status:res.status,statusText:res.statusText,headers});
    })());
  }
});
