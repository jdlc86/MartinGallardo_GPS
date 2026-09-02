(function(){
  function install(){
    var importButton=document.getElementById('importButton');
    var importFile=document.getElementById('importFile');
    if(!importButton||!importFile||importButton.dataset.pmgDirectImport==='1')return;

    var existingHandler=importButton.onclick;
    if(typeof existingHandler!=='function')return;

    importButton.dataset.pmgDirectImport='1';
    importButton.onclick=function(event){
      existingHandler.call(importButton,event);
      if(importButton.disabled)return;
      importFile.click();
    };
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});
  else install();
})();
