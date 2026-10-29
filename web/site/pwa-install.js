const button=document.getElementById('install-app');
let pendingPrompt=null;

function isStandalone(){return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone===true;}
function refreshButton(){button.hidden=isStandalone() || pendingPrompt===null;}

window.addEventListener('beforeinstallprompt',event=>{
  event.preventDefault();
  pendingPrompt=event;
  refreshButton();
});

button.addEventListener('click',async()=>{
  if(!pendingPrompt)return;
  const prompt=pendingPrompt;
  pendingPrompt=null;
  refreshButton();
  try{
    await prompt.prompt();
    await prompt.userChoice;
  }catch{
    // The browser may withdraw a prompt. The Chrome menu remains available.
  }
});

window.addEventListener('appinstalled',()=>{
  pendingPrompt=null;
  refreshButton();
});

refreshButton();
