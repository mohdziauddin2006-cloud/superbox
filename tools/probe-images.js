var nav = document.querySelector('#nav button[data-sec="adult"]');
nav.click();
await new Promise(function (r) { setTimeout(r, 9000); });
var imgs = Array.prototype.slice.call(document.querySelectorAll('#content .card img'));
var stats = { total: imgs.length, loaded: 0, broken: 0, pending: 0, samples: [] };
imgs.forEach(function (im) {
  if (im.complete && im.naturalWidth > 0) stats.loaded++;
  else if (im.complete && im.naturalWidth === 0) stats.broken++;
  else stats.pending++;
});
stats.samples = imgs.slice(0, 10).map(function (im) {
  return { w: im.naturalWidth, complete: im.complete, src: String(im.currentSrc || im.src || '').slice(0, 120), retry: im.getAttribute('data-retry') };
});
return stats;
