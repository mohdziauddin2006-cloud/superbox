var SUB = (SB_ARGS && SB_ARGS[0]) || 'eporner';
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function muteAll() {
  Array.prototype.slice.call(document.querySelectorAll('video,audio')).forEach(function (m) {
    try { m.muted = true; m.volume = 0; m.setAttribute('muted', ''); } catch (e) {}
  });
}
muteAll();
var mo = new MutationObserver(muteAll);
try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}

/* Wrap extract so every in-app resolution is timed. */
var log = [];
var orig = SC.extract;
SC.extract = async function (u, t, ms) {
  var s = Date.now();
  try {
    var r = await orig.call(SC, u, t, ms);
    log.push({ ms: Date.now() - s, url: String(u || '').slice(0, 90), type: r && r.type, ok: r && r.ok, err: r && r.error });
    return r;
  } catch (e) {
    log.push({ ms: Date.now() - s, url: String(u || '').slice(0, 90), thrown: String(e && e.message || e) });
    throw e;
  }
};

var nav = document.querySelector('#nav button[data-sec="adult"]');
nav.click();
await sleep(900);
var chip = document.querySelector('#content .subnav .chip[data-vsub="' + SUB + '"]');
chip.click();
var rows = [];
for (var i = 0; i < 30; i++) {
  await sleep(500);
  rows = Array.prototype.slice.call(document.querySelectorAll('#content .row'));
  var done = rows.length && rows.slice(0, 4).every(function (w) {
    var e = w.querySelector('.empty');
    return !(e && /loading/i.test(e.textContent || ''));
  });
  if (done) break;
}
var card = rows[0] && rows[0].querySelector('.card');
if (!card) { mo.disconnect(); return { err: 'no card', log: log }; }
var title = (card.querySelector('.t') || {}).textContent || '';
var t0 = Date.now();
card.click();
var v = null, playing = false, states = [];
for (i = 0; i < 60; i++) {
  await sleep(500);
  muteAll();
  v = document.querySelector('#pVideo');
  var msg = document.querySelector('#pMsg');
  var st = {
    t: Date.now() - t0,
    src: v ? String(v.currentSrc || v.src || '').slice(0, 80) : '',
    rs: v ? v.readyState : -1,
    paused: v ? v.paused : null,
    muted: v ? v.muted : null,
    err: v && v.error ? v.error.code : 0,
    msg: msg ? String(msg.textContent || '').replace(/\s+/g, ' ').slice(0, 60) : ''
  };
  if (states.length < 5 || st.rs > 0) states.push(st);
  if (v && v.readyState >= 2 && !v.paused && !v.error) { playing = true; break; }
}
if (playing) { await sleep(1000); states.push({ sample: true, ct: v.currentTime, rs: v.readyState, muted: v.muted }); }
try { mo.disconnect(); } catch (e) {}
Array.prototype.slice.call(document.querySelectorAll('video,audio')).forEach(function (m) {
  try { m.pause(); m.removeAttribute('src'); m.load(); } catch (e) {}
});
try { var c = document.querySelector('#pClose'); if (c) c.click(); } catch (e) {}
return { sub: SUB, title: title, playing: playing, totalMs: Date.now() - t0, log: log, states: states };
