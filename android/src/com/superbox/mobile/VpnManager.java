package com.superbox.mobile;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * SuperBox Shield - the embedded WARP tunnel.
 *
 * usque (open source, MASQUE/HTTP-3) runs as a hidden child process and exposes
 * an HTTP proxy on loopback. Every upstream request the bridge makes goes
 * through that proxy, so no catalogue, artwork or video traffic can leak
 * around the tunnel. The manager owns the process, the anonymous WARP
 * identity and the best-effort regional endpoint profiles.
 *
 * Design notes:
 *  - A pre-registered WARP identity ships as an asset so first launch does not
 *    depend on reaching the registration API through an unproxied network.
 *  - Cloudflare WARP endpoints are anycast. A "region" therefore selects an
 *    endpoint profile; the real egress country is read from the WARP trace
 *    endpoint and always reported truthfully.
 *  - The tunnel is fail-closed: LocalServer rejects every upstream route while
 *    {@link #isOn()} is false.
 */
public final class VpnManager {

    private static final String TAG = "SuperBoxShield";
    public static final String HOST = "127.0.0.1";
    public static final int PORT = 46950;
    private static final String TRACE = "https://www.cloudflare.com/cdn-cgi/trace";

    private static final Map<String, String[]> ENDPOINTS = new LinkedHashMap<>();
    private static final Map<String, String> LABELS = new LinkedHashMap<>();

    private static final String[] WARP_ENDPOINTS = {
        "162.159.198.2", "162.159.199.2",
        "162.159.192.2", "162.159.193.2", "162.159.195.2",
        "188.114.96.2", "188.114.97.2", "188.114.98.2", "188.114.99.2",
        "162.159.198.3", "162.159.199.3", "188.114.96.3"
    };

    private static String[] rotated(String[] list, int n) {
        int k = ((n % list.length) + list.length) % list.length;
        String[] out = new String[list.length];
        for (int i = 0; i < list.length; i++) out[i] = list[(k + i) % list.length];
        return out;
    }

    static {
        /* Full 12-endpoint pool per region. Anchors first for fast, reliable
           switches; the rest are failover. Cloudflare is anycast, so the
           measured egress is reported separately and truthfully. */
        ENDPOINTS.put("auto", rotated(WARP_ENDPOINTS, 0));
        ENDPOINTS.put("us", rotated(WARP_ENDPOINTS, 0));
        ENDPOINTS.put("ca", rotated(WARP_ENDPOINTS, 0));
        ENDPOINTS.put("uk", rotated(WARP_ENDPOINTS, 0));
        ENDPOINTS.put("au", rotated(WARP_ENDPOINTS, 0));
        ENDPOINTS.put("in", rotated(WARP_ENDPOINTS, 0));
        ENDPOINTS.put("de", rotated(WARP_ENDPOINTS, 0));
        ENDPOINTS.put("jp", rotated(WARP_ENDPOINTS, 0));
        ENDPOINTS.put("sg", rotated(WARP_ENDPOINTS, 0));
        ENDPOINTS.put("hk", rotated(WARP_ENDPOINTS, 0));
        ENDPOINTS.put("kr", rotated(WARP_ENDPOINTS, 0));
        ENDPOINTS.put("fr", rotated(WARP_ENDPOINTS, 0));
        ENDPOINTS.put("br", rotated(WARP_ENDPOINTS, 0));
        LABELS.put("auto", "Global");
        LABELS.put("us", "United States");
        LABELS.put("ca", "Canada");
        LABELS.put("uk", "United Kingdom");
        LABELS.put("au", "Australia");
        LABELS.put("in", "India");
        LABELS.put("de", "Germany");
        LABELS.put("jp", "Japan");
        LABELS.put("sg", "Singapore");
        LABELS.put("hk", "Hong Kong");
        LABELS.put("kr", "South Korea");
        LABELS.put("fr", "France");
        LABELS.put("br", "Brazil");
    }

    private final Context context;
    private final Object lock = new Object();
    private final ExecutorService worker = Executors.newSingleThreadExecutor(new java.util.concurrent.ThreadFactory() {
        @Override public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "superbox-shield");
            t.setDaemon(true);
            return t;
        }
    });

    private Process process;
    private Thread pump;
    private volatile String state = "idle";
    private volatile String region = "auto";
    private volatile String actual = "";
    private volatile String ip = "";
    private volatile boolean warp = false;
    private volatile String error = "";
    private volatile long startedAt = 0L;
    private volatile long lastProbe = 0L;

    public VpnManager(Context context) {
        this.context = context.getApplicationContext();
    }

    public boolean isOn() {
        return "on".equals(state) && warp;
    }

    public String getRegion() {
        return region;
    }

    // ------------------------------------------------------------ lifecycle

    /** Starts (or reuses) the tunnel without blocking the caller. */
    public JSONObject startAsync(String wanted) {
        final String r = normRegion(wanted);
        if (isOn() && (r.equals(region) || "auto".equals(r))) return status();
        synchronized (lock) {
            if (!"connecting".equals(state)) state = "connecting";
            error = "";
        }
        worker.execute(new Runnable() {
            @Override public void run() {
                synchronized (lock) {
                    try {
                        bringUp(r, 0);
                    } catch (Exception e) {
                        fail(e);
                    }
                }
            }
        });
        return status();
    }

    /** Reconnects from scratch, keeping the current region. */
    public JSONObject reconnect() {
        return reconnect(region);
    }

    /** Forces a fresh tunnel on the requested region, even when already on. */
    public JSONObject reconnect(String wanted) {
        final String r = normRegion(wanted);
        synchronized (lock) {
            state = "connecting";
            error = "";
            region = r;
        }
        worker.execute(new Runnable() {
            @Override public void run() {
                synchronized (lock) {
                    try {
                        bringUp(r, 0);
                    } catch (Exception e) {
                        fail(e);
                    }
                }
            }
        });
        return status();
    }

    public JSONObject switchRegion(String wanted) {
        final String r = normRegion(wanted);
        if (isOn() && r.equals(region)) return status();
        synchronized (lock) {
            state = "connecting";
            error = "";
            region = r;
        }
        worker.execute(new Runnable() {
            @Override public void run() {
                synchronized (lock) {
                    try {
                        bringUp(r, 0);
                    } catch (Exception e) {
                        fail(e);
                    }
                }
            }
        });
        return status();
    }

    public JSONObject ensure(String wanted) {
        String r = normRegion(wanted);
        if (isOn() && (r.equals(region) || "auto".equals(r))) return status();
        return switchRegion(r);
    }

    public void stop() {
        synchronized (lock) {
            state = "idle";
            warp = false;
            actual = "";
            ip = "";
            killProcess();
        }
        try { worker.shutdownNow(); } catch (Exception ignored) {}
    }

    /** Synchronous teardown used by the HTTP control plane. */
    public void stopSync() {
        synchronized (lock) {
            state = "idle";
            warp = false;
            actual = "";
            ip = "";
            killProcess();
        }
    }

    // ------------------------------------------------------------- internals

    private void bringUp(String wanted, int attempt) throws Exception {
        state = "connecting";
        error = "";
        region = wanted;
        ensureConfig();
        killProcess();
        /* The previous proxy can hold 127.0.0.1:46950 briefly; a new usque
           instance fails to bind if it starts in that window. */
        Thread.sleep(1200L);

        String[] list = ENDPOINTS.get(wanted);
        if (list == null) list = ENDPOINTS.get("auto");
        String bestActual = "";
        String bestIp = "";
        boolean matched = false;

        if ("auto".equals(wanted) || wanted.isEmpty()) {
            writeEndpoint(wanted, list[0]);
            spawn();
            waitReady(45000);
            return;
        }

        for (int idx = 0; idx < list.length && idx < 6; idx++) {
            String endpoint = list[idx];
            writeEndpoint(wanted, endpoint);
            spawn();
            try {
                waitReady(12000);
                bestActual = actual;
                bestIp = ip;
                /* Anycast: stop once the tunnel is up; the egress country is
                   measured and reported, not guaranteed by the address. */
                if ("on".equals(state)) { matched = wanted.equalsIgnoreCase(actual); break; }
            } catch (Exception e) {
                log("endpoint " + endpoint + " failed: " + e.getMessage());
            }
            killProcess();
            Thread.sleep(900L);
        }

        if (!"on".equals(state)) {
            /* Last resort: global profile. The requested region is still
               reported separately from the measured egress. */
            log("falling back to the global profile");
            writeEndpoint("auto", ENDPOINTS.get("auto")[0]);
            spawn();
            waitReady(45000);
        } else if (!matched && !bestActual.isEmpty()) {
            error = "Anycast endpoint; egress is " + bestActual;
            actual = bestActual;
            ip = bestIp;
        }
    }

    private void fail(Exception e) {
        Log.w(TAG, "tunnel failed: " + e.getMessage());
        state = "error";
        error = String.valueOf(e.getMessage());
        warp = false;
        killProcess();
    }

    private File configFile() {
        File dir = new File(context.getFilesDir(), "vpn");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, "config.json");
    }

    private String binary() {
        try {
            File lib = new File(context.getApplicationInfo().nativeLibraryDir, "libusque.so");
            if (lib.isFile()) return lib.getAbsolutePath();
        } catch (Exception ignored) {}
        File alt = new File(context.getFilesDir(), "vpn/usque");
        if (alt.isFile()) return alt.getAbsolutePath();
        return "";
    }

    private void ensureConfig() throws Exception {
        File cfg = configFile();
        if (validConfig(cfg)) return;
        try {
            InputStream in = context.getAssets().open("vpn-config.json");
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            in.close();
            JSONObject json = new JSONObject(new String(buf.toByteArray(), StandardCharsets.UTF_8));
            if (json.optString("private_key").isEmpty() || json.optString("id").isEmpty()) {
                throw new IOException("bundled Shield identity is invalid");
            }
            write(cfg, buf.toByteArray());
            log("bundled Shield identity installed");
            return;
        } catch (Exception e) {
            log("bundled config unavailable: " + e.getMessage());
        }
        /* Runtime registration is a fallback only. It needs plain DNS, which
           some Android builds do not expose to a Go binary. */
        String bin = binary();
        if (bin.isEmpty()) throw new IOException("Shield core missing (libusque.so)");
        Process p = new ProcessBuilder(bin, "-c", cfg.getAbsolutePath(),
                "register", "--accept-tos", "-n", "SuperBox")
                .redirectErrorStream(true)
                .start();
        drain(p, "register");
        if (!p.waitFor(90, java.util.concurrent.TimeUnit.SECONDS)) {
            p.destroyForcibly();
            throw new IOException("Shield registration timed out");
        }
        if (!validConfig(cfg)) throw new IOException("Shield registration failed");
    }

    private static boolean validConfig(File f) {
        try {
            if (!f.isFile() || f.length() < 100) return false;
            JSONObject j = new JSONObject(read(f));
            return !j.optString("private_key").isEmpty() && !j.optString("id").isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    private void writeEndpoint(String wanted, String ip) {
        try {
            File cfg = configFile();
            JSONObject j = new JSONObject(read(cfg));
            j.put("endpoint_v4", ip);
            j.put("endpoint_h2_v4", ip);
            write(cfg, j.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            log("endpoint write: " + e.getMessage());
        }
    }

    private void spawn() throws Exception {
        String bin = binary();
        if (bin.isEmpty()) throw new IOException("Shield core missing (libusque.so)");
        File cfg = configFile();
        if (!validConfig(cfg)) throw new IOException("Shield identity is missing");
        ProcessBuilder pb = new ProcessBuilder(bin,
                "-c", cfg.getAbsolutePath(),
                "http-proxy",
                "-b", HOST,
                "-p", String.valueOf(PORT),
                "--always-reconnect",
                "--reconnect-delay", "2s");
        pb.directory(context.getFilesDir());
        pb.redirectErrorStream(true);
        Map<String, String> env = pb.environment();
        env.put("HOME", context.getFilesDir().getAbsolutePath());
        env.put("TMPDIR", context.getCacheDir().getAbsolutePath());
        process = pb.start();
        pump = new Thread(new Runnable() {
            @Override public void run() { drain(process, "usque"); }
        }, "superbox-usque-log");
        pump.setDaemon(true);
        pump.start();
        state = "connecting";
        warp = false;
        actual = "";
        ip = "";
        startedAt = 0L;
        log("proxy started endpoint=" + endpointOf());
    }

    private String endpointOf() {
        try {
            return new JSONObject(read(configFile())).optString("endpoint_v4");
        } catch (Exception e) {
            return "?";
        }
    }

    private void drain(Process p, String tag) {
        try (InputStream in = p.getInputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) {
                String line = new String(buf, 0, n, StandardCharsets.UTF_8).trim();
                if (!line.isEmpty()) log(tag + ": " + line.substring(0, Math.min(220, line.length())));
            }
        } catch (Exception ignored) {}
    }

    private void killProcess() {
        Process p = process;
        process = null;
        if (p != null) {
            try { p.destroy(); } catch (Exception ignored) {}
            try {
                if (!p.waitFor(1400, java.util.concurrent.TimeUnit.MILLISECONDS)) p.destroyForcibly();
            } catch (Exception ignored) {
                try { p.destroyForcibly(); } catch (Exception ignored2) {}
            }
        }
    }

    /** Polls the trace endpoint through the proxy until WARP answers. */
    private void waitReady(long timeoutMs) throws Exception {
        long until = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < until) {
            if (process == null) throw new IOException(error.isEmpty() ? "Shield process exited" : error);
            try {
                if (probe()) {
                    state = "on";
                    startedAt = startedAt == 0L ? System.currentTimeMillis() : startedAt;
                    error = "";
                    log("ready egress=" + actual + " warp=" + warp);
                    return;
                }
            } catch (Exception e) {
                log("probe: " + e.getMessage());
            }
            Thread.sleep(1300L);
        }
        throw new IOException("Shield tunnel did not come up in time");
    }

    private boolean probe() throws Exception {
        Proxy proxy = new Proxy(Proxy.Type.HTTP, new InetSocketAddress(HOST, PORT));
        HttpURLConnection c = (HttpURLConnection) new URL(TRACE).openConnection(proxy);
        c.setConnectTimeout(7000);
        c.setReadTimeout(9000);
        c.setUseCaches(false);
        c.setRequestProperty("User-Agent", "SuperBox/1.3");
        c.setRequestProperty("Accept", "text/plain");
        c.setRequestProperty("Connection", "close");
        try {
            int code = c.getResponseCode();
            if (code != 200) return false;
            String text = readAll(c.getInputStream(), 16384);
            Map<String, String> map = new LinkedHashMap<>();
            for (String line : text.split("\n")) {
                int i = line.indexOf('=');
                if (i > 0) map.put(line.substring(0, i).trim(), line.substring(i + 1).trim());
            }
            warp = "on".equals(map.get("warp"));
            actual = String.valueOf(map.getOrDefault("loc", "")).toUpperCase(Locale.US);
            ip = String.valueOf(map.getOrDefault("ip", ""));
            lastProbe = System.currentTimeMillis();
            return warp;
        } finally {
            c.disconnect();
        }
    }

    public JSONObject status() {
        JSONObject j = new JSONObject();
        try {
            j.put("ok", isOn());
            j.put("engine", "usque/WARP MASQUE");
            j.put("state", state);
            j.put("region", region);
            j.put("regionLabel", LABELS.getOrDefault(region, region));
            j.put("egress", actual);
            j.put("ip", ip);
            j.put("warp", warp);
            j.put("port", PORT);
            j.put("uptime", startedAt > 0 ? Math.max(0, (System.currentTimeMillis() - startedAt) / 1000) : 0);
            j.put("error", error);
            j.put("checkedAt", lastProbe);
        } catch (Exception ignored) {}
        return j;
    }

    // --------------------------------------------------------------- helpers

    private void log(String line) {
        try { Log.i(TAG, line); } catch (Exception ignored) {}
    }

    private static String normRegion(String r) {
        String v = String.valueOf(r == null ? "auto" : r).toLowerCase(Locale.US);
        if ("gb".equals(v) || "eng".equals(v) || "uk".equals(v)) return "uk";
        if ("usa".equals(v)) return "us";
        if ("can".equals(v)) return "ca";
        if ("aus".equals(v)) return "au";
        if ("ind".equals(v)) return "in";
        if ("ger".equals(v)) return "de";
        if ("jpn".equals(v)) return "jp";
        if ("sgp".equals(v) || "singapore".equals(v)) return "sg";
        if ("hkg".equals(v) || "hongkong".equals(v)) return "hk";
        if ("kor".equals(v) || "korea".equals(v)) return "kr";
        if ("fra".equals(v)) return "fr";
        if ("bra".equals(v)) return "br";
        return ENDPOINTS.containsKey(v) ? v : "auto";
    }

    private static String read(File f) throws IOException {
        try (InputStream in = new java.io.FileInputStream(f)) {
            return readAll(in, 1024 * 1024);
        }
    }

    private static void write(File f, byte[] body) throws IOException {
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(body);
        }
    }

    private static String readAll(InputStream in, int max) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) > 0) {
            buf.write(chunk, 0, n);
            if (buf.size() > max) break;
        }
        return new String(buf.toByteArray(), StandardCharsets.UTF_8);
    }
}
