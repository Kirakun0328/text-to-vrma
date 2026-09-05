import {writeFile} from 'node:fs/promises';
const tabs=await fetch('http://127.0.0.1:9223/json').then(r=>r.json());
const tab=tabs.find(t=>t.type==='page'&&t.url.includes(':5173'));
const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let next=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id);}};
const call=(method,params={})=>new Promise(resolve=>{const id=++next;pending.set(id,resolve);ws.send(JSON.stringify({id,method,params}));});
try{
 await call('Page.navigate',{url:'http://localhost:5173/'});await new Promise(r=>setTimeout(r,1500));
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 const result=await call('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
 const $=id=>document.getElementById(id);$('authMode').value='ardy';$('authMode').dispatchEvent(new Event('change'));
 if($('generateBtn').nextElementSibling!==$('status'))throw Error('Generation status must be directly below Generate');
 $('ardyPlanner').value='codex';$('ardyPlanner').dispatchEvent(new Event('change'));
 if($('correctionSettings').open)throw Error('Advanced correction settings should start closed');
 const card=$('authMode').closest('.card');
 if($('motionDetails').open)throw Error('Motion details should start closed');
 const duration=$('ardyDuration').getBoundingClientRect(),loop=$('loopSelect').getBoundingClientRect();
 if(Math.abs(duration.left-loop.left)>1||Math.abs(duration.width-loop.width)>1)throw Error('Motion controls are not aligned');
 $('ardyDuration').value='5';$('ardyDuration').dispatchEvent(new Event('input'));
 if($('autoLengthCheck').checked)throw Error('Explicit duration should disable auto length');
 $('ardyDuration').value='';$('ardyDuration').dispatchEvent(new Event('input'));
 if(!$('autoLengthCheck').checked)throw Error('Empty duration should enable auto length');
 $('motionDetails').querySelector('summary').click();
 if(!$('motionDetails').open||!$('autoLengthCheck').getClientRects().length)throw Error('Motion details cannot be opened');
 $('motionDetails').querySelector('summary').click();
 // Larger type and generation controls remain visible above the collapsed correction settings.
 if(card.getBoundingClientRect().height>530)throw Error('Engine card is still too tall');
 for(const code of ['en','zh','ko','ja']){
  $('langSelect').value=code;$('langSelect').dispatchEvent(new Event('change'));
  if(code!=='ja'&&/[ぁ-ゖァ-ヺ]/.test($('correctionSettings').querySelector('summary').textContent))throw Error('Untranslated settings');
 }
 $('panel').scrollTop=card.offsetTop-16;
 return {height:card.getBoundingClientRect().height,correctionCollapsed:!$('correctionSettings').open,autoCorrection:$('refineCheck').checked};
 })()`});
 if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
 console.log(JSON.stringify(result.result.value));
 const shot=await call('Page.captureScreenshot',{format:'png'});await writeFile('release/settings-layout.png',Buffer.from(shot.data,'base64'));
 await call('Runtime.evaluate',{expression:"document.getElementById('panel').scrollTop=document.getElementById('textInput').closest('.card').offsetTop-16"});
 const motionShot=await call('Page.captureScreenshot',{format:'png'});await writeFile('release/motion-settings-layout.png',Buffer.from(motionShot.data,'base64'));
}finally{ws.close();}
