package com.superbox.mobile;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.security.MessageDigest;
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
    private static final long WINDOW = 12L * 1024L * 1024L;
    private static final int CHUNK = 512 * 1024;
    // The CDN throttles each TCP connection to roughly 20-100 KB/s. More
    // sockets are the only way to fill a mobile pipe: measured 8 sockets
    // ~= 286 KB/s, 16 ~= 788 KB/s, 24 ~= 1.0 MB/s on the reference stream.
    private static final int PARALLEL = 24;
    private static final long CHUNK_CACHE_LIMIT = 56L * 1024L * 1024L;
    private static final long API_CACHE_MS = 5L * 60L * 1000L;

    private final Context context;
    private final ExecutorService clients = Executors.newCachedThreadPool();
    private final Map<String, Meta> metaCache = new HashMap<>();
    private final Map<String, CacheEntry> apiCache = new HashMap<>();
    private final LinkedHashMap<String, byte[]> chunkCache =
            new LinkedHashMap<>(64, 0.75f, true);
    private ServerSocket socket;
    private volatile boolean running;
    private long chunkCacheBytes;

    public LocalServer(Context context) {
        this.context = context.getApplicationContext();
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
        return ss.getLocalPort();
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

            if ("/health".equals(path)) {
                send(out, 200, "application/json", bytes("{\"ok\":true,\"server\":\"SuperBox\"}"),
                        "Cache-Control: no-store\r\n");
                return;
            }
            if ("/favicon.ico".equals(path)) {
                send(out, 204, "image/x-icon", new byte[0], null);
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
                handleTmdb(out, path, query);
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
                handleSegment(out, headers, qs.get("url"), qs.get("ref"));
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
        CacheEntry hit = apiCacheGet(cacheKey);
        if (hit != null) {
            send(out, 200, "application/json; charset=utf-8", hit.body,
                    "Cache-Control: no-store\r\nX-SuperBox-Cache: HIT\r\n");
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
                "Cache-Control: no-store\r\nX-SuperBox-Cache: MISS\r\n");
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
        if (url == null || url.isEmpty()) {
            send(out, 404, "text/plain", bytes("missing image"), null);
            return;
        }
        String key = "img:" + url;
        CacheEntry hit = apiCacheGet(key);
        if (hit != null) {
            send(out, 200, hit.type, hit.body, "Cache-Control: public, max-age=86400\r\n");
            return;
        }
        HttpURLConnection c = null;
        try {
            c = open(url, SITE + "/", null, 8000, 16000);
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) {
                send(out, 404, "text/plain", bytes("image unavailable"), null);
                return;
            }
            InputStream is = c.getInputStream();
            byte[] body = readAll(is, 8 * 1024 * 1024);
            String type = c.getContentType();
            if (type == null || !type.startsWith("image/")) type = "image/jpeg";
            if (body.length > 0 && body.length < 4 * 1024 * 1024) {
                apiCachePut(key, body, type);
            }
            send(out, 200, type, body, "Cache-Control: public, max-age=86400\r\n");
        } catch (IOException e) {
            send(out, 404, "text/plain", bytes("image unavailable"), null);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ------------------------------------------------------------- web proxy

    /* Generic read-only proxy for the Vault scrapers. Returns the
       upstream body with its content type so JSON APIs and HTML pages both
       arrive intact; the WebView cannot read most of these hosts directly
       because of CORS/Cloudflare. */
    private void handlePage(OutputStream out, String url, String ref) throws IOException {
        if (url == null || url.isEmpty() || !HTTP_RE.matcher(url).find()) {
            send(out, 400, "text/plain", bytes("missing url"), null);
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
            send(out, 200, type, body, "Cache-Control: no-store\r\n");
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
            send(out, 200, "application/json; charset=utf-8", body, "Cache-Control: no-store\r\n");
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
            if (url == null || url.isEmpty()) {
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
        if (depth > 2) return null;
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
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(12000);
        c.setReadTimeout(25000);
        c.setInstanceFollowRedirects(true);
        c.setUseCaches(false);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8");
        c.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
        c.setRequestProperty("Accept-Encoding", "identity");
        c.setRequestProperty("Connection", "close");
        if (ref != null && !ref.isEmpty()) c.setRequestProperty("Referer", ref);
        return c;
    }



    private void handleStream(OutputStream out, Map<String, String> headers,
                              String url, String ref) throws IOException {
        if (url == null || url.isEmpty()) {
            send(out, 400, "text/plain", bytes("missing url"), null);
            return;
        }
        long streamStarted = System.currentTimeMillis();
        String referer = ref == null || ref.isEmpty() ? SITE + "/" : ref;
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
        if (end - start + 1 > WINDOW) {
            end = Math.min(total - 1, start + WINDOW - 1);
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
            if (metaCache.size() > 80) metaCache.clear();
            metaCache.put(url, m);
        }
        return m;
    }

    // ----------------------------------------------------------------- HLS

    private void handleHls(OutputStream out, String url, String ref) throws IOException {
        if (url == null || url.isEmpty()) {
            send(out, 400, "text/plain", bytes("missing playlist"), null);
            return;
        }
        String referer = ref == null || ref.isEmpty() ? SITE + "/" : ref;
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
        send(out, 200, "application/vnd.apple.mpegurl; charset=utf-8",
                sb.toString().getBytes("UTF-8"), "Cache-Control: no-store\r\n");
    }

    private void handleSegment(OutputStream out, Map<String, String> headers,
                               String url, String ref) throws IOException {
        if (url == null || url.isEmpty()) {
            send(out, 400, "text/plain", bytes("missing segment"), null);
            return;
        }
        String referer = ref == null || ref.isEmpty() ? SITE + "/" : ref;
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
            if (type == null) type = "application/octet-stream";
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
        return path + "?url=" + enc(url) + "&ref=" + enc(ref);
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
            InputStream is = am.open(file);
            byte[] body = readAll(is, 20 * 1024 * 1024);
            String cache = (file.endsWith(".html") || file.endsWith(".js") || file.endsWith(".css"))
                    ? "no-cache" : "public, max-age=86400";
            send(out, 200, type, body, "Cache-Control: " + cache + "\r\n");
        } catch (IOException e) {
            send(out, 404, "text/plain", bytes("not found"), null);
        }
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
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(connectMs);
        c.setReadTimeout(readMs);
        c.setInstanceFollowRedirects(true);
        c.setUseCaches(false);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Accept", "*/*");
        c.setRequestProperty("Accept-Encoding", "identity");
        c.setRequestProperty("Connection", "close");
        c.setRequestProperty("Referer", ref == null || ref.isEmpty() ? SITE + "/" : ref);
        c.setRequestProperty("Origin", SITE);
        c.setRequestProperty("X-Client-Info", "{\"timezone\":\"Asia/Calcutta\"}");
        c.setRequestProperty("X-Request-Lang", "en");
        c.setRequestProperty("X-Client-Token", mbToken());
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

    private synchronized CacheEntry apiCacheGet(String key) {
        CacheEntry e = apiCache.get(key);
        if (e == null) return null;
        if (System.currentTimeMillis() - e.at > API_CACHE_MS) {
            apiCache.remove(key);
            return null;
        }
        return e;
    }

    private synchronized void apiCachePut(String key, byte[] body) {
        apiCachePut(key, body, "application/json; charset=utf-8");
    }

    private synchronized void apiCachePut(String key, byte[] body, String type) {
        if (apiCache.size() > 140) apiCache.clear();
        apiCache.put(key, new CacheEntry(body, type));
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
