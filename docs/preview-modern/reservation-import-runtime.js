(function(){
  function clearImportUi(){
    var file=document.getElementById('importFile');
    var fileName=document.getElementById('fileName');
    var result=document.getElementById('importResult');
    var preview=document.getElementById('importPreview');
    var warnings=document.getElementById('importWarnings');
    var issues=document.getElementById('importIssues');
    var valid=document.getElementById('validCount');
    var invalid=document.getElementById('invalidCount');
    var selected=document.getElementById('importSelectedCount');
    var commit=document.getElementById('commitImport');

    if(file)file.value='';
    if(fileName)fileName.textContent='';
    if(result)result.hidden=true;
    if(preview)preview.innerHTML='';
    if(warnings){warnings.hidden=true;warnings.innerHTML='';}
    if(issues){issues.hidden=true;issues.innerHTML='';}
    if(valid)valid.textContent='0';
    if(invalid)invalid.textContent='0';
    if(selected)selected.textContent='0';
    if(commit)commit.disabled=true;
  }

  function install(){
    var importButton=document.getElementById('importButton');
    var overlay=document.getElementById('importOverlay');
    if(!importButton||importButton.dataset.pmgImportStateGuard==='1')return;

    var existingHandler=importButton.onclick;
    if(typeof existingHandler!=='function')return;

    importButton.dataset.pmgImportStateGuard='1';
    importButton.onclick=function(event){
      clearImportUi();
      return existingHandler.call(importButton,event);
    };

    if(overlay){
      overlay.addEventListener('click',function(event){
        if(event.target===overlay)clearImportUi();
      });
      var closeButton=overlay.querySelector('[data-close="importOverlay"]');
      if(closeButton)closeButton.addEventListener('click',clearImportUi);
    }
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});
  else install();
})();
