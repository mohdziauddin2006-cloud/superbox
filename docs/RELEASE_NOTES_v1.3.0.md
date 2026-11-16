# SuperBox 1.3.0 — the everywhere release

SuperBox 1.3.0 turns the app into a self-contained streaming and reading box.
The VPN is now part of the product, Moviebox is back on Windows and Android,
all 47 sources from `source.txt` are integrated, and the Reading room ships
with native MangaDex and WEBTOON readers.

## Highlights

### Shield — an embedded, open-source VPN

- `usque` v4.2.1 (GPL-3.0) speaking Cloudflare WARP over MASQUE.
- Anonymous registration. No account, email or personal details.
- Desktop: hidden `usque l4-http-proxy` on `127.0.0.1:46950`, wired into Node
  `fetch` and Chromium.
- Android: `libusque.so` per ABI, `l4-http-proxy`, wired into `LocalServer` and
  the WebView via `androidx.webkit` `ProxyController`.
- IPv6-first MASQUE on both platforms: the `2606:4700:103::2` anchor is tried
  before the IPv4 ladder, because congested IPv4 anchors measured 2–32 KB/s
  while the IPv6 path measured 197–415 KB/s.
- 13 region profiles — Global, US, Canada, UK, Australia, India, Germany,
  Japan, Singapore, Hong Kong, South Korea, France, Brazil — with 12 endpoint
  profiles each.
- The UI stays behind the Shield gate until the tunnel reports `warp=true`.
- Status tells the truth: requested region plus actual egress. Anycast cannot
  promise a country.
- Scoped split tunnel for the Moviebox media CDN, which rejects WARP with
  `427 Forbidden`.

### Moviebox restored

- Spotlight hero, 50-card front page and 16 shelves on desktop.
- Detail pages with seasons, episodes and audio tracks.
- Native playback with a 480p–1080p ladder, mute-safe controls and a clean
  teardown.
- `/raw` media proxy with a 2 MB first window, 8 MB follow-ups, 128 KB chunks
  and 24 parallel range workers.
- The CDN contract is enforced: `Range` + valid `Referer` + anti-bot
  `X-Client-Token`, and signed `t=` URLs are never reused after they stale.

### All 47 sources

The Sources tab is a first-class directory:

- **23 movies & TV:** NetMirror, Net77, Tubi, Pluto TV, Plex Watch, Amazon
  MiniTV, OlaMovies, BBC iPlayer, ITVX, 9Now, Sling, Filmzie, 7Reels, TrueID,
  SuperNova, Stirr, Kanopy, Hoopla, FAWESOME, Free Movies Cinema, BigFlix,
  ShemarooMe, YuppTV FAST.
- **10 anime:** AniWaves, 9Anime, AnimeVillage, Miruro, AniWatch, Yomi,
  AllManga, AniFlix, AniMixPlay, HiAnime.
- **14 manga & manhwa:** MangaDex, WEBTOON, Asura Scans, Flame Comics, Vortex
  Scans, HiveToons, Comix, ManhuaUS, NeloManga, Tappytoon, Tapas, MangaFire,
  ToonSutra, Hentai20.

Stable APIs get native rows; every other source opens in the VPN-routed in-app
browser. A normalised diff against `source.txt` reports no missing and no extra
entries.

### Reading room

- Language-first catalogue: pick a language (English first) and an optional
  format (Manga, Manhwa, Manhua, Other), then a genre. MangaDex rows use
  `availableTranslatedLanguage[]` and `originalLanguage[]`; WEBTOON maps the
  language to its locale and the format to Originals/Canvas.
- Genres, search and age filters (All ages, Teen, 18+).
- Cached, VPN-routed covers and pages through `/img`, with MIME sniffing that
  rejects anti-bot HTML.
- MangaDex's working cover host is learned once and cached.
- External-only chapters show an **External chapter** card with the publisher
  link instead of a blank reader.

### 18+ vault

- Rule34 rows use distinct search terms, keep only `/video/<id>/` cards and
  de-duplicate across rows.
- Rule34 quality comes from the KVS flashvars ladder (`_360`, `_480p`, `_720p`,
  …), keeping the signed `?v-acctoken`; the highest rendition is played.
- Hentaicity rows point at the final `videos/straight/*-popular.html` URLs
  because `/search/video/3d` and `/search/video/futanari` answer `301`.
- Hentaicity playback preserves the signed
  `.../.mp4.urlset/master.m3u8?validfrom=…&hash=…` playlist end to end and
  loads it through hls.js; the extractor no longer truncates it to `.mp4`.
- Hentai.tv has non-repeating rows (newest plus page two) and plays through the
  nhplayer signed-URL probe (offscreen iframe on desktop, 1×1 WebView on
  Android). The ad-laden nhplayer shell remains the fallback.

### Packaging

- Universal Android APK: `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`,
  `versionCode=4`, 277,497,277 bytes.
- NSIS Windows Setup: normal wizard, any folder or drive, 125,591,521 bytes.
- No portable EXE, no split APKs, no stale 1.2.0 artifacts.

## Verified

| Check | Result |
|---|---|
| Windows install | 1.3.0 installed to `C:\Program Files\SuperBox` |
| Windows Shield | gate hidden, `warp=ON`, egress `IN` |
| Windows Moviebox | hero + 50 cards + 16 rows; playback `readyState=4`, 1152×480 |
| Windows Reading | 24 cards, 32 chapters, page 768×1024 |
| Windows sources | 47 cards; iframe opens `netmirror.plus` |
| Android Shield | `ready egress=IN warp=true`, IPv6 anchor, 3 s warm start |
| Android Moviebox | `Daayra [Hindi]`, 853×480, 8,373 s, playing |
| Android Hentai.tv | signed r2 URL, 1,167 s, playing |
| Android Hentaicity | signed master playlist, 1,416 s, playing |
| Android Reading | 24 cards, 32 chapters, 768 px reader pages |
| Android sources | 47 cards, 3 groups, 4 filter chips |
| Media ceiling | no test stream exceeded 9 seconds |

## Checksums

```
SuperBox-Setup-1.3.0.exe   a21067ccc181088f62a03538fd3e4840b07b8bcdd6eecf191d4e2428875ad778
SuperBox-1.3.0.apk         1bb79e6230a9eedb8dd54e6cfa5a9e29f1d85eab764032ab607eadda0e4c4d6b
```

APK signing certificate SHA-256:
`5a59f92f2526dbdd47b679510ac9ec1754aa479330f304b727997aafa2d82017`

## Known limits

- WARP is anycast; the region picker chooses an endpoint pool, not a guaranteed
  country.
- Moviebox's media CDN rejects WARP, so its bytes use the scoped direct split.
- Comick's API was down, ManhuaUS serves a JS challenge, and Asura relies on
  unscraped Astro data; those open in the in-app browser.
- DRM-protected catalogues (for example BBC iPlayer) require their own licence
  and are not bypassed.
