function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
var v = document.getElementById('video');
var player = document.getElementById('player');
function snap() {
  return {
    src: (v.currentSrc || v.src || '').slice(0, 100),
    ready: v.readyState,
    network: v.networkState,
    paused: v.paused,
    time: Math.round((v.currentTime || 0) * 10) / 10,
    duration: Math.round((v.duration || 0) * 10) / 10,
    error: v.error ? v.error.code : 0,
    visible: !player.classList.contains('hidden')
  };
}
function close() {
  var b = document.getElementById('pBack');
  if (b) b.click();
}
async function test(name, url, opts) {
  close();
  await sleep(600);
  var res = { name: name };
  try { SBApp.playDirect(url, name, opts || {}); } catch (e) { res.startError = String(e); return res; }
  /* Wait for real progress, not just a readyState: this is the condition a
     user cares about. Ceiling 12 s, then measure 2 s of playback and stop. */
  for (var i = 0; i < 24; i++) {
    await sleep(500);
    if (v.error) break;
    if (!v.paused && v.currentTime > 0.5) break;
  }
  res.start = snap();
  await sleep(2000);
  res.after2s = snap();
  close();
  await sleep(1200);
  res.stopped = !!player.classList.contains('hidden') && v.paused;
  return res;
}
var out = {};
out.mp4 = await test('Engine MP4', 'https://filesamples.com/samples/video/mp4/sample_640x360.mp4', {});
out.hls = await test('Engine HLS', 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', { hls: true });
return out;
