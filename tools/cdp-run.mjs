// Run a JS file inside a CDP target and optionally screenshot.
// Usage: node cdp-run.mjs <port> <scriptfile> [outfile]
// The script file is evaluated in the page; wrap in an async IIFE and use
// `return` to send a value back (awaitPromise is enabled).
import { readFileSync, writeFileSync } from 'node:fs';

const port = process.argv[2] || '9223';
const file = process.argv[3];
const out = process.argv[4] || '';
if (!file) { console.error('usage: node cdp-run.mjs <port> <scriptfile> [outfile]'); process.exit(2); }
const src = readFileSync(file, 'utf8');
const sep = process.argv.indexOf('--');
const args = sep > 0 ? process.argv.slice(sep + 1) : [];
const expr = `(async()=>{const SB_ARGS=${JSON.stringify(args)};${src}\n})()`;

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /\/index\.html/.test(t.url || '')) ||
  list.find(t => t.type === 'page') || list[0];
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

const evalRes = await call('Runtime.evaluate', {
  expression: expr,
  returnByValue: true,
  awaitPromise: true
});
if (evalRes.exceptionDetails) {
  console.log('ERROR:', JSON.stringify(evalRes.exceptionDetails.exception?.description || evalRes.exceptionDetails.text));
} else {
  console.log('EVAL:', JSON.stringify(evalRes.result.value ?? evalRes.result.description));
}

if (out) {
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('WROTE:', out);
}
ws.close();
process.exit(0);
