// Online-only install UI. Authentication and analysis remain server-owned.
// No service worker, offline content store, navigation, or provider requests.
const button=document.getElementById('install-app');
const status=document.getElementById('install-status');
const standalone=window.matchMedia('(display-mode: standalone)');
let pendingPrompt=null;
let prompting=false;
let installed=false;
let guidance=status?.textContent??'';

function isStandalone(){return standalone.matches || window.navigator.standalone===true;}
function renderMessage(){
  if(status)status.textContent=installed
    ? '앱 설치 완료가 확인되었습니다. 인터넷 연결과 본인 인증은 계속 필요합니다.'
    : isStandalone()
      ? '앱 창으로 사용 중입니다. 인터넷 연결과 본인 인증은 계속 필요합니다.'
      : guidance;
}
function message(text){guidance=text;renderMessage();}
function refreshButton(){
  if(button){button.hidden=installed || isStandalone() || pendingPrompt===null || prompting;button.disabled=prompting;}
  renderMessage();
}

window.addEventListener('beforeinstallprompt',event=>{
  if(!button || installed || isStandalone())return;
  event.preventDefault();
  pendingPrompt=event;
  refreshButton();
  if(!prompting)message('브라우저가 앱 설치를 제공합니다. 오른쪽 위 앱 설치 버튼을 누르세요.');
});

button?.addEventListener('click',async()=>{
  if(!pendingPrompt || prompting || installed || isStandalone())return;
  const prompt=pendingPrompt;
  pendingPrompt=null;
  prompting=true;
  refreshButton();
  message('브라우저의 설치 창에서 선택해 주세요.');
  try{
    await prompt.prompt();
    const choice=await prompt.userChoice;
    if(!installed && !isStandalone())message(choice?.outcome==='accepted'
      ? '설치를 요청했습니다. 브라우저의 완료 안내 또는 홈 화면 아이콘을 확인하세요.'
      : '설치를 취소했습니다. 나중에 Chrome 메뉴에서 다시 확인할 수 있습니다.');
  }catch{
    if(!installed && !isStandalone())message('설치 창을 열지 못했습니다. Chrome 메뉴의 앱 설치 또는 홈 화면에 추가를 확인하세요.');
  }finally{
    prompting=false;
    refreshButton();
  }
});

window.addEventListener('appinstalled',()=>{
  installed=true;
  pendingPrompt=null;
  refreshButton();
});
standalone.addEventListener?.('change',refreshButton);
window.addEventListener('pageshow',refreshButton);
refreshButton();
