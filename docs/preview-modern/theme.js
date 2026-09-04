(function(){
  if(window.__PMG_THEME__)return;
  window.__PMG_THEME__=true;
  if(location.pathname.endsWith('/ai-dispatch.html')&&document.readyState==='loading')document.write('<script src="ai-dispatch-runtime.js?v=1"><\/script>');
  const KEY='pmg-theme-mode';
  const OPT_JOB_KEY='pmg-optimizer-active-job';
  const OPT_JOBS_URL='https://mvexykcxnpaywkbnoxwu.supabase.co/functions/v1/reservation-optimization-jobs-v1';
  const SUPABASE_URL='https://mvexykcxnpaywkbnoxwu.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY='sb_publishable_CtdeA8WPS-9bQhAC7_8e_w_5sBiNktm';
  const SUPABASE_JS='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.4/dist/umd/supabase.min.js';
  const MODES=new Set(['auto','light','dark']);
  let lastTheme='';
  function readMode(){try{const value=localStorage.getItem(KEY)||'auto';return MODES.has(value)?value:'auto'}catch{return'auto'}}
  function writeMode(value){try{localStorage.setItem(KEY,value)}catch{}}
  function autoTheme(){const hour=new Date().getHours();if(hour>=8&&hour<20)return'light';try{return matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}catch{return'dark'}}
  function resolved(value=readMode()){return value==='auto'?autoTheme():value}
  function syncChrome(theme){const color=theme==='light'?'#eef3f8':'#08111f';const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=color;try{const tg=window.Telegram?.WebApp;if(!tg)return;tg.setHeaderColor?.(color);tg.setBackgroundColor?.(color);tg.setBottomBarColor?.(color)}catch{}}
  function syncControl(mode,theme){document.querySelectorAll('.pmg-theme-option').forEach(button=>{const active=button.dataset.mode===mode;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active))});const control=document.querySelector('.pmg-theme-control');if(!control)return;control.textContent=mode==='auto'?'◐ Auto':theme==='light'?'☀️ Día':'🌙 Noche';control.title='Tema: '+(mode==='auto'?'Automático':theme==='light'?'Día':'Noche')}
  function apply(){const mode=readMode(),theme=resolved(mode),changed=theme!==lastTheme;document.documentElement.dataset.pmgTheme=theme;document.documentElement.dataset.pmgThemeMode=mode;syncChrome(theme);syncControl(mode,theme);lastTheme=theme;if(changed)window.dispatchEvent(new CustomEvent('pmg-themechange',{detail:{mode,theme}}));return theme}
  function set(mode){const next=MODES.has(mode)?mode:'auto';writeMode(next);return apply()}
  function readOptimizerJob(){try{return JSON.parse(localStorage.getItem(OPT_JOB_KEY)||'null')}catch{return null}}
  function writeOptimizerJob(job){try{job?localStorage.setItem(OPT_JOB_KEY,JSON.stringify(job)):localStorage.removeItem(OPT_JOB_KEY)}catch{};renderOptimizerChip(job)}
  function ensureOptimizerChip(){return null}
  function renderOptimizerChip(){return}
  async function optimizerStatusOnce(){
    const active=readOptimizerJob(),tg=window.Telegram?.WebApp;
    if(!active?.id||!tg?.initData)return null;
    try{
      const r=await fetch(OPT_JOBS_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:tg.initData,action:'status',job_id:active.id})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok||!d.ok)return null;
      const job=d.job||{};
      writeOptimizerJob({id:active.id,status:job.status||active.status,updated_at:job.updated_at||null});
      window.dispatchEvent(new CustomEvent('pmg-optimizer-status',{detail:d}));
      return d;
    }catch{return null}
  }
  function loadSupabaseRealtime(){
    if(window.__PMG_OPT_REALTIME_LOADING__)return;
    window.__PMG_OPT_REALTIME_LOADING__=true;
    const start=()=>{
      try{
        const sb=window.supabase?.createClient?.(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
        if(!sb)return;
        const ch=sb.channel('reservation-notifications')
          .on('broadcast',{event:'changed'},()=>optimizerStatusOnce())
          .subscribe();
        window.__PMG_OPT_REALTIME_CHANNEL__=ch;
      }catch{}
    };
    if(window.supabase?.createClient)return start();
    const s=document.createElement('script');s.src=SUPABASE_JS;s.async=true;s.onload=start;document.head.appendChild(s);
  }
  function mountOptimizerStatus(){
    renderOptimizerChip();
    optimizerStatusOnce();
    loadSupabaseRealtime();
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)optimizerStatusOnce()});
    window.addEventListener('storage',e=>{if(e.key===OPT_JOB_KEY)renderOptimizerChip()});
  }
  function mountControl(){
    if(document.querySelector('.pmg-theme-control'))return;
    const control=document.createElement('button');
    control.type='button';
    control.className='pmg-theme-control';
    control.setAttribute('aria-label','Cambiar tema');
    control.setAttribute('aria-expanded','false');
    control.setAttribute('aria-haspopup','dialog');
    control.setAttribute('aria-controls','pmg-theme-panel');
    const panel=document.createElement('div');
    panel.id='pmg-theme-panel';
    panel.className='pmg-theme-panel';
    panel.setAttribute('role','dialog');
    panel.setAttribute('aria-label','Apariencia');
    panel.innerHTML='<div class="pmg-theme-caption">APARIENCIA</div><button type="button" class="pmg-theme-option" data-mode="auto">◐ Automático</button><button type="button" class="pmg-theme-option" data-mode="light">☀️ Día</button><button type="button" class="pmg-theme-option" data-mode="dark">🌙 Noche</button>';
    function closePanel(returnFocus=false){panel.classList.remove('on');control.setAttribute('aria-expanded','false');if(returnFocus)control.focus({preventScroll:true})}
    control.addEventListener('click',()=>{const open=panel.classList.toggle('on');control.setAttribute('aria-expanded',String(open))});
    panel.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>{set(button.dataset.mode);closePanel(true)}));
    document.body.prepend(control,panel);
    document.addEventListener('click',event=>{if(event.target!==control&&!panel.contains(event.target))closePanel()});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&panel.classList.contains('on'))closePanel(true)});
    apply();
  }
  apply();
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',()=>{mountControl();mountOptimizerStatus()})}else{mountControl();mountOptimizerStatus()}
  setInterval(()=>{if(readMode()==='auto')apply()},60000);
  window.addEventListener('storage',event=>{if(event.key===KEY)apply()});
  try{matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>{if(readMode()==='auto')apply()})}catch{}
  window.PMGTheme={set,apply,mode:readMode,resolved};
  window.PMGOptimizer={setActiveJob:job=>writeOptimizerJob(job),clearActiveJob:()=>writeOptimizerJob(null),sync:optimizerStatusOnce,getActiveJob:readOptimizerJob};
})();
