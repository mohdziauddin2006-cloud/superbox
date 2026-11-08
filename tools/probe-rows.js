var out = {};
async function probe(name, fn) {
  var t0 = Date.now();
  try {
    var items = await Promise.race([
      fn(),
      new Promise(function (_r, bad) { setTimeout(function () { bad(new Error('timeout-30s')); }, 30000); })
    ]);
    out[name] = { ms: Date.now() - t0, n: (items || []).length, sample: (items || []).slice(0, 2).map(function (x) { return { t: String(x.t || '').slice(0, 60), kind: x.kind, page: String(x.page || '').slice(0, 80), hls: String(x.hls || '').slice(0, 60) }; }) };
  } catch (e) {
    out[name] = { ms: Date.now() - t0, err: String(e && e.message || e) };
  }
}
await probe('ep-latest', function () { return SC.epRow({ q: '', order: 'latest', badge: 'EP' }); });
await probe('r34v-animated', function () { return SC.r34vRow({ q: 'animated', badge: 'R34' }); });
await probe('hc-newest', function () { return SC.hcRow({ u: 'https://www.hentaicity.com/', badge: 'HC' }); });
await probe('htv-latest', function () { return SC.htvRow({ u: 'https://hentai.tv/api/browse', badge: 'HTV' }); });
await probe('ai-trending', function () { return SC.aiRow({ u: 'https://huangguodrama.ai/api/home-feed/?locale=en&sort=popular&offset=0', badge: 'AI', pages: 1 }); });
await probe('aws-xs', function () {
  var r = (Z.VAULT.aws || [])[0];
  return SC.xsRow(r.path, r);
});
return out;
