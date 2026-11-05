/* SuperBox Spotlight smoke test.
   Run inside the Android WebView (see tools/README.md):
     node tools/cdp-run.mjs 9223 tools/smoke-spotlight.js
   Visits every bottom tab and reports card counts plus visible branding. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};

for (const tab of ['home', 'movies', 'series', 'anime']) {
  SBApp.switchTab(tab);
  await sleep(5000);
  out[tab] = {
    cards: document.querySelectorAll('#view .card').length,
    heading: document.querySelector('#view')?.innerText.slice(0, 90).replace(/\n/g, ' | ') || ''
  };
}

SBApp.switchTab('me');
await sleep(600);
out.me = {
  title: document.querySelector('#view .me-name')?.textContent || '',
  sourcesRow: !!document.querySelector('#view [data-setting="sources"]')
};
out.tab = SBApp.state.tab;
out.tabs = document.querySelectorAll('#tabbar .tab').length;
out.bannedBrands = document.body.innerText.match(/watchanybox|moviebox/gi) || [];
return JSON.stringify(out);
