function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
var out = { t0: 0 };
var t0 = Date.now();
var c = document.getElementById('content');
function stats() {
  var rows = Array.prototype.slice.call(document.querySelectorAll('#content .row'));
  var loaded = rows.filter(function (w) { return w.querySelector('.card'); });
  var loading = rows.filter(function (w) {
    var e = w.querySelector('.empty');
    return e && /loading/i.test(e.textContent || '');
  });
  return { rows: rows.length, loaded: loaded.length, loading: loading.length, cards: document.querySelectorAll('#content .card').length };
}
for (var i = 0; i < 40; i++) {
  await sleep(250);
  if (stats().cards > 0) break;
}
out.firstPaintMs = Date.now() - t0;
out.afterPaint = stats();
await sleep(3000);
out.after3s = stats();
/* Scroll to the bottom in steps to prove lazy rows hydrate on demand. */
for (i = 0; i < 8; i++) { c.scrollTop = Math.min(c.scrollHeight, c.scrollTop + 900); await sleep(400); }
await sleep(2500);
out.afterScroll = stats();
out.scrollTop = c.scrollTop;
out.scrollHeight = c.scrollHeight;
return out;
