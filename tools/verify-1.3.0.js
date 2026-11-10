/* SuperBox 1.3.0 release check, evaluated inside the app page:
     node tools/cdp-run.mjs 9333 tools/verify-1.3.0.js
   Covers the Shield gate, the Sources hub, a real Reading chapter (image load
   through the Shield + disk cache) and a muted playback cap of 10 seconds. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const content = () => document.getElementById('content');

function nav(sec) {
  const b = document.querySelector('#nav button[data-sec="' + sec + '"]');
  if (b) b.click();
  return !!b;
}
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await sleep(500);
  }
  return null;
}

/* ---- Shield gate -------------------------------------------------------- */
const gate = document.getElementById('vpnGate');
out.shield = {
  gateHidden: !!gate && gate.classList.contains('hidden'),
  title: document.getElementById('vpnTitle')?.textContent || '',
  egress: document.getElementById('vpnEgress')?.textContent || '',
  warp: document.getElementById('vpnWarp')?.textContent || ''
};

/* ---- Reading ------------------------------------------------------------ */
nav('reading');
await until(() => content().querySelector('[data-rd-source="md"]'), 20000);
const mdTab = content().querySelector('[data-rd-source="md"]');
if (mdTab) mdTab.click();
await until(() => content().querySelectorAll('[data-rd-open^="md:"]').length, 30000);
let imgs = Array.from(content().querySelectorAll('[data-rd-open^="md:"] img'));
out.reading = {
  cards: content().querySelectorAll('[data-rd-open^="md:"]').length,
  images: imgs.length,
  loadedImages: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
  chips: content().querySelectorAll('[data-rd-genre]').length,
  heading: (content().innerText || '').slice(0, 70).replace(/\n/g, ' | ')
};

/* Titles ordered by popularity can be official-only (external chapters).
   Re-query the grid every attempt: navigating back re-renders it, so the
   cached NodeList would hold detached nodes. */
out.chapterList = false;
out.chapter = { readerOpen: false, firstPageLoaded: false, width: 0, pages: 0 };
for (let n = 0; n < 6; n++) {
  const card = content().querySelectorAll('[data-rd-open^="md:"]')[n];
  if (!card) break;
  card.click();
  await until(() => content().querySelector('.rd-chap, .rd-empty'), 25000);
  await sleep(700);
  const chaps = Array.from(content().querySelectorAll('.rd-chap'));
  if (!chaps.length) {
    const back = content().querySelector('#rdBack');
    if (back) back.click();
    await sleep(600);
    continue;
  }
  out.chapterList = true;
  chaps[0].click();
  const pageImg = await until(() => {
    const i = document.querySelector('.rd-reader .rd-strip img.rd-on');
    return i && i.complete && i.naturalWidth > 0 ? i : null;
  }, 40000);
  out.chapter = {
    readerOpen: !!document.querySelector('.rd-reader'),
    firstPageLoaded: !!pageImg,
    width: pageImg ? pageImg.naturalWidth : 0,
    pages: document.querySelectorAll('.rd-reader .rd-strip img').length
  };
  const close = document.querySelector('.rd-rbar button');
  if (close) close.click();
  await sleep(500);
  if (out.chapter.firstPageLoaded) break;
  const back = content().querySelector('#rdBack');
  if (back) back.click();
  await sleep(600);
}

/* ---- Sources ------------------------------------------------------------ */
nav('sources');
await sleep(1200);
const srcCards = content().querySelectorAll('[data-src]');
out.sources = {
  cards: srcCards.length,
  groups: content().querySelectorAll('.sh-group').length,
  chips: content().querySelectorAll('.sh-chip').length
};
const pick = Array.from(srcCards).find((c) => !c.hasAttribute('data-adult'));
if (pick) {
  pick.click();
  await sleep(2500);
  const frame = document.querySelector('.srcframe iframe');
  out.sourceFrame = {
    open: !!document.querySelector('.srcframe'),
    src: (frame && frame.getAttribute('src') || '').slice(0, 80)
  };
  const back = document.querySelector('.srcbar button');
  if (back) back.click();
}

/* ---- Muted playback, hard 10s ceiling ----------------------------------- */
nav('home');
const started = Date.now();
const bridge = await SC.base();
const v = document.createElement('video');
v.muted = true;
v.volume = 0;
v.playsInline = true;
v.style.cssText = 'position:fixed;left:-9999px;width:2px;height:2px';
v.src = bridge + '/raw?url=' + encodeURIComponent('https://filesamples.com/samples/video/mp4/sample_640x360.mp4');
document.body.appendChild(v);
let playErr = '';
try { await v.play(); } catch (e) { playErr = String(e && e.message || e); }
await until(() => v.currentTime > 0.4, 8000);
out.playback = {
  advanced: Math.round(v.currentTime * 10) / 10,
  duration: Math.round((v.duration || 0) * 10) / 10,
  width: v.videoWidth,
  height: v.videoHeight,
  muted: v.muted && v.volume === 0,
  error: playErr,
  seconds: Math.round((Date.now() - started) / 100) / 10
};
if (v.currentTime > 10) v.currentTime = 10;
v.pause();
v.removeAttribute('src');
v.load();
v.remove();

nav('home');
return JSON.stringify(out);
