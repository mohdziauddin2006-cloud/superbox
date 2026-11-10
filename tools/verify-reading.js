/* Reading-room release check: both lanes, real chapter/episode, page image. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const C = document.getElementById('content');
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(600); }
  return null;
}
document.querySelector('#nav button[data-sec="reading"]').click();
await until(() => C.querySelector('[data-rd-open]'), 40000);

async function lane(id) {
  const tab = C.querySelector('[data-rd-source="' + id + '"]');
  const r = { cards: 0, imgs: 0, loaded: 0, chapters: 0, page: false };
  if (!tab) return r;
  tab.click();
  await until(() => C.querySelector('[data-rd-open^="' + id + ':"]'), 45000);
  const cards = Array.from(C.querySelectorAll('[data-rd-open^="' + id + ':"]'));
  r.cards = cards.length;
  await until(() => {
    const list = Array.from(C.querySelectorAll('[data-rd-open^="' + id + ':"] img'));
    return list.some((i) => i.complete && i.naturalWidth > 0);
  }, 30000);
  const imgs = Array.from(C.querySelectorAll('[data-rd-open^="' + id + ':"] img'));
  r.imgs = imgs.length;
  r.loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
  /* Popularity order puts official-only titles first: they list chapters but
     no readable pages. Re-query the grid each attempt (Back re-renders it) and
     keep looking until a title actually opens a page. */
  for (let n = 0; n < Math.min(cards.length, 8); n++) {
    const card = C.querySelectorAll('[data-rd-open^="' + id + ':"]')[n];
    if (!card) break;
    card.click();
    await until(() => C.querySelector('.rd-chap, .rd-empty'), 25000);
    await sleep(700);
    const chaps = Array.from(C.querySelectorAll('.rd-chap'));
    if (!chaps.length) {
      const back = C.querySelector('#rdBack');
      if (back) back.click();
      await sleep(700);
      continue;
    }
    r.chapters = chaps.length;
    r.title = (C.querySelector('.rd-dinfo h1')?.textContent || '').slice(0, 60);
    chaps[0].click();
    const img = await until(() => {
      const i = document.querySelector('.rd-reader .rd-strip img.rd-on');
      return i && i.complete && i.naturalWidth > 0 ? i : null;
    }, 45000);
    r.page = !!img;
    r.pageSize = img ? img.naturalWidth + 'x' + img.naturalHeight : '';
    const close = document.querySelector('.rd-rbar button');
    if (close) close.click();
    await sleep(500);
    const back = C.querySelector('#rdBack');
    if (back) back.click();
    await sleep(700);
    if (r.page) break;
  }
  return r;
}
out.mangadex = await lane('md');
out.webtoon = await lane('wt');
document.querySelector('#nav button[data-sec="home"]').click();
return JSON.stringify(out);
