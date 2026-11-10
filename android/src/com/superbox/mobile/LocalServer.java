package com.superbox.mobile;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * A tiny loopback HTTP bridge for the WebView UI.
 *
 * It serves the packaged mobile UI, signs Spotlight catalogue API calls, and proxies
 * media through a parallel range reader so large MP4 indexes arrive quickly.
 * The server only listens on 127.0.0.1 and is destroyed with the Activity.
 */
public class LocalServer {

    private static final String TAG = "SuperBoxServer";
    private static final String API_BASE = "https://h5-api.aoneroom.com/wefeed-h5api-bff";
    private static final String SITE = "https://movieboxph.org";
    private static final String TMDB_KEY = "3104601db7b49ab8140edd482412445a";
    private static final String UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
    private static final int START_PORT = 47821;
    private static final int END_PORT = 47832;
    private static final long WINDOW = 8L * 1024L * 1024L;
    // Small chunks matter more than total window size: the renderer cannot
    // decode anything until the first chunk is flushed, so 512 KB pieces kept
    // the spinner up for the whole first download.
    private static final int CHUNK = 128 * 1024;
    // The CDN throttles each TCP connection to roughly 20-100 KB/s. More
    // sockets are the only way to fill a mobile pipe: measured 8 sockets
    // ~= 286 KB/s, 16 ~= 788 KB/s, 24 ~= 1.0 MB/s on the reference stream.
    private static final int PARALLEL = 24;
    private static final long CHUNK_CACHE_LIMIT = 56L * 1024L * 1024L;
    private static final long API_CACHE_MS = 8L * 60L * 1000L;
    private static final long IMAGE_CACHE_MS = 7L * 24L * 60L * 60L * 1000L;
    private static final long PAGE_CACHE_MS = 15L * 60L * 1000L;
    private static final long HLS_CACHE_MS = 20L * 1000L;
    private static final long TMDB_CACHE_MS = 12L * 60L * 60L * 1000L;

    private final Context context;
    private final VpnManager vpn;
    private final ExecutorService clients = Executors.newCachedThreadPool();
    /* Access-ordered maps are LRU: the oldest entry is evicted first and the
       byte budget below keeps page/image bodies from growing without bound.
       The previous plain HashMaps only cleared wholesale at a count limit,
       which could briefly hold 180 multi-megabyte pages. */
    private final LinkedHashMap<String, Meta> metaCache =
            new LinkedHashMap<>(64, 0.75f, true);
    private final LinkedHashMap<String, CacheEntry> apiCache =
            new LinkedHashMap<>(128, 0.75f, true);
    private final Map<String, byte[]> assetCache = new HashMap<>();
    private final LinkedHashMap<String, byte[]> chunkCache =
            new LinkedHashMap<>(64, 0.75f, true);
    private final String token;
    private final File diskDir;
    private final SecureRandom random = new SecureRandom();
    private ServerSocket socket;
    private volatile boolean running;
    private long chunkCacheBytes;
    private long apiCacheBytes;
    private int diskWrites;

    private static final int META_CACHE_MAX = 160;
    private static final int API_CACHE_MAX = 260;
    private static final long API_CACHE_BYTES = 48L * 1024L * 1024L;

    public LocalServer(Context context, VpnManager vpn) {
        this.context = context.getApplicationContext();
        this.vpn = vpn;
        this.token = newToken();
        this.diskDir = new File(this.context.getCacheDir(), "sb-cache");
        if (!diskDir.exists()) diskDir.mkdirs();
    }

    /** Session token injected into index.html; every privileged route needs it. */
    public String getToken() {
        return token;
    }

    private String newToken() {
        byte[] raw = new byte[24];
        random.nextBytes(raw);
        StringBuilder sb = new StringBuilder(raw.length * 2);
        for (byte b : raw) sb.append(String.format("%02x", b & 0xff));
        return sb.toString();
    }

    public int start() throws IOException {
        ServerSocket ss = null;
        for (int p = START_PORT; p <= END_PORT; p++) {
            try {
                ServerSocket candidate = new ServerSocket();
                candidate.setReuseAddress(true);
                candidate.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), p), 32);
                ss = candidate;
                break;
            } catch (IOException ignored) {
            }
        }
        if (ss == null) {
            ss = new ServerSocket();
            ss.setReuseAddress(true);
            ss.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 32);
        }
        socket = ss;
        running = true;
        Thread accept = new Thread(new Runnable() {
            @Override public void run() { acceptLoop(); }
        }, "superbox-http");
        accept.setDaemon(true);
        accept.start();
        Thread warm = new Thread(new Runnable() {
            @Override public void run() { warmUp(); }
        }, "superbox-warm");
        warm.setDaemon(true);
        warm.start();
        return ss.getLocalPort();
    }

    /* First paint should never wait on the network. Fetch the home payload
       into the persistent cache as soon as the bridge starts. */
    private void warmUp() {
        try {
            String cacheKey = "api:/api/home?|" + SITE + "/";
            if (diskGet(cacheKey, API_CACHE_MS) == null && apiCacheGet(cacheKey, API_CACHE_MS) == null) {
                byte[] body = httpGetBytes(API_BASE + "/home", SITE + "/", 12000);
                if (body != null && body.length > 0) {
                    apiCachePut(cacheKey, body);
                    Log.i(TAG, "warm-up cached home (" + body.length + " bytes)");
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "warm-up: " + e.getMessage());
        }
    }

    public void stop() {
        running = false;
        try {
            if (socket != null) socket.close();
        } catch (IOException ignored) {
        }
        clients.shutdownNow();
    }

    private void acceptLoop() {
        while (running) {
            try {
                final Socket client = socket.accept();
                clients.execute(new Runnable() {
                    @Override public void run() { handle(client); }
                });
            } catch (IOException e) {
                if (running) Log.w(TAG, "accept: " + e.getMessage());
            }
        }
    }

    private void handle(Socket client) {
        long started = System.currentTimeMillis();
        try {
            client.setSoTimeout(45000);
            BufferedInputStream in = new BufferedInputStream(client.getInputStream(), 16384);
            OutputStream out = new BufferedOutputStream(client.getOutputStream(), 65536);

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;
            String[] first = requestLine.split(" ");
            if (first.length < 2) return;
            String method = first[0];
            String target = first[1];

            Map<String, String> headers = new HashMap<>();
            String line;
            int safety = 0;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    headers.put(line.substring(0, colon).trim().toLowerCase(Locale.US),
                            line.substring(colon + 1).trim());
                }
                if (++safety > 120) break;
            }

            if ("OPTIONS".equalsIgnoreCase(method)) {
                send(out, 204, "text/plain", new byte[0], null);
                return;
            }

            String path = target;
            String query = "";
            int qmark = target.indexOf('?');
            if (qmark >= 0) {
                path = target.substring(0, qmark);
                query = target.substring(qmark + 1);
            }
            Map<String, String> qs = parseQuery(query);

            boolean guarded = needsToken(path);
            if (guarded) {
                String supplied = qs.get("t");
                if (supplied == null || supplied.isEmpty()) supplied = headers.get("x-superbox-token");
                if (!token.equals(supplied)) {
                    send(out, 403, "application/json", bytes("{\"error\":\"forbidden\"}"),
                            "Cache-Control: no-store\r\n");
                    return;
                }
            }

            if ("/health".equals(path)) {
                send(out, 200, "application/json", bytes("{\"ok\":true,\"server\":\"SuperBox\"}"),
                        "Cache-Control: no-store\r\n");
                return;
            }
            if ("/favicon.ico".equals(path)) {
                send(out, 204, "image/x-icon", new byte[0], null);
                return;
            }

            /* Shield control plane. Must stay reachable while the tunnel is
               offline - this is what the gate UI polls. */
            if (path.startsWith("/api/vpn/")) {
                handleVpn(out, path, qs);
                return;
            }

            /* Kill switch: every upstream route is closed until WARP is up.
               Local assets (HTML/JS/CSS) keep loading so the gate can paint. */
            boolean upstream = "/img".equals(path) || "/page".equals(path)
                    || "/extract".equals(path) || path.startsWith("/tmdb/3/")
                    || path.startsWith("/api/home") || path.startsWith("/api/trending")
                    || path.startsWith("/api/detail") || path.startsWith("/api/play")
                    || path.startsWith("/api/rec") || path.startsWith("/api/search")
                    || "/stream".equals(path) || "/raw".equals(path)
                    || "/hls".equals(path) || "/hlsseg".equals(path)
                    || "/dash".equals(path) || "/dashseg".equals(path);
            if (upstream && (vpn == null || !vpn.isOn())) {
                send(out, 503, "application/json; charset=utf-8",
                        bytes("{\"error\":\"vpn_offline\",\"message\":\"SuperBox Shield is not connected. Upstream routes stay closed until the tunnel is up.\"}"),
                        "Cache-Control: no-store\r\nRetry-After: 4\r\n");
                return;
            }

            if ("/img".equals(path)) {
                String iu = qs.get("u");
                if (iu == null || iu.isEmpty()) iu = qs.get("url");
                handleImage(out, iu);
                return;
            }
            if ("/page".equals(path)) {
                handlePage(out, qs.get("url"), qs.get("ref"));
                return;
            }
            if ("/extract".equals(path)) {
                handleExtract(out, qs.get("url"), qs.get("title"));
                return;
            }
            if (path.startsWith("/tmdb/3/")) {
                handleTmdb(out, path, stripToken(query));
                return;
            }
            if ("/stream".equals(path) || "/raw".equals(path)) {
                handleStream(out, headers, qs.get("url"), qs.get("ref"));
                return;
            }
            if ("/hls".equals(path)) {
                handleHls(out, qs.get("url"), qs.get("ref"));
                return;
            }
            if ("/hlsseg".equals(path)) {
                handleSegment(out, headers, qs.get("url"), qs.get("ref"), null);
                return;
            }
            if ("/dash".equals(path)) {
                handleDash(out, qs.get("url"), qs.get("ref"));
                return;
            }
            if ("/dashseg".equals(path)) {
                handleSegment(out, headers, qs.get("url"), qs.get("ref"), "video/mp4");
                return;
            }
            if (path.startsWith("/api/")) {
                handleApi(out, path, qs);
                return;
            }
            serveAsset(out, path);
        } catch (Exception e) {
            Log.w(TAG, "request failed in " + (System.currentTimeMillis() - started) + "ms: " + e.getMessage());
        } finally {
            try { client.close(); } catch (IOException ignored) {}
        }
    }

    // ---------------------------------------------------------------- VPN

    private void handleVpn(OutputStream out, String path, Map<String, String> qs)
            throws IOException {
        if (vpn == null) {
            sendJson(out, 503, "{\"ok\":false,\"state\":\"unavailable\",\"error\":\"Shield is not initialised\"}");
            return;
        }
        String region = qs.get("region");
        if (region == null || region.isEmpty()) region = qs.get("r");
        try {
            if ("/api/vpn/status".equals(path)) {
                sendJson(out, 200, vpn.status().toString());
                return;
            }
            if ("/api/vpn/switch".equals(path)) {
                sendJson(out, 200, vpn.switchRegion(region).toString());
                return;
            }
            if ("/api/vpn/reconnect".equals(path)) {
                sendJson(out, 200, vpn.reconnect(region).toString());
                return;
            }
            if ("/api/vpn/ensure".equals(path)) {
                sendJson(out, 200, vpn.ensure(region).toString());
                return;
            }
            sendJson(out, 404, "{\"ok\":false,\"error\":\"unknown vpn route\"}");
        } catch (Exception e) {
            Log.w(TAG, "vpn route " + path + ": " + e.getMessage());
            sendJson(out, 200, vpn.status().toString());
        }
    }

    // ---------------------------------------------------------------- API

    private void handleApi(OutputStream out, String path, Map<String, String> qs) throws IOException {
        String upstreamPath;
        String ref = SITE + "/";
        String keyQuery = "";

        if ("/api/home".equals(path)) {
            upstreamPath = "/home";
        } else if ("/api/trending".equals(path)) {
            upstreamPath = "/subject/trending";
            keyQuery = buildQuery(qs, "page", "perPage", "tabId");
        } else if ("/api/detail".equals(path)) {
            upstreamPath = "/detail";
            keyQuery = buildQuery(qs, "subjectId", "detailPath", "se");
            ref = detailUrl(qs.get("detailPath"));
        } else if ("/api/play".equals(path)) {
            upstreamPath = "/subject/play";
            keyQuery = buildQuery(qs, "subjectId", "detailPath", "se", "ep");
            ref = detailUrl(qs.get("detailPath"));
        } else if ("/api/rec".equals(path)) {
            upstreamPath = "/subject/detail-rec";
            keyQuery = buildQuery(qs, "subjectId", "page", "perPage");
        } else if ("/api/search".equals(path)) {
            upstreamPath = "/search";
            keyQuery = buildQuery(qs, "keyword", "page", "perPage");
        } else {
            sendJson(out, 404, "{\"code\":404,\"message\":\"unknown api route\"}");
            return;
        }

        String cacheKey = "api:" + path + "?" + keyQuery + "|" + ref;
        CacheEntry hit = apiCacheGet(cacheKey, API_CACHE_MS);
        if (hit == null) {
            byte[] disk = diskGet(cacheKey, API_CACHE_MS);
            if (disk != null) hit = new CacheEntry(disk, "application/json; charset=utf-8");
        }
        if (hit != null) {
            send(out, 200, "application/json; charset=utf-8", hit.body,
                    "Cache-Control: private, max-age=60\r\nX-SuperBox-Cache: HIT\r\n");
            return;
        }

        String url = API_BASE + upstreamPath + (keyQuery.isEmpty() ? "" : "?" + keyQuery);
        byte[] body = httpGetBytes(url, ref, 22000);
        if (body == null || body.length == 0) {
            sendJson(out, 502, "{\"code\":502,\"message\":\"catalogue unavailable\",\"data\":null}");
            return;
        }
        // Some catalogue rows report a film as se=0/ep=0 while the signed
        // play endpoint only answers for se=1/ep=1 (and vice versa). Only an
        // EMPTY ladder triggers the alternate call, never a real episode.
        if ("/api/play".equals(path) && !isPlayable(body)) {
            String se = qs.get("se");
            String ep = qs.get("ep");
            if ("0".equals(se) && "0".equals(ep)) {
                String alt = "subjectId=" + enc(qs.get("subjectId"))
                        + "&detailPath=" + enc(qs.get("detailPath"))
                        + "&se=1&ep=1";
                byte[] altBody = httpGetBytes(API_BASE + upstreamPath + "?" + alt, ref, 22000);
                if (altBody != null && isPlayable(altBody)) body = altBody;
            }
        }
        apiCachePut(cacheKey, body);
        send(out, 200, "application/json; charset=utf-8", body,
                "Cache-Control: private, max-age=60\r\nX-SuperBox-Cache: MISS\r\n");
    }

    private String buildQuery(Map<String, String> qs, String... keys) {
        StringBuilder sb = new StringBuilder();
        for (String k : keys) {
            String v = qs.get(k);
            if (v == null || v.isEmpty()) continue;
            if (sb.length() > 0) sb.append('&');
            sb.append(enc(k)).append('=').append(enc(v));
        }
        return sb.toString();
    }

    private static String detailUrl(String detailPath) {
        String dp = detailPath == null ? "" : detailPath.replaceAll("^/+", "");
        return SITE + "/movies/" + dp;
    }

    private static boolean isPlayable(byte[] body) {
        if (body == null || body.length == 0) return false;
        try {
            JSONObject root = new JSONObject(new String(body, "UTF-8"));
            JSONObject data = root.optJSONObject("data");
            if (data == null) return false;
            return hasPlayableUrl(data.optJSONArray("streams"))
                    || hasPlayableUrl(data.optJSONArray("hls"))
                    || hasPlayableUrl(data.optJSONArray("dash"));
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean hasPlayableUrl(JSONArray arr) {
        if (arr == null) return false;
        for (int i = 0; i < arr.length(); i++) {
            Object o = arr.opt(i);
            if (o instanceof String) {
                if (!((String) o).isEmpty()) return true;
            } else if (o instanceof JSONObject) {
                JSONObject x = (JSONObject) o;
                if (!x.optString("url").isEmpty() && !x.optBoolean("vipLocked", false)) {
                    return true;
                }
            }
        }
        return false;
    }

    private byte[] httpGetBytes(String url, String ref, int timeoutMs) {
        for (int attempt = 0; attempt < 2; attempt++) {
            HttpURLConnection c = null;
            try {
                c = open(url, ref, null, 9000, timeoutMs);
                int code = c.getResponseCode();
                InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
                if (is == null) return null;
                byte[] body = readAll(is, 12 * 1024 * 1024);
                if (code >= 200 && code < 300) return body;
                if (attempt == 1) return body;
            } catch (IOException e) {
                if (attempt == 1) {
                    Log.w(TAG, "api " + url + ": " + e.getMessage());
                    return null;
                }
            } finally {
                if (c != null) c.disconnect();
            }
        }
        return null;
    }

    // ------------------------------------------------------------- images

    private void handleImage(OutputStream out, String url) throws IOException {
        url = normalizeUrl(url);
        if (url == null || url.isEmpty() || !isSafeUrl(url)) {
            send(out, 404, "text/plain", bytes("missing image"), null);
            return;
        }
        String key = "img:" + url;
        CacheEntry hit = apiCacheGet(key, IMAGE_CACHE_MS);
        if (hit == null) {
            byte[] disk = diskGet(key, IMAGE_CACHE_MS);
            if (disk != null) hit = new CacheEntry(disk, sniffImageType(disk));
        }
        if (hit != null) {
            send(out, 200, hit.type, hit.body,
                    "Cache-Control: public, max-age=604800, immutable\r\nX-SuperBox-Cache: HIT\r\n");
            return;
        }
        String referer = imageReferer(url);
        String[] refs = referer == null ? new String[]{null, SITE + "/"} : new String[]{referer, null, SITE + "/"};
        for (String ref : refs) {
            HttpURLConnection c = null;
            try {
                c = openImage(url, ref);
                int code = c.getResponseCode();
                /* 404/410 never becomes a valid image with another referer,
                   but the weserv tier below CAN still rescue it (the CDN may
                   only block this IP/UA), so do not break out of the chain. */
                if (code < 200 || code >= 300) continue;
                byte[] body = readAll(c.getInputStream(), 8 * 1024 * 1024);
                if (body.length == 0) continue;
                String type = c.getContentType();
                boolean trusted = type != null && type.startsWith("image/");
                if (!trusted) {
                    type = sniffImageType(body);
                    trusted = isImageBytes(body);
                }
                if (!trusted) continue;
                apiCachePut(key, body, type);
                send(out, 200, type, body,
                        "Cache-Control: public, max-age=604800, immutable\r\nX-SuperBox-Cache: MISS\r\n");
                return;
            } catch (Exception e) {
                // try the next referer policy
            } finally {
                if (c != null) c.disconnect();
            }
        }
        /* Final tier: images.weserv.nl re-fetches the image server-side, which
           rescues hosts that reject the device's IP or serve a hotlink wall.
           The result is cached exactly like a direct hit. */
        if (url.indexOf("images.weserv.nl") < 0) {
            HttpURLConnection wc = null;
            try {
                String w = "https://images.weserv.nl/?url=" + URLEncoder.encode(
                        url.replaceFirst("^https?://", ""), "UTF-8");
                wc = openImage(w, null);
                int code = wc.getResponseCode();
                if (code >= 200 && code < 300) {
                    byte[] body = readAll(wc.getInputStream(), 8 * 1024 * 1024);
                    if (body.length > 0 && isImageBytes(body)) {
                        String type = wc.getContentType();
                        if (type == null || !type.startsWith("image/")) type = sniffImageType(body);
                        apiCachePut(key, body, type);
                        send(out, 200, type, body,
                                "Cache-Control: public, max-age=604800, immutable\r\n"
                                        + "X-SuperBox-Cache: MISS\r\nX-SuperBox-Tier: weserv\r\n");
                        return;
                    }
                }
            } catch (Exception ignored) {
            } finally {
                if (wc != null) wc.disconnect();
            }
        }
        send(out, 404, "text/plain", bytes("image unavailable"), null);
    }

    /* Real image magic beats a lying content type: hotlink walls and error
       pages used to be cached as JPEG and then shown as permanent blanks. */
    private static boolean isImageBytes(byte[] b) {
        if (b == null || b.length < 4) return false;
        int b0 = b[0] & 0xff;
        if (b0 == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return true;
        if (b[0] == 'G' && b[1] == 'I' && b[2] == 'F') return true;
        if (b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F') return true;
        if (b0 == 0xff && (b[1] & 0xff) == 0xd8) return true;
        if (b[0] == 'B' && b[1] == 'M') return true;
        if (b[0] == '<') return true; // SVG
        return false;
    }

    private static String normalizeUrl(String url) {
        if (url == null) return null;
        String u = url.trim().replace("&amp;", "&");
        if (u.startsWith("//")) u = "https:" + u;
        if (u.startsWith("http%3A")) {
            try { u = URLDecoder.decode(u, "UTF-8"); } catch (Exception ignored) {}
        }
        return u;
    }

    private static String imageReferer(String url) {
        String host = hostOf(url);
        if (host == null) return null;
        if (host.contains("tmdb") || host.contains("themoviedb")) return "https://www.themoviedb.org/";
        if (host.contains("archive.org")) return "https://archive.org/";
        if (host.contains("ytimg") || host.contains("youtube") || host.contains("ggpht")) return "https://www.youtube.com/";
        if (host.contains("iptv-org")) return "https://iptv-org.github.io/";
        if (host.contains("aoneroom") || host.contains("moviebox")) return SITE + "/";
        if (host.contains("anilist")) return "https://anilist.co/";
        if (host.contains("wikipedia") || host.contains("wikimedia")) return "https://en.wikipedia.org/";
        if (host.contains("mangadex")) return "https://mangadex.org/";
        if (host.contains("pstatic") || host.contains("webtoons") || host.contains("naver")) return "https://www.webtoons.com/";
        return originOf(url);
    }

    private static String hostOf(String url) {
        try { return new URL(url).getHost().toLowerCase(Locale.US); } catch (Exception e) { return null; }
    }

    private static String originOf(String url) {
        try {
            URL u = new URL(url);
            return u.getProtocol() + "://" + u.getHost() + "/";
        } catch (Exception e) {
            return null;
        }
    }

    private static String sniffImageType(byte[] b) {
        if (b == null || b.length < 12) return "image/jpeg";
        if ((b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "image/png";
        if (b[0] == 'G' && b[1] == 'I' && b[2] == 'F') return "image/gif";
        if (b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F'
                && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "image/webp";
        if (b[0] == '<') return "image/svg+xml";
        return "image/jpeg";
    }

    private HttpURLConnection openImage(String url, String ref) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection(proxy());
        c.setConnectTimeout(9000);
        c.setReadTimeout(18000);
        c.setInstanceFollowRedirects(true);
        c.setUseCaches(false);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8");
        c.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
        c.setRequestProperty("Accept-Encoding", "identity");
        c.setRequestProperty("Connection", "close");
        if (ref != null && !ref.isEmpty()) c.setRequestProperty("Referer", ref);
        String h = hostOf(url);
        if (h != null && (h.contains("aoneroom") || h.contains("moviebox"))) {
            c.setRequestProperty("Origin", SITE);
            c.setRequestProperty("X-Client-Info", "{\"timezone\":\"Asia/Calcutta\"}");
            c.setRequestProperty("X-Request-Lang", "en");
            c.setRequestProperty("X-Client-Token", mbToken());
        }
        return c;
    }

    // ------------------------------------------------------------- web proxy

    /* Generic read-only proxy for the Vault scrapers. Returns the
       upstream body with its content type so JSON APIs and HTML pages both
       arrive intact; the WebView cannot read most of these hosts directly
       because of CORS/Cloudflare. */
    private void handlePage(OutputStream out, String url, String ref) throws IOException {
        url = normalizeUrl(url);
        if (url == null || url.isEmpty() || !isSafeUrl(url)) {
            send(out, 400, "text/plain", bytes("missing url"), null);
            return;
        }
        String key = "page:" + url + "|" + (ref == null ? "" : ref);
        CacheEntry hit = apiCacheGet(key, PAGE_CACHE_MS);
        if (hit == null) {
            byte[] disk = diskGet(key, PAGE_CACHE_MS);
            if (disk != null) hit = new CacheEntry(disk, "text/plain; charset=utf-8");
        }
        if (hit != null) {
            send(out, 200, hit.type, hit.body, "Cache-Control: private, max-age=120\r\nX-SuperBox-Cache: HIT\r\n");
            return;
        }
        HttpURLConnection c = null;
        try {
            c = openWeb(url, ref);
            int code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            byte[] body = is == null ? new byte[0] : readAll(is, 12 * 1024 * 1024);
            String type = c.getContentType();
            if (code < 200 || code >= 300) {
                send(out, code >= 400 ? code : 502, "text/plain", bytes("PROXY_ERROR " + code), null);
                return;
            }
            if (type == null) type = "text/html; charset=utf-8";
            if (body.length < 8 * 1024 * 1024) apiCachePut(key, body, type);
            send(out, 200, type, body, "Cache-Control: private, max-age=120\r\nX-SuperBox-Cache: MISS\r\n");
        } catch (Exception e) {
            Log.w(TAG, "page " + url + ": " + e.getMessage());
            send(out, 502, "text/plain", bytes("PROXY_ERROR " + e.getMessage()), null);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /* TMDB key-injecting proxy: /tmdb/3/<path>?<query>. */
    private void handleTmdb(OutputStream out, String path, String query) throws IOException {
        String rest = path.substring("/tmdb/3/".length());
        StringBuilder u = new StringBuilder("https://api.themoviedb.org/3/").append(rest);
        u.append('?');
        if (query != null && !query.isEmpty()) u.append(query).append('&');
        u.append("api_key=").append(TMDB_KEY).append("&language=en-US");
        String key = "tmdb:" + rest + "|" + (query == null ? "" : query);
        CacheEntry hit = apiCacheGet(key, TMDB_CACHE_MS);
        if (hit == null) {
            byte[] disk = diskGet(key, TMDB_CACHE_MS);
            if (disk != null) hit = new CacheEntry(disk, "application/json; charset=utf-8");
        }
        if (hit != null) {
            send(out, 200, "application/json; charset=utf-8", hit.body,
                    "Cache-Control: private, max-age=3600\r\nX-SuperBox-Cache: HIT\r\n");
            return;
        }
        HttpURLConnection c = null;
        try {
            c = openWeb(u.toString(), "https://www.themoviedb.org/");
            int code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            byte[] body = is == null ? new byte[0] : readAll(is, 12 * 1024 * 1024);
            if (code < 200 || code >= 300) {
                send(out, 502, "application/json", bytes("{\"error\":\"tmdb " + code + "\"}"), null);
                return;
            }
            apiCachePut(key, body, "application/json; charset=utf-8");
            send(out, 200, "application/json; charset=utf-8", body,
                    "Cache-Control: private, max-age=3600\r\nX-SuperBox-Cache: MISS\r\n");
        } catch (Exception e) {
            send(out, 502, "application/json", bytes("{\"error\":\"tmdb unavailable\"}"), null);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /* Generic one-hop (plus one iframe) stream sniffer used by the custom
       library player. It only ever returns a real media URL or an embed page;
       the caller falls back to the in-app web player when nothing is found. */
    private void handleExtract(OutputStream out, String url, String title) throws IOException {
        JSONObject res = new JSONObject();
        try {
            res.put("ok", false);
            if (url == null || url.isEmpty() || !isSafeUrl(url)) {
                sendJson(out, 200, res.toString());
                return;
            }
            JSONObject hit = sniff(url, null, 0);
            if (hit != null) {
                sendJson(out, 200, hit.toString());
                return;
            }
            sendJson(out, 200, res.toString());
        } catch (Exception e) {
            sendJson(out, 200, "{\"ok\":false}");
        }
    }

    private JSONObject sniff(String url, String ref, int depth) {
        if (depth > 2 || !isSafeUrl(url)) return null;
        String html;
        String type;
        HttpURLConnection c = null;
        try {
            c = openWeb(url, ref);
            int code = c.getResponseCode();
            if (code < 200 || code >= 400) return null;
            InputStream is = c.getInputStream();
            byte[] body = readAll(is, 10 * 1024 * 1024);
            type = c.getContentType();
            html = new String(body, "UTF-8");
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
        if (html == null || html.isEmpty()) return null;
        if (type != null && type.contains("json")) {
            String low = html.trim();
            if (low.startsWith("{")) {
                // JSON manifests sometimes carry a single obvious media URL.
                String m = firstMedia(html);
                if (m != null) return mediaJson(m, url);
            }
            return null;
        }
        String norm = html.replace("\\/", "/").replace("\\u0026", "&").replace("&amp;", "&");
        String media = firstMedia(norm);
        if (media != null) return mediaJson(media, url);
        // Follow the first player iframe once or twice.
        java.util.regex.Matcher im = Pattern.compile(
                "<iframe[^>]+src=[\"']([^\"']+)[\"']", Pattern.CASE_INSENSITIVE).matcher(norm);
        if (im.find()) {
            String src = im.group(1);
            try { src = new URL(new URL(url), src).toString(); } catch (Exception ignored) {}
            if (HTTP_RE.matcher(src).find()) {
                JSONObject sub = sniff(src, url, depth + 1);
                if (sub != null) return sub;
                JSONObject emb = new JSONObject();
                try {
                    emb.put("ok", true);
                    emb.put("type", "embed");
                    emb.put("embed", src);
                    emb.put("ref", url);
                } catch (Exception ignored) {}
                return emb;
            }
        }
        return null;
    }

    private static String firstMedia(String s) {
        Pattern p = Pattern.compile(
                "https?://[^\\s\"'<>\\\\]+?\\.(?:mp4|webm|m3u8)(?:\\?[^\\s\"'<>\\\\]*)?",
                Pattern.CASE_INSENSITIVE);
        java.util.regex.Matcher m = p.matcher(s);
        String best = null;
        int bestScore = -1;
        while (m.find()) {
            String u = m.group();
            if (u.contains("pixel") || u.contains("blank") || u.contains("spacer")) continue;
            int score = 0;
            if (u.contains(".m3u8")) score += 3;
            if (u.contains("master")) score += 2;
            if (u.contains("1080")) score += 2;
            if (u.contains("720")) score += 1;
            if (u.length() > 30) score += 1;
            if (score > bestScore) { bestScore = score; best = u; }
        }
        return best;
    }

    private static JSONObject mediaJson(String media, String page) {
        JSONObject r = new JSONObject();
        try {
            boolean hls = media.toLowerCase(Locale.US).contains(".m3u8");
            r.put("ok", true);
            r.put("type", hls ? "hls" : "direct");
            r.put("file", media);
            r.put("play", media);
            r.put("ref", page);
        } catch (Exception ignored) {}
        return r;
    }

    private static final Pattern HTTP_RE = Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE);

    private HttpURLConnection openWeb(String url, String ref) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection(proxy());
        c.setConnectTimeout(12000);
        c.setReadTimeout(25000);
        c.setInstanceFollowRedirects(true);
        c.setUseCaches(false);
        /* MangaDex's API rejects a browser UA with a bot-challenge redirect.
           The mobile reader sends an honest client id there so chapters and
           covers resolve; every other host keeps the browser UA. */
        boolean mangadexApi = "api.mangadex.org".equals(hostOf(url));
        c.setRequestProperty("User-Agent", mangadexApi
                ? "SuperBox/1.3 (+https://github.com/mohdziauddin2006-cloud/superbox)" : UA);
        c.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8");
        c.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
        c.setRequestProperty("Accept-Encoding", "identity");
        c.setRequestProperty("Connection", "close");
        if (ref != null && !ref.isEmpty()) c.setRequestProperty("Referer", ref);
        return c;
    }



    private void handleStream(OutputStream out, Map<String, String> headers,
                              String url, String ref) throws IOException {
        url = normalizeUrl(url);
        if (url == null || url.isEmpty() || !isSafeUrl(url)) {
            send(out, 400, "text/plain", bytes("missing url"), null);
            return;
        }
        long streamStarted = System.currentTimeMillis();
        String referer = ref == null || ref.isEmpty() ? null : ref;
        Meta meta = getMeta(url, referer);
        if (meta.total <= 0) {
            passthrough(out, url, referer, headers.get("range"));
            return;
        }

        long total = meta.total;
        long start = 0;
        long end = total - 1;
        String range = headers.get("range");
        boolean ranged = false;
        if (range != null && range.toLowerCase(Locale.US).startsWith("bytes=")) {
            String spec = range.substring(6).split(",")[0].trim();
            int dash = spec.indexOf('-');
            if (dash >= 0) {
                try {
                    String a = spec.substring(0, dash).trim();
                    String b = spec.substring(dash + 1).trim();
                    if (a.isEmpty()) {
                        long suffix = Long.parseLong(b);
                        start = Math.max(0, total - suffix);
                        end = total - 1;
                    } else {
                        start = Long.parseLong(a);
                        if (!b.isEmpty()) end = Long.parseLong(b);
                    }
                    ranged = true;
                } catch (NumberFormatException ignored) {
                }
            }
        }
        if (!ranged) {
            passthrough(out, url, referer, range);
            return;
        }
        if (start < 0) start = 0;
        if (start >= total) {
            send(out, 416, "text/plain", bytes("range out of bounds"),
                    "Content-Range: bytes */" + total + "\r\n");
            return;
        }
        if (end >= total) end = total - 1;
        if (end < start) end = start;
        /* Startup latency is dominated by the first window: the CDN serves
           roughly 1 MB/s, so a 12 MB first read keeps the spinner up for ~12s
           before the decoder can even open the moov atom. Small first window,
           larger follow-up windows (Chromium requests the next range as soon
           as it needs it). */
        long window = start == 0 ? 2L * 1024L * 1024L : WINDOW;
        if (end - start + 1 > window) {
            end = Math.min(total - 1, start + window - 1);
        }
        long len = end - start + 1;
        Log.i(TAG, "stream " + start + "-" + end + "/" + total + " (" + (len / 1024) + "KB) after "
                + (System.currentTimeMillis() - streamStarted) + "ms meta");

        String contentType = meta.type == null ? "video/mp4" : meta.type;
        StringBuilder h = new StringBuilder();
        h.append("Content-Range: bytes ").append(start).append('-').append(end)
                .append('/').append(total).append("\r\n");
        h.append("Accept-Ranges: bytes\r\n");
        h.append("Cache-Control: no-store\r\n");
        writeHeaders(out, 206, contentType, len, h.toString());

        ExecutorService pool = Executors.newFixedThreadPool(Math.min(PARALLEL,
                (int) Math.max(1, (len + CHUNK - 1) / CHUNK)));
        List<Future<byte[]>> futures = new ArrayList<>();
        try {
            for (long s = start; s <= end; s += CHUNK) {
                final long a = s;
                final long b = Math.min(end, s + CHUNK - 1);
                final String u = url;
                final String r = referer;
                futures.add(pool.submit(new Callable<byte[]>() {
                    @Override public byte[] call() throws Exception {
                        String ck = u + "|" + a + "-" + b;
                        byte[] cached = chunkGet(ck);
                        if (cached != null) return cached;
                        byte[] data = fetchRange(u, r, a, b);
                        if (data != null) chunkPut(ck, data);
                        return data;
                    }
                }));
            }
            for (Future<byte[]> f : futures) {
                byte[] data = f.get(90, TimeUnit.SECONDS);
                if (data == null || data.length == 0) throw new IOException("empty media chunk");
                out.write(data);
                out.flush();
            }
        } catch (Exception e) {
            Log.w(TAG, "stream aborted: " + e.getMessage());
        } finally {
            pool.shutdownNow();
            try { out.flush(); } catch (IOException ignored) {}
            Log.i(TAG, "stream window sent " + len + " bytes in "
                    + (System.currentTimeMillis() - streamStarted) + "ms");
        }
    }

    private void passthrough(OutputStream out, String url, String ref, String range) throws IOException {
        HttpURLConnection c = null;
        try {
            c = open(url, ref, range, 10000, 45000);
            int code = c.getResponseCode();
            if (code < 200 || code >= 400) {
                send(out, 502, "text/plain", bytes("stream unavailable"), null);
                return;
            }
            long len = parseLong(c.getHeaderField("Content-Length"), -1);
            String type = c.getContentType();
            if (type == null) type = "video/mp4";
            StringBuilder h = new StringBuilder();
            String cr = c.getHeaderField("Content-Range");
            if (cr != null) h.append("Content-Range: ").append(cr).append("\r\n");
            h.append("Accept-Ranges: bytes\r\nCache-Control: no-store\r\n");
            writeHeaders(out, code, type, len, h.toString());
            InputStream is = c.getInputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private byte[] fetchRange(String url, String ref, long start, long end) throws IOException {
        int len = (int) (end - start + 1);
        for (int attempt = 0; attempt < 2; attempt++) {
            HttpURLConnection c = null;
            try {
                c = open(url, ref, "bytes=" + start + "-" + end, 10000, 45000);
                int code = c.getResponseCode();
                // A 200 here means the CDN ignored the Range header. Skipping
                // the prefix would re-download the whole file for every chunk,
                // so reject it and retry instead.
                if (code != 206) {
                    throw new IOException("upstream range HTTP " + code);
                }
                InputStream is = c.getInputStream();
                byte[] data = new byte[len];
                int off = 0;
                while (off < len) {
                    int n = is.read(data, off, len - off);
                    if (n < 0) break;
                    off += n;
                }
                if (off == len) return data;
                throw new IOException("short range read " + off + "/" + len);
            } catch (IOException e) {
                if (attempt == 1) throw e;
            } finally {
                if (c != null) c.disconnect();
            }
        }
        throw new IOException("range failed");
    }

    private Meta getMeta(String url, String ref) {
        synchronized (metaCache) {
            Meta m = metaCache.get(url);
            if (m != null && System.currentTimeMillis() - m.at < 10 * 60 * 1000L) return m;
        }
        long total = -1;
        String type = "video/mp4";
        boolean ranges = false;
        // A HEAD is often blocked by the media CDN and costs a full timeout
        // before the real range probe. Learn the size from a 1-byte range.
        HttpURLConnection c = null;
        try {
            c = open(url, ref, "bytes=0-1", 9000, 12000);
            int code = c.getResponseCode();
            if (code == 206 || code == 200) {
                String cr = c.getHeaderField("Content-Range");
                if (cr != null) {
                    int slash = cr.lastIndexOf('/');
                    if (slash >= 0) total = parseLong(cr.substring(slash + 1), -1);
                }
                if (total <= 0 && code == 200) {
                    total = parseLong(c.getHeaderField("Content-Length"), -1);
                }
                String t = c.getContentType();
                if (t != null) type = t;
                ranges = code == 206 || "bytes".equalsIgnoreCase(c.getHeaderField("Accept-Ranges"));
                try { c.getInputStream().read(); } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.disconnect();
        }
        Meta m = new Meta(total, type, ranges);
        synchronized (metaCache) {
            metaCache.put(url, m);
            while (metaCache.size() > META_CACHE_MAX) {
                java.util.Iterator<String> it = metaCache.keySet().iterator();
                if (!it.hasNext()) break;
                it.next();
                it.remove();
            }
        }
        return m;
    }

    // ----------------------------------------------------------------- HLS

    private void handleHls(OutputStream out, String url, String ref) throws IOException {
        url = normalizeUrl(url);
        if (url == null || url.isEmpty() || !isSafeUrl(url)) {
            send(out, 400, "text/plain", bytes("missing playlist"), null);
            return;
        }
        String referer = ref == null || ref.isEmpty() ? null : ref;
        String key = "hls:" + url + "|" + referer;
        CacheEntry hit = apiCacheGet(key, HLS_CACHE_MS);
        if (hit == null) {
            byte[] disk = diskGet(key, HLS_CACHE_MS);
            if (disk != null) hit = new CacheEntry(disk, "application/vnd.apple.mpegurl; charset=utf-8");
        }
        if (hit != null) {
            send(out, 200, hit.type, hit.body, "Cache-Control: private, max-age=10\r\nX-SuperBox-Cache: HIT\r\n");
            return;
        }
        byte[] body = httpGetBytes(url, referer, 18000);
        if (body == null) {
            send(out, 502, "text/plain", bytes("playlist unavailable"), null);
            return;
        }
        String text = new String(body, "UTF-8");
        if (!text.startsWith("#EXTM3U")) {
            send(out, 200, "application/octet-stream", body, "Cache-Control: no-store\r\n");
            return;
        }
        boolean master = text.contains("#EXT-X-STREAM-INF");
        StringBuilder sb = new StringBuilder();
        String[] lines = text.split("\\r?\\n", -1);
        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) {
                sb.append(line).append('\n');
                continue;
            }
            if (trimmed.startsWith("#")) {
                if (trimmed.contains("URI=\"")) {
                    sb.append(rewriteUriAttributes(line, url, referer)).append('\n');
                } else {
                    sb.append(line).append('\n');
                }
            } else {
                String abs = resolve(url, trimmed);
                String proxied = localHls(master ? "/hls" : "/hlsseg", abs, referer);
                sb.append(proxied).append('\n');
            }
        }
        byte[] rewritten = sb.toString().getBytes("UTF-8");
        apiCachePut(key, rewritten, "application/vnd.apple.mpegurl; charset=utf-8");
        send(out, 200, "application/vnd.apple.mpegurl; charset=utf-8", rewritten,
                "Cache-Control: private, max-age=10\r\nX-SuperBox-Cache: MISS\r\n");
    }

    private void handleSegment(OutputStream out, Map<String, String> headers,
                               String url, String ref, String defaultType) throws IOException {
        url = normalizeUrl(url);
        if (url == null || url.isEmpty() || !isSafeUrl(url)) {
            send(out, 400, "text/plain", bytes("missing segment"), null);
            return;
        }
        String referer = ref == null || ref.isEmpty() ? null : ref;
        HttpURLConnection c = null;
        try {
            c = open(url, referer, headers.get("range"), 9000, 45000);
            int code = c.getResponseCode();
            if (code < 200 || code >= 400) {
                send(out, 502, "text/plain", bytes("segment unavailable"), null);
                return;
            }
            long len = parseLong(c.getHeaderField("Content-Length"), -1);
            String type = c.getContentType();
            if (type == null || type.contains("octet-stream")) type = defaultType == null ? "application/octet-stream" : defaultType;
            StringBuilder h = new StringBuilder();
            String cr = c.getHeaderField("Content-Range");
            if (cr != null) h.append("Content-Range: ").append(cr).append("\r\n");
            h.append("Accept-Ranges: bytes\r\nCache-Control: private, max-age=60\r\n");
            writeHeaders(out, code, type, len, h.toString());
            InputStream is = c.getInputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private String rewriteUriAttributes(String line, String base, String ref) {
        Pattern p = Pattern.compile("URI=\"([^\"]+)\"");
        Matcher m = p.matcher(line);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            String abs = resolve(base, m.group(1));
            String replacement = "URI=\"" + localHls("/hlsseg", abs, ref) + "\"";
            m.appendReplacement(sb, Matcher.quoteReplacement(replacement));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    private String localHls(String path, String url, String ref) {
        return path + "?url=" + enc(url) + "&ref=" + enc(ref) + "&t=" + enc(token);
    }

    // ----------------------------------------------------------------- DASH

    private void handleDash(OutputStream out, String url, String ref) throws IOException {
        url = normalizeUrl(url);
        if (url == null || url.isEmpty() || !isSafeUrl(url)) {
            send(out, 400, "text/plain", bytes("missing manifest"), null);
            return;
        }
        String referer = ref == null || ref.isEmpty() ? null : ref;
        String key = "dash:" + url + "|" + referer;
        CacheEntry hit = apiCacheGet(key, HLS_CACHE_MS);
        if (hit == null) {
            byte[] disk = diskGet(key, HLS_CACHE_MS);
            if (disk != null) hit = new CacheEntry(disk, "application/dash+xml; charset=utf-8");
        }
        if (hit != null) {
            send(out, 200, hit.type, hit.body, "Cache-Control: private, max-age=10\r\nX-SuperBox-Cache: HIT\r\n");
            return;
        }
        byte[] body = httpGetBytes(url, referer, 18000);
        if (body == null) {
            send(out, 502, "text/plain", bytes("manifest unavailable"), null);
            return;
        }
        String xml = new String(body, "UTF-8");
        if (xml.indexOf("<MPD") < 0) {
            send(out, 200, "application/octet-stream", body, "Cache-Control: no-store\r\n");
            return;
        }
        String rewritten = rewriteDash(xml, url);
        byte[] outBody = rewritten.getBytes("UTF-8");
        apiCachePut(key, outBody, "application/dash+xml; charset=utf-8");
        send(out, 200, "application/dash+xml; charset=utf-8", outBody,
                "Cache-Control: private, max-age=10\r\nX-SuperBox-Cache: MISS\r\n");
    }

    /* dash.js resolves relative segment URLs against the manifest URL, which
       is loopback here. Rewrite every media-bearing attribute to an absolute
       local proxy URL, preserving $Number$/$Time$/$RepresentationID$ tokens
       so dash.js can still expand them. */
    private String rewriteDash(String xml, String base) {
        xml = xml.replaceAll("(?is)<BaseURL>\\s*</BaseURL>", "");
        String attrBase = base;
        Pattern baseTag = Pattern.compile("(?is)<BaseURL>([^<]+)</BaseURL>");
        Matcher bm = baseTag.matcher(xml);
        StringBuffer bsb = new StringBuffer();
        while (bm.find()) {
            String value = bm.group(1).trim();
            if (value.isEmpty()) {
                bm.appendReplacement(bsb, "");
                continue;
            }
            String abs = resolve(base, value);
            boolean file = abs.matches("(?i).+\\.(mp4|m4s|m4v|m4a|webm|ts)(\\?.*)?$");
            if (file) {
                bm.appendReplacement(bsb, Matcher.quoteReplacement(
                        "<BaseURL>" + xmlEscape(localDashSeg(abs)) + "</BaseURL>"));
            } else {
                attrBase = abs;
                bm.appendReplacement(bsb, "");
            }
        }
        bm.appendTail(bsb);
        xml = bsb.toString();

        Pattern attr = Pattern.compile("(?i)(media|initialization|sourceURL|index)\\s*=\\s*([\"'])([^\"']+)\\2");
        Matcher m = attr.matcher(xml);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            String name = m.group(1);
            String quote = m.group(2);
            String value = xmlUnescape(m.group(3));
            String abs = resolve(attrBase, value);
            String replacement = name + "=" + quote + xmlEscape(localDashSeg(abs)) + quote;
            m.appendReplacement(sb, Matcher.quoteReplacement(replacement));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    private String localDashSeg(String url) {
        // encodeURIComponent leaves $ alone, so $Number$ survives for dash.js.
        String encoded = enc(url).replace("%24", "$");
        return "/dashseg?url=" + encoded + "&t=" + enc(token);
    }

    private static String xmlEscape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    private static String xmlUnescape(String s) {
        return s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"");
    }

    private static String resolve(String base, String value) {
        try {
            return new URL(new URL(base), value).toString();
        } catch (Exception e) {
            return value;
        }
    }

    // --------------------------------------------------------------- assets

    private void serveAsset(OutputStream out, String path) throws IOException {
        String file = "/".equals(path) ? "index.html" : path.replaceFirst("^/+", "");
        if (file.contains("..")) {
            send(out, 403, "text/plain", bytes("forbidden"), null);
            return;
        }
        String type = mime(file);
        try {
            AssetManager am = context.getAssets();
            byte[] body;
            if (file.endsWith(".js")) {
                synchronized (assetCache) {
                    body = assetCache.get(file);
                }
                if (body == null) {
                    try {
                        byte[] enc = readAll(am.open(file + ".enc"), 32 * 1024 * 1024);
                        body = decryptAsset(enc);
                    } catch (IOException missingEnc) {
                        body = readAll(am.open(file), 32 * 1024 * 1024);
                    }
                    synchronized (assetCache) {
                        if (assetCache.size() > 40) assetCache.clear();
                        assetCache.put(file, body);
                    }
                }
            } else {
                body = readAll(am.open(file), 24 * 1024 * 1024);
                if ("index.html".equals(file)) {
                    String html = new String(body, "UTF-8").replace("__SB_TOKEN_VALUE__", token);
                    body = html.getBytes("UTF-8");
                }
            }
            String cache = (file.endsWith(".html") || file.endsWith(".js") || file.endsWith(".css"))
                    ? "no-cache" : "public, max-age=86400";
            StringBuilder h = new StringBuilder();
            h.append("Cache-Control: ").append(cache).append("\r\n");
            h.append("X-Content-Type-Options: nosniff\r\n");
            h.append("Referrer-Policy: no-referrer\r\n");
            if ("index.html".equals(file)) {
                h.append("Content-Security-Policy: default-src 'self' http://127.0.0.1:*; ")
                        .append("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; ")
                        .append("style-src 'self' 'unsafe-inline'; img-src * data: blob:; ")
                        .append("media-src * blob: data:; connect-src *; font-src * data:; ")
                        .append("worker-src blob: 'self'; frame-src *\r\n");
            }
            send(out, 200, type, body, h.toString());
        } catch (IOException e) {
            send(out, 404, "text/plain", bytes("not found"), null);
        }
    }

    private static byte[] decryptAsset(byte[] data) throws IOException {
        if (data == null || data.length < 29 || data[0] != 'S' || data[1] != 'B' || data[2] != 'X' || data[3] != '1') {
            return data;
        }
        try {
            byte[] key = hexBytes(BuildSecrets.AES_KEY_HEX);
            byte[] iv = new byte[12];
            System.arraycopy(data, 4, iv, 0, 12);
            int ctLen = data.length - 4 - 12 - 16;
            byte[] ct = new byte[ctLen];
            System.arraycopy(data, 16, ct, 0, ctLen);
            byte[] tag = new byte[16];
            System.arraycopy(data, data.length - 16, tag, 0, 16);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
            byte[] plain = new byte[ctLen + 16];
            System.arraycopy(ct, 0, plain, 0, ctLen);
            System.arraycopy(tag, 0, plain, ctLen, 16);
            return cipher.doFinal(plain);
        } catch (Exception e) {
            throw new IOException("asset decrypt failed", e);
        }
    }

    private static byte[] hexBytes(String hex) {
        if (hex == null || hex.length() < 2) return new byte[0];
        int n = hex.length() / 2;
        byte[] out = new byte[n];
        for (int i = 0; i < n; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    private static String mime(String file) {
        String f = file.toLowerCase(Locale.US);
        if (f.endsWith(".html")) return "text/html; charset=utf-8";
        if (f.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (f.endsWith(".css")) return "text/css; charset=utf-8";
        if (f.endsWith(".json")) return "application/json; charset=utf-8";
        if (f.endsWith(".png")) return "image/png";
        if (f.endsWith(".jpg") || f.endsWith(".jpeg")) return "image/jpeg";
        if (f.endsWith(".webp")) return "image/webp";
        if (f.endsWith(".svg")) return "image/svg+xml";
        if (f.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    // -------------------------------------------------------------- network

    private HttpURLConnection open(String url, String ref, String range,
                                   int connectMs, int readMs) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection(proxy());
        c.setConnectTimeout(connectMs);
        c.setReadTimeout(readMs);
        c.setInstanceFollowRedirects(true);
        c.setUseCaches(false);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Accept", "*/*");
        c.setRequestProperty("Accept-Encoding", "identity");
        c.setRequestProperty("Connection", "close");
        if (ref != null && !ref.isEmpty()) c.setRequestProperty("Referer", ref);
        if (range != null) c.setRequestProperty("Range", range);
        return c;
    }

    private static String mbToken() {
        long ts = System.currentTimeMillis() / 1000L;
        String sec = String.valueOf(ts);
        String rev = new StringBuilder(sec).reverse().toString();
        String md5;
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] d = md.digest(rev.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) sb.append(String.format("%02x", b & 0xff));
            md5 = sb.toString();
        } catch (Exception e) {
            md5 = "";
        }
        return sec + "," + md5;
    }

    /** Every upstream connection rides the embedded tunnel, never the raw NIC. */
    private static Proxy proxy() {
        return new Proxy(Proxy.Type.HTTP,
                new InetSocketAddress(VpnManager.HOST, VpnManager.PORT));
    }

    // ---------------------------------------------------------- http helpers

    private static void writeHeaders(OutputStream out, int code, String type,
                                     long length, String extra) throws IOException {
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(code).append(' ').append(status(code)).append("\r\n");
        h.append("Content-Type: ").append(type == null ? "application/octet-stream" : type).append("\r\n");
        if (length >= 0) h.append("Content-Length: ").append(length).append("\r\n");
        h.append("Access-Control-Allow-Origin: *\r\n");
        h.append("Access-Control-Allow-Headers: *\r\n");
        h.append("Connection: close\r\n");
        if (extra != null) h.append(extra);
        h.append("\r\n");
        out.write(h.toString().getBytes("UTF-8"));
    }

    private static void send(OutputStream out, int code, String type,
                             byte[] body, String extra) throws IOException {
        byte[] b = body == null ? new byte[0] : body;
        writeHeaders(out, code, type, b.length, extra);
        out.write(b);
        out.flush();
    }

    private static void sendJson(OutputStream out, int code, String json) throws IOException {
        send(out, code, "application/json; charset=utf-8", bytes(json),
                "Cache-Control: no-store\r\n");
    }

    private static String status(int code) {
        if (code == 200) return "OK";
        if (code == 204) return "No Content";
        if (code == 206) return "Partial Content";
        if (code == 400) return "Bad Request";
        if (code == 403) return "Forbidden";
        if (code == 404) return "Not Found";
        if (code == 416) return "Range Not Satisfiable";
        if (code == 502) return "Bad Gateway";
        return "OK";
    }

    private static byte[] bytes(String s) {
        try { return s.getBytes("UTF-8"); } catch (Exception e) { return new byte[0]; }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(128);
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 8192) break;
        }
        if (c < 0 && b.size() == 0) return null;
        return b.toString("UTF-8");
    }

    private static byte[] readAll(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(16384);
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (out.size() + n > max) throw new IOException("response too large");
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    private static void skipFully(InputStream in, long n) throws IOException {
        byte[] buf = new byte[32768];
        long left = n;
        while (left > 0) {
            int r = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (r < 0) throw new IOException("unexpected end of stream");
            left -= r;
        }
    }

    private static long parseLong(String s, long fallback) {
        if (s == null) return fallback;
        try { return Long.parseLong(s.trim()); } catch (Exception e) { return fallback; }
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode(s == null ? "" : s, "UTF-8").replace("+", "%20");
        } catch (Exception e) {
            return "";
        }
    }

    private static Map<String, String> parseQuery(String q) {
        Map<String, String> out = new HashMap<>();
        if (q == null || q.isEmpty()) return out;
        for (String part : q.split("&")) {
            int eq = part.indexOf('=');
            String k = eq >= 0 ? part.substring(0, eq) : part;
            String v = eq >= 0 ? part.substring(eq + 1) : "";
            try {
                out.put(URLDecoder.decode(k, "UTF-8"),
                        URLDecoder.decode(v.replace("+", "%2B"), "UTF-8"));
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    // ---------------------------------------------------------------- caches

    private static boolean needsToken(String path) {
        return path.startsWith("/api/")
                || "/page".equals(path) || "/extract".equals(path)
                || path.startsWith("/tmdb/3/")
                || "/img".equals(path) || "/stream".equals(path) || "/raw".equals(path)
                || "/hls".equals(path) || "/hlsseg".equals(path)
                || "/dash".equals(path) || "/dashseg".equals(path);
    }

    private static String stripToken(String query) {
        if (query == null) return "";
        return query.replaceAll("(^|&)t=[^&]*", "").replaceAll("^&", "");
    }

    private static boolean isSafeUrl(String url) {
        try {
            URL u = new URL(url);
            String proto = u.getProtocol();
            if (!"http".equalsIgnoreCase(proto) && !"https".equalsIgnoreCase(proto)) return false;
            String host = u.getHost();
            if (host == null || host.isEmpty()) return false;
            String h = host.toLowerCase(Locale.US);
            if (h.equals("localhost") || h.endsWith(".local") || h.equals("0.0.0.0")) return false;
            if (h.startsWith("127.") || h.startsWith("10.") || h.startsWith("192.168.")
                    || h.startsWith("169.254.") || h.startsWith("0.")) return false;
            if (h.matches("172\\.(1[6-9]|2[0-9]|3[01])\\..*")) return false;
            if (h.equals("[::1]") || h.equals("::1")) return false;
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private synchronized CacheEntry apiCacheGet(String key, long ttl) {
        CacheEntry e = apiCache.get(key);
        if (e == null) return null;
        if (System.currentTimeMillis() - e.at > ttl) {
            apiCache.remove(key);
            apiCacheBytes -= e.body.length;
            if (apiCacheBytes < 0) apiCacheBytes = 0;
            return null;
        }
        return e;
    }

    private synchronized void apiCachePut(String key, byte[] body) {
        apiCachePut(key, body, "application/json; charset=utf-8");
    }

    private synchronized void apiCachePut(String key, byte[] body, String type) {
        if (body == null || body.length == 0) return;
        CacheEntry old = apiCache.put(key, new CacheEntry(body, type));
        if (old != null) apiCacheBytes -= old.body.length;
        apiCacheBytes += body.length;
        /* LRU + hard byte ceiling: page/image/HLS bodies evict the least
           recently used entries instead of clearing the whole cache. */
        java.util.Iterator<Map.Entry<String, CacheEntry>> it = apiCache.entrySet().iterator();
        while ((apiCache.size() > API_CACHE_MAX || apiCacheBytes > API_CACHE_BYTES) && it.hasNext()) {
            Map.Entry<String, CacheEntry> eldest = it.next();
            apiCacheBytes -= eldest.getValue().body.length;
            it.remove();
        }
        if (apiCacheBytes < 0) apiCacheBytes = 0;
        diskPut(key, body);
    }

    private static String sha256(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(s.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) sb.append(String.format("%02x", b & 0xff));
            return sb.toString();
        } catch (Exception e) {
            return String.valueOf(s.hashCode());
        }
    }

    private byte[] diskGet(String key, long ttl) {
        try {
            File f = new File(diskDir, sha256(key) + ".bin");
            if (!f.isFile()) return null;
            if (ttl > 0 && System.currentTimeMillis() - f.lastModified() > ttl) {
                f.delete();
                return null;
            }
            if (f.length() > 24L * 1024L * 1024L) return null;
            FileInputStream in = new FileInputStream(f);
            try {
                return readAll(in, 24 * 1024 * 1024);
            } finally {
                try { in.close(); } catch (IOException ignored) {}
            }
        } catch (Exception e) {
            return null;
        }
    }

    private void diskPut(String key, byte[] body) {
        if (body == null || body.length == 0) return;
        try {
            File f = new File(diskDir, sha256(key) + ".bin");
            File tmp = new File(diskDir, f.getName() + ".tmp");
            FileOutputStream out = new FileOutputStream(tmp);
            try {
                out.write(body);
                out.flush();
            } finally {
                try { out.close(); } catch (IOException ignored) {}
            }
            if (f.exists()) f.delete();
            if (!tmp.renameTo(f)) tmp.delete();
            if (++diskWrites % 40 == 0) trimDisk();
        } catch (Exception e) {
            Log.w(TAG, "disk cache: " + e.getMessage());
        }
    }

    private void trimDisk() {
        try {
            File[] files = diskDir.listFiles();
            if (files == null) return;
            long now = System.currentTimeMillis();
            long total = 0;
            for (File f : files) {
                if (!f.isFile()) continue;
                if (now - f.lastModified() > 10L * 24L * 60L * 60L * 1000L) {
                    f.delete();
                    continue;
                }
                total += f.length();
            }
            if (total > 384L * 1024L * 1024L) {
                java.util.Arrays.sort(files, new java.util.Comparator<File>() {
                    @Override public int compare(File a, File b) {
                        return Long.compare(a.lastModified(), b.lastModified());
                    }
                });
                for (File f : files) {
                    if (total <= 256L * 1024L * 1024L) break;
                    total -= f.length();
                    f.delete();
                }
            }
        } catch (Exception ignored) {}
    }

    private synchronized byte[] chunkGet(String key) {
        return chunkCache.get(key);
    }

    private synchronized void chunkPut(String key, byte[] data) {
        if (data == null || data.length > 1024 * 1024) return;
        if (chunkCache.containsKey(key)) return;
        chunkCache.put(key, data);
        chunkCacheBytes += data.length;
        while (chunkCacheBytes > CHUNK_CACHE_LIMIT && !chunkCache.isEmpty()) {
            String first = chunkCache.keySet().iterator().next();
            byte[] old = chunkCache.remove(first);
            if (old != null) chunkCacheBytes -= old.length;
        }
    }

    private static class Meta {
        final long total;
        final String type;
        final boolean ranges;
        final long at = System.currentTimeMillis();
        Meta(long total, String type, boolean ranges) {
            this.total = total;
            this.type = type;
            this.ranges = ranges;
        }
    }

    private static class CacheEntry {
        final byte[] body;
        final String type;
        final long at = System.currentTimeMillis();
        CacheEntry(byte[] body, String type) {
            this.body = body;
            this.type = type;
        }
    }
}
