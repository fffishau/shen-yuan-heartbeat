export function buildHeartbeatAppHtml(routeHint = ""): string {
  const route = JSON.stringify(routeHint.trim());
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>沉淵自主心跳</title>
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;padding:18px;background:transparent;color:CanvasText}
.shell{max-width:760px;margin:auto;display:grid;gap:14px}.card{border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:18px;padding:16px;background:color-mix(in srgb,Canvas 94%,transparent)}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:0 0 12px}.muted{opacity:.65;font-size:12px;line-height:1.5}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.metric{padding:11px;border-radius:12px;background:color-mix(in srgb,CanvasText 6%,transparent)}.label{font-size:11px;opacity:.6}.value{font-size:14px;margin-top:4px;overflow-wrap:anywhere}.controls{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:11px;padding:9px 12px;background:Canvas;color:CanvasText;cursor:pointer}button.primary{background:#2c2924;color:#fff;border-color:#2c2924}button.warn{color:#a32d2d}button:disabled{opacity:.45;cursor:wait}.ok{color:#22804a}.bad{color:#a32d2d}pre{font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}@media(max-width:520px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body><main class="shell">
  <section class="card"><h1>沉淵自主心跳</h1><div class="muted">官方 ChatGPT 回合負責身份、Warmup 與訊息決策；Cloudflare 只保存狀態、排程與稽核。</div></section>
  <section class="card"><h2>狀態</h2><div id="metrics" class="grid"></div><div id="status" class="muted" style="margin-top:10px">正在讀取…</div></section>
  <section class="card"><h2>控制</h2><div class="controls">
    <button data-control="heartbeat" data-enabled="true">啟用心跳</button><button data-control="heartbeat" data-enabled="false" class="warn">暫停心跳</button>
    <button data-control="push" data-enabled="true">啟用推播</button><button data-control="push" data-enabled="false" class="warn">停止推播</button>
    <button data-control="life-events" data-enabled="false" class="warn">撤銷生活事件讀取</button>
    <button id="refresh">重新整理</button>
  </div></section>
  <section class="card"><h2>Message Bridge</h2><div class="muted">只有在這個 App View 活著時，Bridge 才能較快把 pending wake 注入目前官方對話；關閉 ChatGPT 後由官方每小時 Automation 兜底。</div><div class="controls" style="margin-top:12px"><button id="listener" class="primary">開始監聽</button></div><div id="listenerStatus" class="muted" style="margin-top:10px">已掛載，尚未監聽。</div></section>
  <section class="card"><h2>最近稽核</h2><pre id="audit">尚未讀取</pre></section>
</main>
<script>
(() => {
  const ROUTE_HINT=${route};
  const pending=new Map(); let rpcId=1; let listening=false; let timer=0; let inFlight=false;
  const statusEl=document.getElementById('status'); const metricsEl=document.getElementById('metrics'); const auditEl=document.getElementById('audit'); const listenerEl=document.getElementById('listener'); const listenerStatus=document.getElementById('listenerStatus');
  function request(method,params){const id=rpcId++;window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*');return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});setTimeout(()=>{if(pending.has(id)){pending.delete(id);reject(new Error(method+' timed out'));}},20000);});}
  window.addEventListener('message',(event)=>{if(event.source!==window.parent)return;const msg=event.data;if(!msg||msg.jsonrpc!=='2.0'||msg.id===undefined||!pending.has(msg.id))return;const entry=pending.get(msg.id);pending.delete(msg.id);msg.error?entry.reject(new Error(msg.error.message||'Host request failed')):entry.resolve(msg.result);},{passive:true});
  const callTool=(name,args={})=>request('tools/call',{name,arguments:args});
  const text=(value)=>value===null||value===undefined?'—':String(value);
  function metric(label,value){const node=document.createElement('div');node.className='metric';const l=document.createElement('div');l.className='label';l.textContent=label;const v=document.createElement('div');v.className='value';v.textContent=text(value);node.append(l,v);return node;}
  async function refresh(){statusEl.textContent='讀取中…';try{const result=await callTool('heartbeat.status');const data=result.structuredContent;const s=data.state;metricsEl.replaceChildren(metric('心跳',s.heartbeatEnabled?'啟用':'暫停'),metric('推播',s.pushEnabled?'啟用':'停止'),metric('最近喚醒',s.lastOfficialWakeAt),metric('下次預定',s.nextWakeAt),metric('最近 Bark',s.lastBarkAt),metric('跳過原因',s.lastSkipReason),metric('最近錯誤',s.lastError),metric('今日官方喚醒',data.usageToday.officialWakes));statusEl.textContent='Bark 模式：'+data.deliveryMode+'；官方 Automation 最快每小時一次。';const audit=await callTool('heartbeat.audit',{limit:12});auditEl.textContent=JSON.stringify(audit.structuredContent.entries,null,2);}catch(error){statusEl.textContent='讀取失敗：'+error.message;}}
  document.getElementById('refresh').addEventListener('click',refresh);
  document.querySelectorAll('[data-control]').forEach((button)=>button.addEventListener('click',async()=>{button.disabled=true;try{await callTool('heartbeat.control',{control:button.dataset.control,enabled:button.dataset.enabled==='true'});await refresh();}catch(error){statusEl.textContent='控制失敗：'+error.message;}finally{button.disabled=false;}}));
  function visible(event){return [ROUTE_HINT,event.visibleText||''].filter(Boolean).join('\\n\\n');}
  async function dispatch(event){await request('ui/update-model-context',{content:[{type:'text',text:String(event.modelContext||''),annotations:{audience:['assistant']}}],structuredContent:{bridgeEvent:{eventId:event.id,kind:event.kind,source:event.source,createdAt:event.createdAt}}});await request('ui/message',{role:'user',content:[{type:'text',text:visible(event)}]});}
  async function sync(){if(!listening||inFlight)return;inFlight=true;try{const result=await callTool('bridge.sync',{listenerId:'view-'+location.href.slice(-24)});const event=result&&result._meta&&result._meta.event;if(!event){listenerStatus.textContent='監聽中，沒有 pending wake。';return;}listenerStatus.textContent='傳送 '+event.id+'…';try{await dispatch(event);await callTool('bridge.delivered',{eventId:event.id});listenerStatus.textContent='已送入官方對話：'+event.id;}catch(error){await callTool('bridge.release',{eventId:event.id,error:String(error.message||error)}).catch(()=>{});throw error;}}catch(error){listenerStatus.textContent='Bridge 錯誤：'+error.message;}finally{inFlight=false;}}
  listenerEl.addEventListener('click',()=>{listening=!listening;listenerEl.textContent=listening?'停止監聽':'開始監聽';listenerStatus.textContent=listening?'監聽中…':'已停止監聽。';clearInterval(timer);if(listening){sync();timer=setInterval(sync,15000);}});
  refresh();
})();
</script></body></html>`;
}
