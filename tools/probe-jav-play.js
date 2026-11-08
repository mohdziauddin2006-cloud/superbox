var nav = document.querySelector('#nav button[data-sec="adult"]');
if (!nav) return { err: 'no adult nav' };
nav.click();
var i, rows = [];
for (i = 0; i < 40; i++) {
  await new Promise(function (r) { setTimeout(r, 1000); });
  rows = Array.prototype.slice.call(document.querySelectorAll('#content .row'));
  if (rows.length && rows.every(function (w) { return w.querySelectorAll('.card').length > 0; })) break;
}
var first = rows[0] && rows[0].querySelector('.card');
if (!first) return { err: 'no cards', rows: rows.length };
first.click();
await new Promise(function (r) { setTimeout(r, 400); });
var picks = Array.prototype.slice.call(document.querySelectorAll('#pMsg .pickbtn'));
var pickInfo = picks.slice(0, 6).map(function (b) { return b.textContent; });
if (!picks.length) return { err: 'no picker', msg: (document.querySelector('#pMsg') || {}).className };
picks[0].click();
var states = [];
for (i = 0; i < 35; i++) {
  await new Promise(function (r) { setTimeout(r, 1000); });
  var v = document.querySelector('#pVideo');
  var msg = document.querySelector('#pMsg');
  states.push({
    t: i + 1,
    src: v ? String(v.currentSrc || v.src || '').slice(0, 160) : '',
    rs: v ? v.readyState : -1,
    ns: v ? v.networkState : -1,
    paused: v ? v.paused : null,
    err: v && v.error ? v.error.code : 0,
    msgHidden: msg ? msg.classList.contains('hidden') : null,
    msg: msg ? String(msg.textContent || '').replace(/\s+/g, ' ').slice(0, 120) : ''
  });
  if (v && v.readyState >= 2 && !v.paused) break;
}
return { rowCount: rows.length, picks: pickInfo, states: states, cache: (function () { try { return Object.keys(JSON.parse(localStorage.getItem('sb.desktop.rows.v2') || '{}').rows || {}).length; } catch (e) { return -1; } })() };
