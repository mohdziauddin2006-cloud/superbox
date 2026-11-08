var nav = document.querySelector('#nav button[data-sec="adult"]');
if (!nav) return { err: 'no adult nav' };
nav.click();
await new Promise(function (r) { setTimeout(r, 1200); });
var chips = Array.prototype.slice.call(document.querySelectorAll('#content .subnav .chip'));
var groups = chips.map(function (b) { return { id: b.getAttribute('data-vsub'), t: b.textContent }; });
var out = [];
for (var g = 0; g < groups.length; g++) {
  var chip = document.querySelector('#content .subnav .chip[data-vsub="' + groups[g].id + '"]');
  if (!chip) { out.push({ id: groups[g].id, err: 'chip missing' }); continue; }
  chip.click();
  var waited = 0, rows = [];
  function pending(w) {
    var e = w.querySelector('.empty');
    return !!e && /loading/i.test(e.textContent || '');
  }
  for (var i = 0; i < 100; i++) {
    await new Promise(function (r) { setTimeout(r, 1000); });
    waited = i + 1;
    rows = Array.prototype.slice.call(document.querySelectorAll('#content .row'));
    if (rows.length && rows.every(function (w) { return !pending(w); })) break;
  }
  out.push({
    id: groups[g].id,
    rows: rows.length,
    cards: rows.reduce(function (n, w) { return n + w.querySelectorAll('.card').length; }, 0),
    loading: rows.filter(pending).length,
    empty: rows.filter(function (w) { return w.querySelector('.empty') && !pending(w); }).length,
    emptyText: rows.filter(function (w) { return w.querySelector('.empty') && !pending(w); }).slice(0, 2).map(function (w) { return String((w.querySelector('.empty') || {}).textContent || '').slice(0, 60); }),
    titles: rows.slice(0, 4).map(function (w) { return (w.querySelector('h3') || {}).textContent || ''; }),
    waited: waited
  });
}
return { groups: groups, result: out };
