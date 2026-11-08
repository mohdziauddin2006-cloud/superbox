var nav = document.querySelector('#nav button[data-sec="adult"]');
if (!nav) return { err: 'no adult nav' };
nav.click();
var out = [];
var i;
for (i = 0; i < 45; i++) {
  await new Promise(function (r) { setTimeout(r, 1000); });
  var rows = Array.prototype.slice.call(document.querySelectorAll('#content .row'));
  out = rows.map(function (w) {
    var cards = Array.prototype.slice.call(w.querySelectorAll('.card'));
    return {
      t: (w.querySelector('h3') || {}).textContent || '',
      n: cards.length,
      first: cards[0] ? ((cards[0].querySelector('.t') || {}).textContent || '') : '',
      empty: (w.querySelector('.empty') || {}).textContent || ''
    };
  });
  var done = rows.length && rows.every(function (w) { return w.querySelectorAll('.card').length > 0; });
  if (done) break;
}
var cache = 0;
try { cache = Object.keys((JSON.parse(localStorage.getItem('sb.desktop.rows.v2') || '{}').rows) || {}).length; } catch (e) {}
return { sec: document.body.getAttribute('data-sec'), waited: i + 1, rows: out, cache: cache };
