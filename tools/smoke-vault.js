/* SuperBox Vault smoke test.
   Run inside the Android WebView (see tools/README.md):
     node tools/cdp-run.mjs 9223 tools/smoke-vault.js
   Returns JSON with the drawer, hero, sources sheet and section nav state. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

WA.openDrawer();
await sleep(400);
const drawer = document.getElementById('waDrawer');
const groups = Array.from(drawer.querySelectorAll('.wa-drawer-title')).map((x) => x.textContent.trim());
const navs = Array.from(drawer.querySelectorAll('.wa-nav')).map((x) => ({
  id: x.getAttribute('data-nav'),
  text: x.querySelector('.wa-nav-tx b').textContent,
  note: x.querySelector('.wa-nav-tx em').textContent
}));
const vaultGroup = drawer.querySelector('.wa-drawer-vaultgroup');
const sourceLink = drawer.querySelector('.wa-src-link');
const drawerScroll = drawer.querySelector('.wa-drawer-panel').scrollTop;

document.querySelector('#waDrawer [data-nav="wa:home"]').click();
let t0 = Date.now();
while (Date.now() - t0 < 60000) {
  await sleep(1200);
  if (document.querySelectorAll('#view .wa-row .card').length >= 10) break;
}

const hero = {
  title: document.querySelector('#view .wa-vault-title')?.textContent.trim() || '',
  kicker: document.querySelector('#view .wa-vault-kicker')?.textContent.trim() || '',
  chips: Array.from(document.querySelectorAll('#view .wa-srcbar > *')).map((x) => x.textContent.trim()),
  rows: document.querySelectorAll('#view .wa-row').length,
  cards: document.querySelectorAll('#view .wa-row .card').length,
  activeTabs: document.querySelectorAll('#tabbar .tab.active').length
};

document.querySelector('#view [data-wa-sources]').click();
await sleep(600);
const sheetContent = document.getElementById('sheetContent');
const sources = {
  open: !document.getElementById('sheet').classList.contains('hidden'),
  title: sheetContent.querySelector('.sheet-title')?.textContent || '',
  items: Array.from(sheetContent.querySelectorAll('.wa-src-item')).map((x) => x.innerText.replace(/\s+/g, ' ').trim())
};
SBApp.closeSheet();
await sleep(300);

WA.openDrawer();
await sleep(300);
const resetTop = drawer.querySelector('.wa-drawer-panel').scrollTop;
document.querySelector('#waDrawer [data-nav="wa:webseries"]').click();
await sleep(1800);
const section = {
  kicker: document.querySelector('#view .page-kicker')?.textContent.trim() || '',
  title: document.querySelector('#view .page-title')?.textContent.trim() || '',
  activeTabs: document.querySelectorAll('#tabbar .tab.active').length
};

return JSON.stringify({
  drawer: {
    groups,
    navCount: navs.length,
    vaultGroup: !!vaultGroup,
    sourceLink: sourceLink?.innerText.replace(/\s+/g, ' ').trim() || '',
    scrollTop: drawerScroll,
    resetTop,
    navs
  },
  hero,
  sources,
  section,
  bannedBrands: document.body.innerText.match(/watchanybox|moviebox/gi) || []
});
