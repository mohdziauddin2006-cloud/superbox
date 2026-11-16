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
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * SuperBox Shield - the embedded WARP tunnel.
 *
 * usque (open source, MASQUE/HTTP-3) runs as a hidden child process and exposes
 * an HTTP CONNECT proxy on loopback. Every upstream request the bridge makes
 * goes through that proxy, so no catalogue, artwork or video traffic can leak
 * around the tunnel. The manager owns the process, the anonymous WARP
 * identity and the best-effort regional endpoint profiles.
 *
 * Design notes:
 *  - A pre-registered WARP identity ships as an asset so first launch does not
 *    depend on reaching the registration API through an unproxied network.
 *  - Cloudflare WARP endpoints are anycast. A "region" therefore selects an
 *    endpoint profile; the real egress country is read from the WARP trace
 *    endpoint and always reported truthfully.
 *  - The L4 CONNECT proxy opens one HTTP/3 stream per request. It stays
 *    responsive under the many parallel connections a WebView and a video
 *    player create, unlike a single serialised tunnel proxy.
 *  - Starting tries several endpoint profiles before reporting failure, and a
 *    watchdog repairs a tunnel that dies quietly.
 *  - The tunnel is fail-closed: LocalServer rejects every upstream route while
 *    {@link #isOn()} is false.
 */
public final class VpnManager {

    private static final String TAG = "SuperBoxShield";
    public static final String HOST = "127.0.0.1";
    public static final int PORT = 46950;
    private static final String TRACE = "https://www.cloudflare.com/cdn-cgi/trace";
    private static final int START_ATTEMPTS = 6;
    private static final long ATTEMPT_READY_MS = 13000L;
    /* MASQUE over IPv6 uses a different anycast path and is often much faster
       than the throttled IPv4 anchors. Tried first, with a short budget. */
    private static final String WARP_ENDPOINT_V6 = "2606:4700:103::2";
    private static final long V6_READY_MS = 10000L;

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
    /* These executors live for the whole process. They are deliberately never
       shut down on stop(): shutting them down made every later reconnect fail
       with RejectedExecutionException. */
    private final ExecutorService worker = Executors.newSingleThreadExecutor(new java.util.concurrent.ThreadFactory() {
        @Override public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "superbox-shield");
            t.setDaemon(true);
            return t;
        }
    });
    private final ScheduledExecutorService health = Executors.newSingleThreadScheduledExecutor(new java.util.concurrent.ThreadFactory() {
        @Override public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "superbox-shield-health");
            t.setDaemon(true);
            return t;
        }
    });

    private volatile Process process;
    private volatile Thread pump;
    private volatile String state = "idle";
    private volatile String region = "auto";
    private volatile String preferred = "auto";
    private volatile String actual = "";
    private volatile String ip = "";
    private volatile boolean warp = false;
    private volatile String error = "";
    private volatile String phase = "idle";
    private volatile int progress = 0;
    private volatile long startedAt = 0L;
    private volatile long lastProbe = 0L;
    private volatile boolean stopped = true;
    private volatile int watchFails = 0;
    /* 0 = undecided, 1 = resolve names inside the tunnel (1.1.1.1), 2 = use
       Android's system resolver. DNS decides reachability through WARP: the
       ISP resolver can return anycast addresses that WARP answers with
       504/CRYPTO errors, while 1.1.1.1 over the tunnel resolves to addresses
       WARP itself routes. Tunnel DNS is the default; system DNS is only the
       fallback for networks that block Cloudflare DNS inside the tunnel. */
    private volatile int dnsMode = 0;
    private volatile boolean ipv6 = false;
    private final AtomicBoolean watchBusy = new AtomicBoolean(false);

    public VpnManager(Context context) {
        this.context = context.getApplicationContext();
        health.scheduleWithFixedDelay(new Runnable() {
            @Override public void run() { watch(); }
        }, 20L, 20L, TimeUnit.SECONDS);
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
        synchronized (lock) {
            preferred = r;
            if (isOn()) return status();
            if ("connecting".equals(state) || "provisioning".equals(state)) return status();
            stopped = false;
            state = "connecting";
            phase = "Preparing the Shield";
            progress = 2;
            error = "";
        }
        submit(new Runnable() {
            @Override public void run() { bringUp(r, false); }
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
            stopped = false;
            state = "connecting";
            phase = "Restarting the Shield";
            progress = 2;
            error = "";
            region = r;
            preferred = r;
            warp = false;
        }
        submit(new Runnable() {
            @Override public void run() { bringUp(r, true); }
        });
        return status();
    }

    public JSONObject switchRegion(String wanted) {
        final String r = normRegion(wanted);
        if (isOn() && r.equals(region)) {
            preferred = r;
            return status();
        }
        return reconnect(r);
    }

    /**
     * Non-disruptive ensure: a source asking for a region records a
     * preference. A healthy tunnel is reused instead of being torn down.
     */
    public JSONObject ensure(String wanted) {
        String r = normRegion(wanted);
        preferred = r;
        if (isOn()) return status();
        return startAsync(r);
    }

    public void stop() {
        synchronized (lock) {
            stopped = true;
            state = "idle";
            warp = false;
            actual = "";
            ip = "";
            error = "";
            phase = "idle";
            progress = 0;
            killProcess();
        }
        waitPortFree(2600L);
    }

    /** Synchronous teardown used by the HTTP control plane. */
    public void stopSync() {
        stop();
    }

    // ------------------------------------------------------------- internals

    private void submit(Runnable task) {
        try {
            worker.execute(task);
        } catch (Exception e) {
            log("worker rejected: " + e.getMessage());
            state = "error";
            error = "Shield worker is not available";
        }
    }

    private void bringUp(String wanted, boolean fresh) {
        if (stopped) return;
        state = "connecting";
        error = "";
        phase = "Preparing the Shield";
        progress = 3;
        region = wanted;
        warp = false;
        actual = "";
        ip = "";
        startedAt = 0L;

        try {
            ensureConfig();
        } catch (Exception e) {
            fail(e);
            return;
        }
        if (stopped) return;
        progress = 10;
        phase = "Releasing the local proxy";

        if (fresh || process != null) {
            killProcess();
            waitPortFree(7000L);
        }

        String[] list = ENDPOINTS.get(wanted);
        if (list == null) list = ENDPOINTS.get("auto");
        int attempts = Math.min(START_ATTEMPTS, list.length);
        Exception last = null;

        /* IPv6 anchor first: on IPv4-congested networks it is often an order
           of magnitude faster. A short budget keeps IPv4-only networks snappy. */
        if (!stopped) {
            progress = 16;
            phase = "IPv6 anchor";
            log("start " + wanted + ": IPv6 anchor " + WARP_ENDPOINT_V6);
            try {
                spawn(false, true);
                waitReady(V6_READY_MS);
                dnsMode = 1;
                ipv6 = true;
                last = null;
            } catch (Exception e) {
                last = e;
                log("IPv6 anchor failed: " + e.getMessage());
                killProcess();
                waitPortFree(4500L);
            }
        }

        for (int i = 0; i < attempts && !stopped && !isOn(); i++) {
            /* First half of the ladder resolves inside the tunnel; the second
               half falls back to the system resolver on networks that cannot
               reach 1.1.1.1 through WARP. */
            boolean sysDns = i >= (attempts + 1) / 2;
            progress = 18 + i * 11;
            phase = "Endpoint " + (i + 1) + " of " + attempts;
            log("start " + wanted + ": endpoint " + list[i] + " (" + (i + 1) + "/" + attempts +
                    ") dns=" + (sysDns ? "system" : "1.1.1.1"));
            writeEndpoint(wanted, list[i]);
            try {
                spawn(sysDns, false);
                waitReady(ATTEMPT_READY_MS);
                dnsMode = sysDns ? 2 : 1;
                ipv6 = false;
                last = null;
                break;
            } catch (Exception e) {
                last = e;
                log("endpoint " + list[i] + " failed: " + e.getMessage());
            }
            killProcess();
            waitPortFree(4500L);
        }

        /* Every regional anchor can fail on a hostile network. One last try on
           the global profile keeps the app usable; the requested label stays
           in `region` and the measured egress is reported separately. */
        if (!isOn() && !stopped && !"auto".equals(wanted)) {
            progress = 88;
            phase = "Trying the global profile";
            log("region " + wanted + " exhausted; trying the global profile");
            writeEndpoint(wanted, ENDPOINTS.get("auto")[0]);
            killProcess();
            waitPortFree(4500L);
            try {
                /* No attempt has succeeded yet; give the last anchor the
                   reliable tunnel-DNS path. */
                spawn(false, false);
                waitReady(ATTEMPT_READY_MS);
                dnsMode = 1;
                ipv6 = false;
                last = null;
            } catch (Exception e) {
                last = e;
            }
        }

        if (stopped) return;
        if (!isOn()) {
            fail(last != null ? last : new IOException("No Shield endpoint answered"));
            return;
        }
        if (!"auto".equals(wanted) && !actual.isEmpty() && !wanted.equalsIgnoreCase(actual)) {
            error = "Anycast endpoint; egress is " + actual;
        }
    }

    private void fail(Exception e) {
        Log.w(TAG, "tunnel failed: " + e.getMessage());
        state = "error";
        error = String.valueOf(e.getMessage());
        phase = "No endpoint answered";
        progress = 100;
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

    /* `sysDns` lets usque use Android's resolver instead of resolving names
       inside the tunnel. Android's resolver can hand back anycast addresses
       that WARP refuses (504/CRYPTO_ERROR), so the tunnel resolver
       (1.1.1.1) is the default and the system resolver is the fallback. */
    private void spawn(boolean sysDns, boolean v6) throws Exception {
        String bin = binary();
        if (bin.isEmpty()) throw new IOException("Shield core missing (libusque.so)");
        File cfg = configFile();
        if (!validConfig(cfg)) throw new IOException("Shield identity is missing");
        /* L4 CONNECT proxy: one HTTP/3 stream per client request. The older
           http-proxy mode serialised traffic behind a small tunnel pool and
           starved when the WebView and the player opened parallel sockets. */
        java.util.List<String> cmd = new java.util.ArrayList<>();
        cmd.add(bin);
        cmd.add("-c"); cmd.add(cfg.getAbsolutePath());
        cmd.add("l4-http-proxy");
        if (v6) cmd.add("-6");
        cmd.add("-b"); cmd.add(HOST);
        cmd.add("-p"); cmd.add(String.valueOf(PORT));
        if (sysDns) cmd.add("--system-dns");
        else {
            /* Both Cloudflare resolvers return the same global answers (no
               carrier DNS64 synthesis), so a timed-out query can retry on
               the twin instead of failing the page. */
            cmd.add("-d"); cmd.add("1.1.1.1");
            cmd.add("-d"); cmd.add("1.0.0.1");
            cmd.add("-t"); cmd.add("5s");
        }
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(context.getFilesDir());
        pb.redirectErrorStream(true);
        Map<String, String> env = pb.environment();
        env.put("HOME", context.getFilesDir().getAbsolutePath());
        env.put("TMPDIR", context.getCacheDir().getAbsolutePath());
        process = pb.start();
        final Process started = process;
        pump = new Thread(new Runnable() {
            @Override public void run() { drain(started, "usque"); }
        }, "superbox-usque-log");
        pump.setDaemon(true);
        pump.start();
        Thread death = new Thread(new Runnable() {
            @Override public void run() {
                try { started.waitFor(); } catch (Exception ignored) {}
                if (process == started && !stopped) {
                    log("usque process exited");
                    if ("on".equals(state) || "connecting".equals(state)) {
                        state = "error";
                        phase = "Process exited";
                        progress = 100;
                        error = "Shield process exited";
                        warp = false;
                    }
                }
            }
        }, "superbox-usque-wait");
        death.setDaemon(true);
        death.start();
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

    /**
     * The listener on 46950 can outlive the process for a moment. A new usque
     * instance fails to bind inside that window, so wait until a loopback
     * connect is refused before spawning again.
     */
    private boolean waitPortFree(long timeoutMs) {
        long until = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < until) {
            Socket s = new Socket();
            try {
                s.connect(new InetSocketAddress(HOST, PORT), 350);
                /* Still listening. */
            } catch (Exception e) {
                return true;
            } finally {
                try { s.close(); } catch (Exception ignored) {}
            }
            try { Thread.sleep(200L); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return false; }
        }
        return false;
    }

    /** Polls the trace endpoint through the proxy until WARP answers. */
    private void waitReady(long timeoutMs) throws Exception {
        long start = System.currentTimeMillis();
        long until = start + timeoutMs;
        while (System.currentTimeMillis() < until) {
            if (stopped) throw new IOException("Shield stopped");
            if (process == null) throw new IOException(error.isEmpty() ? "Shield process exited" : error);
            try {
                if (probe()) {
                    state = "on";
                    phase = "Tunnel live";
                    progress = 100;
                    startedAt = startedAt == 0L ? System.currentTimeMillis() : startedAt;
                    error = "";
                    watchFails = 0;
                    log("ready egress=" + actual + " warp=" + warp);
                    return;
                }
            } catch (Exception e) {
                log("probe: " + e.getMessage());
            }
            long elapsed = System.currentTimeMillis() - start;
            int pct = 58 + (int) Math.min(34L, elapsed * 34L / Math.max(1L, timeoutMs));
            progress = pct;
            phase = "Negotiating the tunnel";
            Thread.sleep(1100L);
        }
        throw new IOException("Shield tunnel did not come up in time");
    }

    private boolean probe() throws Exception {
        Proxy proxy = new Proxy(Proxy.Type.HTTP, new InetSocketAddress(HOST, PORT));
        HttpURLConnection c = (HttpURLConnection) new URL(TRACE).openConnection(proxy);
        c.setConnectTimeout(6000);
        c.setReadTimeout(8000);
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

    // -------------------------------------------------------------- watchdog

    /** Repairs a tunnel that died after the gate had already opened. */
    private void watch() {
        if (!"on".equals(state) || process == null || stopped) return;
        if (!watchBusy.compareAndSet(false, true)) return;
        try {
            boolean ok = false;
            try { ok = probe(); } catch (Exception e) { ok = false; }
            if (ok) { watchFails = 0; return; }
            watchFails++;
            log("watchdog miss " + watchFails + "/3");
            if (watchFails >= 3) {
                watchFails = 0;
                log("self-repair: tunnel stopped answering");
                synchronized (lock) {
                    state = "connecting";
                    phase = "Repairing the tunnel";
                    progress = 8;
                    error = "Reconnecting the Shield";
                }
                final String keep = region;
                submit(new Runnable() {
                    @Override public void run() { bringUp(keep, true); }
                });
            }
        } finally {
            watchBusy.set(false);
        }
    }

    public JSONObject status() {
        JSONObject j = new JSONObject();
        try {
            j.put("ok", isOn());
            j.put("engine", "usque/WARP MASQUE");
            j.put("state", state);
            j.put("phase", phase);
            j.put("progress", progress);
            j.put("region", region);
            j.put("regionLabel", LABELS.getOrDefault(region, region));
            j.put("preferred", preferred);
            j.put("dns", dnsMode == 1 ? "1.1.1.1" : dnsMode == 2 ? "system" : "auto");
            j.put("transport", ipv6 ? "ipv6" : "ipv4");
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
