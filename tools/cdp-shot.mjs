// Capture a screenshot + basic DOM state from an Electron/Chromium target via raw CDP.
// Usage: node cdp-shot.mjs <port> <outfile> [expr]
const port = process.argv[2] || '9333';
const out = process.argv[3] || 'cdp.png';
const expr = process.argv[4] || 'JSON.stringify({title:document.title, cards:document.querySelectorAll(".card,.poster,.movie-card").length, text:document.body.innerText.slice(0,300)})';

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page') || list[0];
if (!page) { console.error('no target', JSON.stringify(list)); process.exit(2); }
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

const evalRes = await call('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log('EVAL:', JSON.stringify(evalRes.result.value ?? evalRes.result.description));

const shot = await call('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('WROTE:', out);
ws.close();
process.exit(0);
