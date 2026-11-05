package com.superbox.mobile;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;

import java.util.ArrayList;

public class MainActivity extends Activity {

    private FrameLayout root;
    private WebView web;
    private LocalServer server;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private TextView splash;
    private FrameLayout webOverlay;
    private WebView overlayWeb;
    private String[] overlayUrls = new String[0];
    private int overlayIndex = 0;
    private long overlayStepAt = 0L;
    private boolean overlayStalled = false;
    private final android.os.Handler overlayHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private Runnable overlayWatch;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        splash = new TextView(this);
        splash.setText("SUPERBOX");
        splash.setTextColor(Color.parseColor("#FFC105"));
        splash.setTextSize(26f);
        splash.setLetterSpacing(0.18f);
        splash.setGravity(android.view.Gravity.CENTER);
        splash.setBackgroundColor(Color.BLACK);
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web.addJavascriptInterface(new Bridge(), "SBAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (u != null && "127.0.0.1".equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (splash != null) {
                    splash.animate().alpha(0f).setDuration(280).withEndAction(new Runnable() {
                        @Override public void run() {
                            if (splash != null && splash.getParent() != null) {
                                root.removeView(splash);
                            }
                            splash = null;
                        }
                    }).start();
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                web.setVisibility(View.GONE);
                root.addView(customView, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                applyImmersive(true);
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                web.setVisibility(View.VISIBLE);
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                    customViewCallback = null;
                }
                applyImmersive(false);
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
            }
        });

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    server = new LocalServer(getApplicationContext());
                    final int port = server.start();
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            web.loadUrl("http://127.0.0.1:" + port + "/index.html");
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (splash != null) {
                                splash.setText("SuperBox could not start\n" + e.getMessage());
                                splash.setTextSize(15f);
                                splash.setLetterSpacing(0f);
                            }
                        }
                    });
                }
            }
        }, "superbox-server-start").start();
    }

    /* Full-screen in-app browser used only for sources that refuse to expose
       a raw media file (provider embeds, some custom-library pages). It keeps
       the viewer inside SuperBox instead of handing off to an external app. */
    private void openWebView(final String url, final String title) {
        openWebLadder(new String[]{url}, title);
    }

    /* A provider shell is only a means to a stream. When one answers with a
       dead page (500, "something went wrong", player config error) the next
       source in the ladder is loaded automatically. */
    private void openWebLadder(final String[] urls, final String title) {
        if (urls == null || urls.length == 0) return;
        final String[] ladder = urls.clone();
        runOnUiThread(new Runnable() {
            @Override public void run() {
                closeWebView();
                overlayUrls = ladder;
                overlayIndex = 0;
                overlayStepAt = 0L;
                overlayStalled = false;
                final FrameLayout box = new FrameLayout(MainActivity.this);
                box.setBackgroundColor(Color.BLACK);

                WebView wv = new WebView(MainActivity.this);
                wv.setBackgroundColor(Color.BLACK);
                WebSettings ws = wv.getSettings();
                ws.setJavaScriptEnabled(true);
                ws.setDomStorageEnabled(true);
                ws.setDatabaseEnabled(true);
                ws.setMediaPlaybackRequiresUserGesture(false);
                ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
                ws.setJavaScriptCanOpenWindowsAutomatically(true);
                ws.setSupportMultipleWindows(false);
                ws.setLoadsImagesAutomatically(true);
                ws.setCacheMode(WebSettings.LOAD_DEFAULT);
                CookieManager.getInstance().setAcceptCookie(true);
                CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true);
                wv.setWebChromeClient(new WebChromeClient() {
                    @Override
                    public void onShowCustomView(View view, CustomViewCallback callback) {
                        if (customView != null) { callback.onCustomViewHidden(); return; }
                        customView = view;
                        customViewCallback = callback;
                        box.setVisibility(View.GONE);
                        root.addView(customView, new FrameLayout.LayoutParams(
                                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                        applyImmersive(true);
                        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                    }
                    @Override
                    public void onHideCustomView() {
                        if (customView == null) return;
                        root.removeView(customView);
                        customView = null;
                        box.setVisibility(View.VISIBLE);
                        if (customViewCallback != null) {
                            customViewCallback.onCustomViewHidden();
                            customViewCallback = null;
                        }
                        applyImmersive(false);
                        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
                    }
                });
                wv.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        Uri u = request.getUrl();
                        if (u == null) return false;
                        String s = u.toString();
                        if (s.startsWith("http://") || s.startsWith("https://") || s.startsWith("about:")) return false;
                        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                        return true;
                    }
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        if (view == overlayWeb) startOverlayWatch();
                    }
                    @Override
                    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                        if (request != null && request.isForMainFrame() && overlayUrls.length > 1) nextOverlayStep();
                    }
                    @Override
                    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                        if (request != null && request.isForMainFrame() && response != null
                                && response.getStatusCode() >= 400 && overlayUrls.length > 1) {
                            nextOverlayStep();
                        }
                    }
                });
                box.addView(wv, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

                TextView close = new TextView(MainActivity.this);
                close.setText("✕");
                close.setTextColor(Color.WHITE);
                close.setTextSize(20f);
                close.setGravity(android.view.Gravity.CENTER);
                close.setBackgroundColor(Color.parseColor("#CC111111"));
                FrameLayout.LayoutParams cp = new FrameLayout.LayoutParams(dp(46), dp(46));
                cp.gravity = android.view.Gravity.TOP | android.view.Gravity.END;
                cp.topMargin = 0;
                cp.rightMargin = dp(10);
                close.setLayoutParams(cp);
                close.setOnClickListener(new View.OnClickListener() {
                    @Override public void onClick(View v) { closeWebView(); }
                });
                box.addView(close);

                root.addView(box, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                webOverlay = box;
                overlayWeb = wv;
                try { wv.loadUrl(overlayUrls[0]); } catch (Exception e) { closeWebView(); }
            }
        });
    }

    /* Dead provider shells do not always fail at the HTTP level: many answer
       200 with "Oops" or a player configuration error. A page can also mount
       a <video> that never receives a byte (CORS/DRM-dead stream). Probe after
       the page settles; a stalled player gets one retry before the ladder
       advances, so a slow-but-working provider is not skipped. */
    private static final String OVERLAY_PROBE =
            "(function(){try{"
            + "var b=document.body; if(!b) return 'empty';"
            + "var t=(b.innerText||'').toLowerCase();"
            + "var vs=document.querySelectorAll('video');"
            + "var f=document.querySelectorAll('iframe,embed,object').length;"
            + "var progress=false,attempting=false;"
            + "for(var i=0;i<vs.length;i++){var v=vs[i];"
            + "if(v.readyState>=2||v.currentTime>0) progress=true;"
            + "if(!v.paused||v.networkState===2) attempting=true;}"
            + "var dead=/oops|something went wrong|player configuration error|video not found|"
            + "file not found|no servers available|no source available|not available|"
            + "error (?:1[0-9][0-9]|4[0-9][0-9]|5[0-9][0-9])/.test(t);"
            + "if(dead&&!progress) return 'dead';"
            + "var txt=t.replace(/[^a-z0-9]+/g,'');"
            + "if(vs.length===0&&f===0&&txt.length<40) return 'empty';"
            + "if(vs.length>0&&!progress&&attempting) return 'stalled';"
            + "return 'ok';"
            + "}catch(e){return 'ok'}})()";

    private void startOverlayWatch() {
        cancelOverlayWatch();
        if (overlayWeb == null || overlayUrls.length < 2) return;
        overlayStalled = false;
        overlayWatch = new Runnable() {
            @Override public void run() {
                final WebView wv = overlayWeb;
                if (wv == null) return;
                try {
                    wv.evaluateJavascript(OVERLAY_PROBE, new ValueCallback<String>() {
                        @Override public void onReceiveValue(String value) {
                            if (overlayWeb == null || wv != overlayWeb) return;
                            if (value == null) return;
                            if (value.indexOf("stalled") >= 0) {
                                if (!overlayStalled) {
                                    overlayStalled = true;
                                    overlayHandler.postDelayed(overlayWatch, 12000L);
                                } else {
                                    nextOverlayStep();
                                }
                                return;
                            }
                            if (value.indexOf("dead") >= 0 || value.indexOf("empty") >= 0) {
                                nextOverlayStep();
                            }
                        }
                    });
                } catch (Exception ignored) {}
            }
        };
        overlayHandler.postDelayed(overlayWatch, 9000L);
    }

    private void cancelOverlayWatch() {
        if (overlayWatch != null) {
            overlayHandler.removeCallbacks(overlayWatch);
            overlayWatch = null;
        }
    }

    private void nextOverlayStep() {
        cancelOverlayWatch();
        if (overlayWeb == null) return;
        /* A single dead provider can report twice (HTTP status + page probe). */
        long now = android.os.SystemClock.elapsedRealtime();
        if (now - overlayStepAt < 1500L) return;
        overlayStepAt = now;
        if (overlayIndex + 1 >= overlayUrls.length) {
            Toast.makeText(this, "No source answered for this title", Toast.LENGTH_SHORT).show();
            return;
        }
        overlayIndex++;
        overlayStalled = false;
        try { overlayWeb.loadUrl(overlayUrls[overlayIndex]); } catch (Exception ignored) {}
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    private void closeWebView() {
        cancelOverlayWatch();
        overlayWeb = null;
        overlayUrls = new String[0];
        overlayIndex = 0;
        overlayStalled = false;
        if (webOverlay == null) return;
        FrameLayout box = webOverlay;
        webOverlay = null;
        try {
            for (int i = 0; i < box.getChildCount(); i++) {
                View c = box.getChildAt(i);
                if (c instanceof WebView) {
                    WebView w = (WebView) c;
                    w.loadUrl("about:blank");
                    w.destroy();
                }
            }
        } catch (Exception ignored) {}
        try { root.removeView(box); } catch (Exception ignored) {}
        if (customView != null) {
            try { root.removeView(customView); } catch (Exception ignored) {}
            customView = null;
            customViewCallback = null;
            applyImmersive(false);
        }
    }

    private void applyImmersive(boolean on) {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                if (on) {
                    c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                    c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                } else {
                    c.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                }
            }
        } else {
            if (on) {
                getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
            } else {
                getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
            }
        }
    }

    private void keepScreenOn(boolean on) {
        if (on) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }

    @Override
    public void onBackPressed() {
        if (webOverlay != null) {
            closeWebView();
            return;
        }
        if (customView != null) {
            web.getWebChromeClient().onHideCustomView();
            return;
        }
        web.evaluateJavascript(
                "(function(){try{return window.sbBack?window.sbBack():false}catch(e){return false}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (value == null || "false".equals(value) || "null".equals(value)
                                || "undefined".equals(value)) {
                            finish();
                        }
                    }
                });
    }

    @Override
    protected void onPause() {
        if (web != null) {
            web.evaluateJavascript("window.sbPause&&window.sbPause()", null);
            web.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (server != null) server.stop();
        closeWebView();
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    public class Bridge {
        @JavascriptInterface
        public void setImmersive(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override public void run() { MainActivity.this.applyImmersive(on); }
            });
        }

        @JavascriptInterface
        public void keepScreenOn(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override public void run() { MainActivity.this.keepScreenOn(on); }
            });
        }

        @JavascriptInterface
        public void setLandscape(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    setRequestedOrientation(on
                            ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                            : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
                }
            });
        }

        @JavascriptInterface
        public void toggleOrientation() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    int o = getResources().getConfiguration().orientation;
                    setRequestedOrientation(o == android.content.res.Configuration.ORIENTATION_LANDSCAPE
                            ? ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                            : ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                }
            });
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public String version() {
            return "1.0.0";
        }

        @JavascriptInterface
        public void openWeb(final String url, final String title) {
            if (url == null || url.isEmpty()) return;
            MainActivity.this.openWebView(url, title);
        }

        /* Same overlay, but with an ordered list of provider shells. Each dead
           one is skipped automatically until a playable source answers. */
        @JavascriptInterface
        public void openLadder(final String jsonUrls, final String title) {
            if (jsonUrls == null || jsonUrls.isEmpty()) return;
            ArrayList<String> list = new ArrayList<String>();
            try {
                JSONArray arr = new JSONArray(jsonUrls);
                for (int i = 0; i < arr.length(); i++) {
                    String u = arr.optString(i, "");
                    if (u != null && !u.isEmpty()) list.add(u);
                }
            } catch (Exception e) {
                return;
            }
            if (list.isEmpty()) return;
            MainActivity.this.openWebLadder(list.toArray(new String[list.size()]), title);
        }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(new Runnable() {
                @Override public void run() { finish(); }
            });
        }
    }
}
