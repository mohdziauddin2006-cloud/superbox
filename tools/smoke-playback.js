/* SuperBox Vault playback smoke test.
   Opens the first Vault title and presses Play. The stream resolves in the
   native provider overlay, so verify it with inspect-provider-video.mjs:
     node tools/cdp-run.mjs 9223 tools/smoke-playback.js
     node tools/inspect-provider-video.mjs 9223
   Press the ✕ in the overlay to return to the app. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

SBApp.switchTab('wa:home');
let t0 = Date.now();
while (Date.now() - t0 < 60000) {
  await sleep(1200);
  if (document.querySelectorAll('#view .wa-row .card').length >= 5) break;
}

const card = document.querySelector('#view .wa-row .card');
if (!card) return JSON.stringify({ error: 'no Vault card found' });
const name = card.getAttribute('aria-label') || '';
card.click();

t0 = Date.now();
while (Date.now() - t0 < 30000) {
  await sleep(800);
  if (document.querySelector('#waDetail [data-wad-play]')) break;
}

const detail = document.getElementById('waDetail');
const play = detail?.querySelector('[data-wad-play]');
if (!play) return JSON.stringify({ error: 'detail did not open', name });
play.click();

return JSON.stringify({
  opened: name,
  detailOpen: detail && !detail.classList.contains('hidden'),
  title: detail?.querySelector('.wad-info h1')?.textContent || '',
  action: 'provider ladder opened — run inspect-provider-video.mjs next'
});
