// Inspect the provider overlay video element through CDP.
// Usage: node inspect-provider-video.mjs <port> [urlSubstring]
const port = process.argv[2] || '9223';
const needle = process.argv[3] || '';
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && needle && (t.url || '').includes(needle)) ||
  list.find(t => t.type === 'page' && !/\/index\.html/.test(t.url || ''));
if (!page) { console.error('no provider target', JSON.stringify(list.map(t => t.url))); process.exit(2); }
console.log('TARGET:', page.title, page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

const expr = `(async()=>{
  const v = document.querySelector('video');
  if (!v) return JSON.stringify({ video: false, iframes: document.querySelectorAll('iframe').length });
  return JSON.stringify({
    video: true,
    src: (v.currentSrc || v.src || '').slice(0, 140),
    readyState: v.readyState,
    networkState: v.networkState,
    paused: v.paused,
    time: Math.round(v.currentTime * 10) / 10,
    duration: Math.round(v.duration * 10) / 10,
    width: v.videoWidth,
    height: v.videoHeight,
    muted: v.muted,
    volume: v.volume
  });
})()`;
const evalRes = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (evalRes.exceptionDetails) console.log('ERROR:', JSON.stringify(evalRes.exceptionDetails.exception?.description || evalRes.exceptionDetails.text));
else console.log('EVAL:', JSON.stringify(evalRes.result.value ?? evalRes.result.description));
ws.close();
process.exit(0);
