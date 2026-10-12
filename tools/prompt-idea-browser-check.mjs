import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const tabs = await fetch('http://127.0.0.1:9224/json').then(r => r.json());
const tab = tabs.find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1:5173'));
assert.ok(tab);
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let next = 0; const pending = new Map();
socket.onmessage = event => { const v = JSON.parse(event.data), p = pending.get(v.id); if (!p) return; pending.delete(v.id); v.error ? p.reject(Error(v.error.message)) : p.resolve(v.result); };
const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
async function check(realCodex) {
  const $ = id => document.getElementById(id), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async fn => { for(let i=0;i<1200;i++){if(fn())return;await pause(50);}throw Error('Timed out: '+$('promptIdeaStatus').textContent); };
  const require = (value, message) => { if(!value)throw Error(message); };
  await wait(() => window.__viewer?.vrm);
  const history = document.querySelectorAll('#history .hist-item').length;
  const originalFetch = window.fetch;
  const saved = { key: $('apiKey').value, base: $('apiBaseUrl').value, text: $('textInput').value, language: $('langSelect').value };
  const requests = [], languages = {};
  try {
    $('apiKey').value = 'test-only-key'; $('apiBaseUrl').value = 'https://api.openai.com/v1';
    window.fetch = async (url, options) => {
      if (String(url).includes('/chat/completions')) {
        const body = JSON.parse(options.body); requests.push({ url: String(url), input: JSON.parse(body.messages[1].content) });
        return new Response(JSON.stringify({choices:[{message:{content:'{"prompt":"ゆっくりお辞儀して、背筋を伸ばす。"}'}}]}),{status:200,headers:{'Content-Type':'application/json'}});
      }
      return originalFetch(url, options);
    };
    $('promptIdeaBtn').click(); await wait(() => !$('promptIdeaBtn').disabled);
    require($('textInput').value === 'ゆっくりお辞儀して、背筋を伸ばす。', 'Prompt not inserted');
    require(requests.length === 1, 'API priority failed');
    require(document.querySelectorAll('#history .hist-item').length === history, 'Motion generated automatically');
    for (const code of ['en','zh','ko','ja']) {
      $('langSelect').value = code; $('langSelect').dispatchEvent(new Event('change')); await pause(100);
      languages[code] = { button: $('promptIdeaBtn').textContent, status: $('promptIdeaStatus').textContent };
      require(languages[code].button.length > 0, 'Missing button label');
    }
    window.fetch = originalFetch;
    if (realCodex) {
      $('apiKey').value = ''; $('textInput').value = ''; $('promptIdeaBtn').click(); await wait(() => !$('promptIdeaBtn').disabled);
      require($('textInput').value.length > 0, 'Codex prompt failed: '+$('promptIdeaStatus').textContent);
    }
    $('langSelect').value = 'en'; $('langSelect').dispatchEvent(new Event('change')); await pause(300);
    const untranslated = [...document.querySelectorAll('body *')].filter(el => !['SCRIPT','STYLE','TEXTAREA','OPTION'].includes(el.tagName))
      .flatMap(el => [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE && /[ぁ-んァ-ヶ]/.test(n.textContent)).map(n => ({id:el.id,tag:el.tagName,text:n.textContent.trim()})));
    const untranslatedAttributes = [...document.querySelectorAll('[title],[placeholder],[aria-label]')].flatMap(el => ['title','placeholder','aria-label'].filter(attr=>/[ぁ-んァ-ヶ]/.test(el.getAttribute(attr)||'')).map(attr=>({id:el.id,attr,text:el.getAttribute(attr)})));
    $('langSelect').value = 'ja'; $('langSelect').dispatchEvent(new Event('change'));
    return { requests, languages, codexPrompt: $('textInput').value, untranslated, untranslatedAttributes };
  } finally { window.fetch=originalFetch; $('apiKey').value=saved.key; $('apiBaseUrl').value=saved.base; }
}
try {
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const result = await call('Runtime.evaluate', { expression:`(${check.toString()})(${process.argv.includes('--real-codex')})`, awaitPromise:true, returnByValue:true });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  await mkdir('release/prompt-idea-check', {recursive:true});
  await writeFile('release/prompt-idea-check/result.json', JSON.stringify(result.result.value,null,2));
  console.log(JSON.stringify(result.result.value));
  const layout = await call('Runtime.evaluate', { expression: `(() => { const e = document.getElementById('textInput').closest('.card'); e.scrollIntoView({block:'center'}); const b=e.getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height,scale:1}; })()`, returnByValue: true });
  const shot = await call('Page.captureScreenshot', { format: 'png', clip: layout.result.value });
  await writeFile('release/prompt-idea-check/layout.png', Buffer.from(shot.data,'base64'));
} finally { socket.close(); }
