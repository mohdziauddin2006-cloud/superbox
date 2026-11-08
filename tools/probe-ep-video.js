var BROWSER = (SB_ARGS && SB_ARGS[0]) || 'local';
var out = { browser: BROWSER };
var pageUrl = 'https://www.eporner.com/embed/A6NCzdaefZ0/';
var j = await (await fetch('http://127.0.0.1:46901/extract?url=' + encodeURIComponent(pageUrl), { cache: 'no-store' })).json();
out.extract = { type: j.type, file: String(j.file || '').slice(0, 160), play: String(j.play || '').slice(0, 120) };
var src = BROWSER === 'local' ? j.file : (j.file.match(/url=([^&]+)/) ? decodeURIComponent(j.file.match(/url=([^&]+)/)[1]) : j.file);
out.src = src.slice(0, 180);
var v = document.createElement('video');
v.muted = true; v.volume = 0; v.setAttribute('muted', ''); v.playsInline = true; v.autoplay = true;
v.style.cssText = 'position:fixed;left:-10px;top:-10px;width:2px;height:2px;opacity:0;pointer-events:none';
document.body.appendChild(v);
var events = [];
['loadstart','loadedmetadata','loadeddata','canplay','playing','stalled','suspend','error','abort','progress','durationchange'].forEach(function (n) {
  v.addEventListener(n, function () { events.push({ n: n, t: Date.now() - t0, rs: v.readyState, ns: v.networkState, err: v.error ? v.error.code : 0, dur: v.duration }); });
});
var t0 = Date.now();
v.src = src;
try { await v.play(); } catch (e) { out.playErr = String(e && e.message || e); }
for (var i = 0; i < 20; i++) {
  await new Promise(function (r) { setTimeout(r, 500); });
  if (v.readyState >= 2 && !v.paused) break;
}
out.final = { t: Date.now() - t0, rs: v.readyState, ns: v.networkState, paused: v.paused, err: v.error ? v.error.code : 0, dur: v.duration, muted: v.muted };
out.events = events;
try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch (e) {}
return out;
