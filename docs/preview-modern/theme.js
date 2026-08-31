(function(){
  if(window.__PMG_THEME__)return;
  window.__PMG_THEME__=true;
  const KEY='pmg-theme-mode';
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
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',mountControl):mountControl();
  setInterval(()=>{if(readMode()==='auto')apply()},60000);
  window.addEventListener('storage',event=>{if(event.key===KEY)apply()});
  try{matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>{if(readMode()==='auto')apply()})}catch{}
  window.PMGTheme={set,apply,mode:readMode,resolved};
})();
