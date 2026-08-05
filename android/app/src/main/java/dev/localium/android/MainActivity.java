package dev.localium.android;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.OutputStream;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class MainActivity extends Activity {
    private static final String KEY_ALIAS = "localium.android.vault";
    private static final String APP_URL = "file:///android_asset/web/index.html";
    private static final String APP_PREFIX = "file:///android_asset/web/";
    private static final int FILE_CHOOSER_REQUEST = 9042;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        webView = new WebView(this);
        webView.setContentDescription("Localium Android chat client");
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setSupportMultipleWindows(false);

        webView.addJavascriptInterface(new AndroidBridge(this), "AndroidNative");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST);
                    return true;
                } catch (RuntimeException error) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isBundledAppUrl(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!isBundledAppUrl(Uri.parse(url))) {
                    view.stopLoading();
                    view.loadUrl(APP_URL);
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                String fingerprint = certificateFingerprint(error.getCertificate());
                if (fingerprint != null && trustedFingerprints().contains(fingerprint)) handler.proceed();
                else handler.cancel();
            }
        });
        webView.loadUrl(APP_URL);
    }

    private static boolean isBundledAppUrl(Uri uri) {
        return "file".equals(uri.getScheme()) && uri.toString().startsWith(APP_PREFIX);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || fileCallback == null) return;
        fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        fileCallback = null;
    }

    @Override
    protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = null;
        webView.removeJavascriptInterface("AndroidNative");
        webView.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    private Set<String> trustedFingerprints() {
        return getSharedPreferences("localium", MODE_PRIVATE).getStringSet("fingerprints", new HashSet<>());
    }

    private static String normalizeFingerprint(String value) {
        return value.replace(":", "").trim().toUpperCase(Locale.ROOT);
    }

    private static boolean isValidFingerprint(String value) {
        return value.matches("^[0-9A-F]{64}$");
    }

    private static String certificateFingerprint(SslCertificate certificate) {
        try {
            Bundle state = SslCertificate.saveState(certificate);
            byte[] encoded = state.getByteArray("x509-certificate");
            if (encoded == null) return null;
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(encoded);
            StringBuilder result = new StringBuilder();
            for (byte value : digest) result.append(String.format(Locale.ROOT, "%02X", value));
            return result.toString();
        } catch (Exception error) {
            return null;
        }
    }

    public static final class AndroidBridge {
        private final Activity activity;
        private final SharedPreferences preferences;

        AndroidBridge(Activity activity) {
            this.activity = activity;
            this.preferences = activity.getSharedPreferences("localium", Context.MODE_PRIVATE);
        }

        @JavascriptInterface
        public String loadVault() {
            String encrypted = preferences.getString("vault", "");
            if (encrypted == null || encrypted.isEmpty()) return "";
            try {
                byte[] payload = Base64.decode(encrypted, Base64.NO_WRAP);
                if (payload.length <= 12) return "";
                byte[] iv = new byte[12];
                System.arraycopy(payload, 0, iv, 0, iv.length);
                byte[] ciphertext = new byte[payload.length - iv.length];
                System.arraycopy(payload, iv.length, ciphertext, 0, ciphertext.length);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
                return new String(cipher.doFinal(ciphertext), java.nio.charset.StandardCharsets.UTF_8);
            } catch (Exception error) {
                return "";
            }
        }

        @JavascriptInterface
        public void saveVault(String value) {
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
                byte[] ciphertext = cipher.doFinal(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                byte[] iv = cipher.getIV();
                byte[] payload = new byte[iv.length + ciphertext.length];
                System.arraycopy(iv, 0, payload, 0, iv.length);
                System.arraycopy(ciphertext, 0, payload, iv.length, ciphertext.length);
                preferences.edit().putString("vault", Base64.encodeToString(payload, Base64.NO_WRAP)).apply();
            } catch (Exception error) {
                throw new IllegalStateException("Unable to protect Localium vault.", error);
            }
        }

        @JavascriptInterface
        public void trustFingerprint(String value) {
            String normalized = normalizeFingerprint(value);
            if (!isValidFingerprint(normalized)) throw new IllegalArgumentException("Invalid SHA-256 certificate fingerprint.");
            Set<String> values = new HashSet<>(preferences.getStringSet("fingerprints", new HashSet<>()));
            values.add(normalized);
            preferences.edit().putStringSet("fingerprints", values).apply();
        }

        @JavascriptInterface
        public boolean saveFile(String name, String dataBase64) {
            try {
                byte[] data = Base64.decode(dataBase64, Base64.DEFAULT);
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name.replaceAll("[\\r\\n\\\\/]", "_"));
                values.put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream");
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Localium");
                Uri uri = activity.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return false;
                try (OutputStream stream = activity.getContentResolver().openOutputStream(uri)) {
                    if (stream == null) return false;
                    stream.write(data);
                }
                return true;
            } catch (Exception error) {
                return false;
            }
        }

        @JavascriptInterface
        public String getVersion() {
            return "0.2.0";
        }

        private SecretKey getOrCreateKey() throws Exception {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (store.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
            KeyGenerator generator = KeyGenerator.getInstance("AES", "AndroidKeyStore");
            generator.init(new android.security.keystore.KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                android.security.keystore.KeyProperties.PURPOSE_ENCRYPT | android.security.keystore.KeyProperties.PURPOSE_DECRYPT
            ).setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
             .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
             .setKeySize(256)
             .build());
            return generator.generateKey();
        }
    }
}
