var SUB = (SB_ARGS && SB_ARGS[0]) || 'eporner';
var ROW = Number((SB_ARGS && SB_ARGS[1]) || 0);

/* Hard mute every media element, including ones created later. */
function muteAll() {
  Array.prototype.slice.call(document.querySelectorAll('video,audio')).forEach(function (m) {
    try { m.muted = true; m.volume = 0; m.setAttribute('muted', ''); } catch (e) {}
  });
}
muteAll();
var mo = new MutationObserver(muteAll);
try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function teardown() {
  try { mo.disconnect(); } catch (e) {}
  Array.prototype.slice.call(document.querySelectorAll('video,audio')).forEach(function (m) {
    try { m.pause(); m.removeAttribute('src'); m.load(); } catch (e) {}
  });
}

var nav = document.querySelector('#nav button[data-sec="adult"]');
if (!nav) return { err: 'no adult nav' };
nav.click();
await sleep(900);
var chip = document.querySelector('#content .subnav .chip[data-vsub="' + SUB + '"]');
if (!chip) return { err: 'no chip ' + SUB };
chip.click();
var rows = [], i;
for (i = 0; i < 30; i++) {
  await sleep(1000);
  rows = Array.prototype.slice.call(document.querySelectorAll('#content .row'));
  var done = rows.length && rows.slice(0, 4).every(function (w) {
    var e = w.querySelector('.empty');
    return !(e && /loading/i.test(e.textContent || ''));
  });
  if (done) break;
}
var row = rows[ROW];
if (!row) { teardown(); return { err: 'no row', rows: rows.length }; }
var card = row.querySelector('.card');
if (!card) { teardown(); return { err: 'row has no card', title: (row.querySelector('h3') || {}).textContent }; }
var title = (card.querySelector('.t') || {}).textContent || '';
card.click();

var start = Date.now(), states = [], playing = false, picks = [];
var detailClicked = false;
for (i = 0; i < 80; i++) {
  await sleep(500);
  muteAll();
  /* TMDB-backed lanes (Adult Movies, country cinema) open a detail screen
     first: press its primary Play button exactly once, then keep watching. */
  if (!detailClicked) {
    var dp = document.querySelector('#content .detail .btns button.primary');
    if (dp) { detailClicked = true; try { dp.click(); } catch (e) {} }
  }
  picks = Array.prototype.slice.call(document.querySelectorAll('#pMsg .pickbtn'));
  if (!playing && picks.length) { try { picks[0].click(); picks = []; } catch (e) {} }
  var v = document.querySelector('#pVideo');
  var msg = document.querySelector('#pMsg');
  var st = {
    t: Date.now() - start,
    src: v ? String(v.currentSrc || v.src || '').slice(0, 110) : '',
    rs: v ? v.readyState : -1,
    ns: v ? v.networkState : -1,
    paused: v ? v.paused : null,
    muted: v ? v.muted : null,
    err: v && v.error ? v.error.code : 0,
    msg: msg ? String(msg.textContent || '').replace(/\s+/g, ' ').slice(0, 90) : '',
    player: !!(document.querySelector('#playerView') && !document.querySelector('#playerView').classList.contains('hidden'))
  };
  /* Keep only the last 12 states + the first few so the payload stays small. */
  if (states.length < 4 || i % 8 === 0) states.push(st);
  if (v && v.readyState >= 2 && !v.paused && !v.error) { playing = true; break; }
  var failedMsg = /unavailable|failed|could not|no playable/i.test(st.msg || '') && st.player;
  if (failedMsg) { states.push(st); break; }
}
/* Never leave media running: record at most one second of verified playback. */
if (playing) { await sleep(1000); var v2 = document.querySelector('#pVideo'); states.push({ t: Date.now() - start, sample: true, rt: v2 ? v2.currentTime : -1, rs: v2 ? v2.readyState : -1, paused: v2 ? v2.paused : null, err: v2 && v2.error ? v2.error.code : 0, muted: v2 ? v2.muted : null }); }
teardown();
try { var close = document.querySelector('#pClose, .pclose, [data-player-close]'); if (close) close.click(); } catch (e) {}
return { sub: SUB, row: ROW, title: title, picks: picks.map(function (b) { return String(b.textContent || '').slice(0, 40); }), playing: playing, states: states };
