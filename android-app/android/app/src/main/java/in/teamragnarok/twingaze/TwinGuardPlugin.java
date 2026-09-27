package in.teamragnarok.twingaze;

import android.Manifest;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Activity;
import android.app.KeyguardManager;
import android.app.admin.DevicePolicyManager;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.InstallSourceInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.PermissionInfo;
import android.content.pm.ResolveInfo;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.AudioManager;
import android.media.AudioRecordingConfiguration;
import android.os.Handler;
import android.os.Looper;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Base64;
import android.view.accessibility.AccessibilityManager;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.io.File;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Phone check ("is there spyware / stalkerware on this phone?"). Lists the installed apps with who
 * installed them, their signing certificates and what they are allowed to do (granted dangerous
 * permissions, accessibility service, device admin, notification access), plus a few security
 * settings. It only collects raw data; js/guard.js compares it with the known-stalkerware list and
 * scores it. This is not an antivirus: app code and files are not scanned.
 *
 * Android does not let one app remove another: uninstall() opens the system dialog and the user confirms.
 */
@CapacitorPlugin(name = "TwinGuard")
public class TwinGuardPlugin extends Plugin {

    private static final int ICON_PX = 72;
    private static final long PROGRESS_EVERY_MS = 60;
    private static final int MATCH_ALL = PackageManager.MATCH_DISABLED_COMPONENTS | PackageManager.MATCH_DISABLED_UNTIL_USED_COMPONENTS;

    /** Where su binaries usually live (plus every folder on $PATH, added at runtime). */
    private static final String[] SU_PATHS = {
        "/system/bin/su", "/system/xbin/su", "/sbin/su", "/system/su", "/system/bin/.ext/su", "/system/bin/.ext/.su",
        "/system/usr/we-need-root/su", "/system/sd/xbin/su", "/system/bin/failsafe/su", "/data/local/su",
        "/data/local/bin/su", "/data/local/xbin/su", "/su/bin/su", "/vendor/bin/su", "/product/bin/su", "/odm/bin/su",
        "/cache/su", "/dev/su", "/system/app/Superuser.apk",
    };
    /** Magisk / KernelSU / APatch leftovers. Most of /data/adb is unreadable to apps, so these rarely show; best effort. */
    private static final String[] ROOT_PATHS = {
        "/sbin/.magisk", "/sbin/magisk", "/debug_ramdisk/.magisk", "/dev/.magisk.unblock", "/cache/.disable_magisk",
        "/system/bin/magisk", "/system/xbin/magisk", "/data/adb/magisk", "/data/adb/magisk.db", "/data/adb/modules",
        "/data/adb/ksu", "/data/adb/ksud", "/data/adb/ap",
    };
    /** Root manager apps: { package, name }. */
    private static final String[][] ROOT_APPS = {
        { "com.topjohnwu.magisk", "Magisk" },
        { "io.github.vvb2060.magisk", "Magisk Alpha" },
        { "io.github.huskydg.magisk", "Kitsune Magisk" },
        { "me.weishu.kernelsu", "KernelSU" },
        { "me.bmax.apatch", "APatch" },
        { "eu.chainfire.supersu", "SuperSU" },
        { "com.koushikdutta.superuser", "Superuser" },
        { "com.noshufou.android.su", "Superuser" },
        { "com.noshufou.android.su.elite", "Superuser Elite" },
        { "com.thirdparty.superuser", "Superuser" },
        { "com.yellowes.su", "Superuser" },
        { "com.kingroot.kinguser", "KingRoot" },
        { "com.kingo.root", "Kingo Root" },
    };

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean(false);

    @Override
    protected void handleOnDestroy() {
        io.shutdownNow();
    }

    /* ---------- small helpers ---------- */

    private Context ctx() { return getContext().getApplicationContext(); }

    private static Object orNull(Object v) { return v == null ? JSONObject.NULL : v; }

    private static String emptyToNull(String s) { return s == null || s.trim().isEmpty() ? null : s.trim(); }

    private static String msg(Throwable e) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format(Locale.US, "%02x", x & 0xff));
        return sb.toString();
    }

    private static boolean exists(String path) {
        try { return new File(path).exists(); } catch (Exception e) { return false; }
    }

    /** A valid-looking package name from the call, or null. */
    private static String pkgArg(PluginCall call) {
        String p = call.getString("pkg");
        if (p == null) return null;
        p = p.trim();
        return p.matches("[A-Za-z0-9_]+(\\.[A-Za-z0-9_]+)+") ? p : null;
    }

    @SuppressWarnings("deprecation")
    private static PackageInfo pkgInfo(PackageManager pm, String pkg, int flags) throws PackageManager.NameNotFoundException {
        flags |= MATCH_ALL;
        return Build.VERSION.SDK_INT >= 33
            ? pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(flags))
            : pm.getPackageInfo(pkg, flags);
    }

    private static boolean installed(PackageManager pm, String pkg) {
        try { pkgInfo(pm, pkg, 0); return true; } catch (Exception e) { return false; }
    }

    /** Starts an activity from the app's screen (so "back" returns to TwinGaze). */
    private void launch(Intent i) {
        Activity a = getActivity();
        if (a != null && !a.isFinishing()) {
            a.startActivity(i);
        } else {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx().startActivity(i);
        }
    }

    /* =====================================================================================
     * scan(): every installed app + device security settings
     * ===================================================================================== */

    @PluginMethod
    public void scan(PluginCall call) {
        if (!busy.compareAndSet(false, true)) { call.reject("A phone check is already running.", "BUSY"); return; }
        scanInner(call);
    }

    /* =====================================================================================
     * Trackers: which known tracking / advertising SDKs are built into each installed app.
     * An app's code (classes*.dex inside its APK, which Android lets any app read) names the
     * Java packages it contains, e.g. "Lcom/appsflyer/". The signatures come from js/trackers.js;
     * this only searches. Nothing is sent anywhere.
     * ===================================================================================== */

    private final AtomicBoolean trackerBusy = new AtomicBoolean(false);

    @PluginMethod
    public void trackers(PluginCall call) {
        if (!trackerBusy.compareAndSet(false, true)) { call.reject("A tracker check is already running.", "BUSY"); return; }
        final JSArray sigArr = call.getArray("signatures");
        final JSArray pkgArr = call.getArray("packages");
        new Thread(() -> {
            try { call.resolve(runTrackers(sigArr, pkgArr)); }
            catch (Throwable e) { call.reject("Tracker check failed: " + msg(e), "SCAN_FAILED"); }
            finally { trackerBusy.set(false); }
        }, "twingaze-trackers").start();
    }

    /** A byte trie of the signatures; every signature starts with 'L'. */
    private static final class Trie { final Trie[] next = new Trie[128]; int id = -1; }

    private JSObject runTrackers(JSArray sigArr, JSArray pkgArr) throws Exception {
        Trie root = new Trie();
        int nsig = 0;
        List<String> ids = new ArrayList<>();
        if (sigArr != null) for (int i = 0; i < sigArr.length(); i++) {
            JSONObject o = sigArr.getJSONObject(i);
            String id = o.getString("id");
            org.json.JSONArray ss = o.getJSONArray("sigs");
            int idx = ids.size(); ids.add(id);
            for (int k = 0; k < ss.length(); k++) {
                String sig = ss.getString(k);
                if (sig.length() < 4 || sig.charAt(0) != 'L') continue;
                Trie t = root;
                for (int c = 1; c < sig.length(); c++) {
                    int ch = sig.charAt(c) & 0x7f;
                    if (t.next[ch] == null) t.next[ch] = new Trie();
                    t = t.next[ch];
                }
                t.id = idx; nsig++;
            }
        }
        PackageManager pm = ctx().getPackageManager();
        List<String> pkgs = new ArrayList<>();
        if (pkgArr != null) for (int i = 0; i < pkgArr.length(); i++) pkgs.add(pkgArr.getString(i));
        JSObject apps = new JSObject();
        long t0 = SystemClock.elapsedRealtime(), bytes = 0;
        int done = 0;
        for (String pkg : pkgs) {
            JSObject pr = new JSObject();
            pr.put("done", done); pr.put("total", pkgs.size()); pr.put("label", pkg);
            notifyListeners("trackerProgress", pr);
            done++;
            try {
                ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
                List<String> files = new ArrayList<>();
                if (ai.sourceDir != null) files.add(ai.sourceDir);
                if (ai.splitSourceDirs != null) Collections.addAll(files, ai.splitSourceDirs);
                boolean[] hit = new boolean[ids.size()];
                for (String f : files) bytes += scanApk(f, root, hit);
                JSArray found = new JSArray();
                for (int i = 0; i < hit.length; i++) if (hit[i]) found.put(ids.get(i));
                apps.put(pkg, found);
            } catch (Exception e) {
                apps.put(pkg, JSONObject.NULL);                 // unreadable: say so rather than "no trackers"
            }
        }
        JSObject r = new JSObject();
        r.put("apps", apps);
        r.put("signatures", nsig);
        r.put("ms", SystemClock.elapsedRealtime() - t0);
        r.put("mb", Math.round(bytes / 1048576.0));
        return r;
    }

    /** Searches every classes*.dex in one APK; returns the bytes read. */
    private static long scanApk(String path, Trie root, boolean[] hit) throws Exception {
        long read = 0;
        try (ZipFile zf = new ZipFile(path)) {
            Enumeration<? extends ZipEntry> en = zf.entries();
            byte[] buf = new byte[1 << 16];
            while (en.hasMoreElements()) {
                ZipEntry ze = en.nextElement();
                String n = ze.getName();
                if (!n.startsWith("classes") || !n.endsWith(".dex") || n.contains("/")) continue;
                try (InputStream is = zf.getInputStream(ze)) {
                    // stream with a small overlap so a signature split across two reads is still found
                    byte[] carry = new byte[0];
                    int k;
                    while ((k = is.read(buf)) > 0) {
                        read += k;
                        byte[] b;
                        if (carry.length > 0) { b = new byte[carry.length + k]; System.arraycopy(carry, 0, b, 0, carry.length); System.arraycopy(buf, 0, b, carry.length, k); }
                        else { b = new byte[k]; System.arraycopy(buf, 0, b, 0, k); }
                        int limit = b.length;
                        for (int i = 0; i < limit; i++) {
                            if (b[i] != 'L') continue;
                            Trie t = root;
                            for (int j = i + 1; j < limit; j++) {
                                int ch = b[j];
                                if (ch < 0 || (t = t.next[ch]) == null) break;
                                if (t.id >= 0) { hit[t.id] = true; break; }
                            }
                        }
                        int keep = Math.min(96, b.length);
                        carry = new byte[keep];
                        System.arraycopy(b, b.length - keep, carry, 0, keep);
                    }
                }
            }
        }
        return read;
    }

    private void scanInner(PluginCall call) {
        try {
            io.execute(() -> {
                try { call.resolve(runScan()); }
                catch (Throwable e) { call.reject("Phone check failed: " + msg(e), "SCAN_FAILED"); }
                finally { busy.set(false); }
            });
        } catch (Exception e) {
            busy.set(false);
            call.reject("Phone check failed: " + msg(e), "SCAN_FAILED");
        }
    }

    private JSObject runScan() {
        Context c = ctx();
        PackageManager pm = c.getPackageManager();
        String self = c.getPackageName();

        Set<String> a11y = accessibilityPackages(c);
        Set<String> admins = adminPackages(c);
        Set<String> listeners = listenerPackages(c);

        List<String> pkgs = new ArrayList<>();
        for (PackageInfo pi : installedPackages(pm)) {
            if (pi != null && pi.packageName != null && !pi.packageName.equals(self)) pkgs.add(pi.packageName);
        }
        Collections.sort(pkgs);
        final int total = pkgs.size();
        progress(0, total, "");

        Map<String, Boolean> dangerous = new HashMap<>();
        JSArray apps = new JSArray();
        long last = SystemClock.elapsedRealtime();
        int done = 0;
        for (String p : pkgs) {
            if (Thread.currentThread().isInterrupted()) throw new IllegalStateException("stopped");
            String label = p;
            try {
                JSObject a = appInfo(pm, p, a11y, admins, listeners, dangerous);
                if (a != null) { apps.put(a); label = a.getString("name", p); }
            } catch (Exception ignored) {
                // uninstalled while we were looking, or unreadable: skip it
            }
            done++;
            long now = SystemClock.elapsedRealtime();
            if (done == total || now - last >= PROGRESS_EVERY_MS) { last = now; progress(done, total, label); }
        }

        JSObject out = new JSObject();
        out.put("device", deviceInfo(c, pm));
        out.put("apps", apps);
        return out;
    }

    private void progress(int done, int total, String label) {
        JSObject p = new JSObject();
        p.put("done", done);
        p.put("total", total);
        p.put("label", label);
        notifyListeners("guardProgress", p);
    }

    @SuppressWarnings("deprecation")
    private static List<PackageInfo> installedPackages(PackageManager pm) {
        List<PackageInfo> l = Build.VERSION.SDK_INT >= 33
            ? pm.getInstalledPackages(PackageManager.PackageInfoFlags.of(MATCH_ALL))
            : pm.getInstalledPackages(MATCH_ALL);
        return l == null ? new ArrayList<>() : l;
    }

    @SuppressWarnings("deprecation")
    private JSObject appInfo(PackageManager pm, String p, Set<String> a11y, Set<String> admins, Set<String> listeners,
                             Map<String, Boolean> dangerous) throws PackageManager.NameNotFoundException {
        int sigFlag = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo pi;
        try { pi = pkgInfo(pm, p, PackageManager.GET_PERMISSIONS | sigFlag); }
        catch (RuntimeException e) { pi = pkgInfo(pm, p, PackageManager.GET_PERMISSIONS); }   // odd signing block: skip certs
        ApplicationInfo ai = pi.applicationInfo;
        if (ai == null) return null;

        boolean system = (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
        boolean updated = (ai.flags & ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0;
        boolean acc = a11y.contains(p), admin = admins.contains(p), listener = listeners.contains(p);

        String label = p;
        try {
            CharSequence cs = pm.getApplicationLabel(ai);
            if (cs != null && !cs.toString().trim().isEmpty()) label = cs.toString().trim();
        } catch (Exception ignored) { }

        JSObject a = new JSObject();
        a.put("pkg", p);
        a.put("name", label);
        a.put("system", system);
        a.put("updatedSystem", updated);
        String[] src = installSource(pm, p);
        a.put("installer", orNull(src[0]));
        a.put("initiator", orNull(src[1]));
        a.put("firstInstall", pi.firstInstallTime);
        a.put("lastUpdate", pi.lastUpdateTime);
        a.put("versionName", orNull(pi.versionName));
        boolean launcher = false;
        try { launcher = pm.getLaunchIntentForPackage(p) != null; } catch (Exception ignored) { }
        a.put("launcher", launcher);
        a.put("enabled", ai.enabled);

        LinkedHashSet<String> granted = new LinkedHashSet<>();
        boolean overlay = false;
        String[] req = pi.requestedPermissions;
        int[] flags = pi.requestedPermissionsFlags;
        if (req != null) {
            for (int i = 0; i < req.length; i++) {
                String perm = req[i];
                if (perm == null) continue;
                if (Manifest.permission.SYSTEM_ALERT_WINDOW.equals(perm)) overlay = true;
                boolean isGranted = flags != null && i < flags.length && (flags[i] & PackageInfo.REQUESTED_PERMISSION_GRANTED) != 0;
                if (isGranted && isDangerous(pm, perm, dangerous)) granted.add(perm.substring(perm.lastIndexOf('.') + 1));
            }
        }
        JSArray g = new JSArray();
        for (String s : granted) g.put(s);
        a.put("granted", g);
        a.put("requestsOverlay", overlay);
        a.put("accessibility", acc);
        a.put("deviceAdmin", admin);
        a.put("notificationListener", listener);
        JSArray certs = new JSArray();
        for (String h : certSha1(pi)) certs.put(h);
        a.put("certSha1", certs);
        // Icons only where the UI shows them: apps someone installed, and system apps with special access.
        a.put("icon", orNull(!system || acc || admin || listener ? iconB64(pm, ai) : null));
        return a;
    }

    /** { installing package, initiating package } (either may be null: unknown / installed over adb). */
    @SuppressWarnings("deprecation")
    private static String[] installSource(PackageManager pm, String p) {
        String installer = null, initiator = null;
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                InstallSourceInfo si = pm.getInstallSourceInfo(p);
                installer = si.getInstallingPackageName();
                initiator = si.getInitiatingPackageName();
            } else {
                installer = pm.getInstallerPackageName(p);
            }
        } catch (Exception ignored) { }
        return new String[] { emptyToNull(installer), emptyToNull(initiator) };
    }

    /** Platform ("android") permissions with the dangerous (runtime) protection level. */
    @SuppressWarnings("deprecation")
    private static boolean isDangerous(PackageManager pm, String perm, Map<String, Boolean> cache) {
        Boolean known = cache.get(perm);
        if (known != null) return known;
        boolean d = false;
        try {
            PermissionInfo info = pm.getPermissionInfo(perm, 0);
            int base = Build.VERSION.SDK_INT >= 28 ? info.getProtection() : (info.protectionLevel & PermissionInfo.PROTECTION_MASK_BASE);
            d = base == PermissionInfo.PROTECTION_DANGEROUS && "android".equals(info.packageName);
        } catch (Exception ignored) { }
        cache.put(perm, d);
        return d;
    }

    /** Lower-case hex SHA-1 of each signing certificate (including earlier ones after a key rotation). */
    @SuppressWarnings("deprecation")
    private static List<String> certSha1(PackageInfo pi) {
        LinkedHashSet<String> out = new LinkedHashSet<>();
        Signature[] sigs = null;
        try {
            if (Build.VERSION.SDK_INT >= 28) {
                SigningInfo si = pi.signingInfo;
                if (si != null) sigs = si.hasMultipleSigners() ? si.getApkContentsSigners() : si.getSigningCertificateHistory();
            } else {
                sigs = pi.signatures;
            }
        } catch (Exception ignored) { }
        if (sigs != null) {
            try {
                MessageDigest md = MessageDigest.getInstance("SHA-1");
                for (Signature s : sigs) {
                    if (s == null) continue;
                    md.reset();
                    out.add(hex(md.digest(s.toByteArray())));
                }
            } catch (Exception ignored) { }
        }
        return new ArrayList<>(out);
    }

    /** The app's icon as a base64 PNG (ICON_PX square), or null. */
    private static String iconB64(PackageManager pm, ApplicationInfo ai) {
        Bitmap bmp = null;
        try {
            Drawable d = pm.getApplicationIcon(ai);
            if (d == null) return null;
            bmp = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888);
            d.setBounds(0, 0, ICON_PX, ICON_PX);
            d.draw(new Canvas(bmp));
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            if (!bmp.compress(Bitmap.CompressFormat.PNG, 100, bos)) return null;
            return Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
        } catch (Throwable e) {
            return null;
        } finally {
            if (bmp != null) bmp.recycle();
        }
    }

    /* ---------- who holds special access ---------- */

    private static void addComponents(Set<String> out, String flat) {
        if (flat == null) return;
        for (String s : flat.split(":")) {
            ComponentName cn = ComponentName.unflattenFromString(s.trim());
            if (cn != null) out.add(cn.getPackageName());
        }
    }

    /** Apps with an accessibility service switched on. */
    private static Set<String> accessibilityPackages(Context c) {
        Set<String> out = new HashSet<>();
        try {
            AccessibilityManager am = (AccessibilityManager) c.getSystemService(Context.ACCESSIBILITY_SERVICE);
            List<AccessibilityServiceInfo> list = am == null ? null : am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK);
            if (list != null) {
                for (AccessibilityServiceInfo i : list) {
                    String pkg = null;
                    ResolveInfo ri = i.getResolveInfo();
                    if (ri != null && ri.serviceInfo != null) pkg = ri.serviceInfo.packageName;
                    if (pkg == null && i.getId() != null) {
                        ComponentName cn = ComponentName.unflattenFromString(i.getId());
                        if (cn != null) pkg = cn.getPackageName();
                    }
                    if (pkg != null) out.add(pkg);
                }
            }
        } catch (Exception ignored) { }
        // Also the switched-on list in Settings: covers a service that is on but not running right now.
        try {
            ContentResolver cr = c.getContentResolver();
            if (Settings.Secure.getInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 0) == 1) {
                addComponents(out, Settings.Secure.getString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES));
            }
        } catch (Exception ignored) { }
        return out;
    }

    /** Apps that are active device administrators. */
    private static Set<String> adminPackages(Context c) {
        Set<String> out = new HashSet<>();
        try {
            DevicePolicyManager dpm = (DevicePolicyManager) c.getSystemService(Context.DEVICE_POLICY_SERVICE);
            List<ComponentName> list = dpm == null ? null : dpm.getActiveAdmins();
            if (list != null) for (ComponentName cn : list) if (cn != null) out.add(cn.getPackageName());
        } catch (Exception ignored) { }
        return out;
    }

    /** Apps allowed to read notifications. */
    private static Set<String> listenerPackages(Context c) {
        Set<String> out = new HashSet<>();
        try { out.addAll(NotificationManagerCompat.getEnabledListenerPackages(c)); } catch (Exception ignored) { }
        return out;
    }

    /* ---------- device ---------- */

    private JSObject deviceInfo(Context c, PackageManager pm) {
        JSObject d = new JSObject();
        d.put("manufacturer", Build.MANUFACTURER);
        d.put("brand", Build.BRAND);
        d.put("model", Build.MODEL);
        d.put("android", Build.VERSION.RELEASE);
        d.put("sdk", Build.VERSION.SDK_INT);
        d.put("securityPatch", orNull(emptyToNull(Build.VERSION.SECURITY_PATCH)));

        Boolean lock = null;
        try {
            KeyguardManager km = (KeyguardManager) c.getSystemService(Context.KEYGUARD_SERVICE);
            if (km != null) lock = km.isDeviceSecure();
        } catch (Exception ignored) { }
        d.put("screenLock", orNull(lock));

        ContentResolver cr = c.getContentResolver();
        d.put("devOptions", orNull(globalFlag(cr, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED)));
        d.put("adb", orNull(globalFlag(cr, Settings.Global.ADB_ENABLED)));
        // Android 11+ wireless debugging; a hidden setting, so null where Android won't let apps read it.
        d.put("adbWifi", orNull(Build.VERSION.SDK_INT >= 30 ? globalFlag(cr, "adb_wifi_enabled") : null));

        JSArray hints = new JSArray();
        for (String h : rootHints(pm)) hints.put(h);
        d.put("rootHints", hints);

        String enc = encryption(c);
        d.put("encryption", orNull(enc));
        Boolean encrypted = enc == null || "activating".equals(enc) ? null : (Boolean) enc.startsWith("active");
        d.put("encrypted", orNull(encrypted));
        return d;
    }

    /** A Settings.Global on/off value (missing = off), or null when it can't be read. */
    private static Boolean globalFlag(ContentResolver cr, String key) {
        try { return Settings.Global.getInt(cr, key, 0) != 0; } catch (Exception e) { return null; }
    }

    @SuppressWarnings("deprecation")   // ENCRYPTION_STATUS_ACTIVATING: still returned by older phones
    private static String encryption(Context c) {
        try {
            DevicePolicyManager dpm = (DevicePolicyManager) c.getSystemService(Context.DEVICE_POLICY_SERVICE);
            if (dpm == null) return null;
            switch (dpm.getStorageEncryptionStatus()) {
                case DevicePolicyManager.ENCRYPTION_STATUS_ACTIVE: return "active";
                case DevicePolicyManager.ENCRYPTION_STATUS_ACTIVE_PER_USER: return "activePerUser";
                case DevicePolicyManager.ENCRYPTION_STATUS_ACTIVE_DEFAULT_KEY: return "activeDefaultKey";
                case DevicePolicyManager.ENCRYPTION_STATUS_ACTIVATING: return "activating";
                case DevicePolicyManager.ENCRYPTION_STATUS_INACTIVE: return "inactive";
                case DevicePolicyManager.ENCRYPTION_STATUS_UNSUPPORTED: return "unsupported";
                default: return null;
            }
        } catch (Exception e) {
            return null;
        }
    }

    /** Plain-English signs of root. Empty when none were found (which doesn't prove there is no root). */
    private static List<String> rootHints(PackageManager pm) {
        List<String> out = new ArrayList<>();
        LinkedHashSet<String> su = new LinkedHashSet<>();
        Collections.addAll(su, SU_PATHS);
        try {
            String path = System.getenv("PATH");
            if (path != null) for (String dir : path.split(":")) {
                if (!dir.isEmpty()) su.add(dir.endsWith("/") ? dir + "su" : dir + "/su");
            }
        } catch (Exception ignored) { }
        for (String p : su) if (exists(p)) out.add("su binary at " + p);
        for (String p : ROOT_PATHS) if (exists(p)) out.add("root tool files at " + p);
        for (String[] app : ROOT_APPS) if (installed(pm, app[0])) out.add("root manager app installed: " + app[1] + " (" + app[0] + ")");
        String tags = Build.TAGS;
        if (tags != null && tags.contains("test-keys")) out.add("the system software is signed with test keys (a custom or modified Android build)");
        return out;
    }

    /* =====================================================================================
     * Actions: uninstall dialog and settings pages
     * ===================================================================================== */

    @PluginMethod
    public void uninstall(PluginCall call) {
        String pkg = pkgArg(call);
        if (pkg == null) { call.reject("No app given.", "BAD_ARGS"); return; }
        try {
            Context c = ctx();
            if (pkg.equals(c.getPackageName())) { call.reject("TwinGaze can't remove itself from here.", "SELF"); return; }
            PackageInfo pi;
            try { pi = pkgInfo(c.getPackageManager(), pkg, 0); }
            catch (PackageManager.NameNotFoundException e) { call.reject("That app is not installed any more.", "NOT_INSTALLED"); return; }

            JSObject r = new JSObject();
            // An active device admin can't be uninstalled until its admin rights are switched off.
            if (adminPackages(c).contains(pkg)) {
                r.put("started", false);
                r.put("reason", "deviceAdmin");
                call.resolve(r);
                return;
            }
            ApplicationInfo ai = pi.applicationInfo;
            boolean system = ai != null && (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
            boolean updated = ai != null && (ai.flags & ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0;
            if (system && !updated) {                    // part of the system image: can only be disabled
                r.put("started", false);
                r.put("reason", "system");
                call.resolve(r);
                return;
            }
            launch(new Intent(Intent.ACTION_DELETE, Uri.fromParts("package", pkg, null)));
            r.put("started", true);
            if (updated) r.put("updatesOnly", true);     // Android only removes the updates of a system app
            call.resolve(r);
        } catch (ActivityNotFoundException e) {
            call.reject("This phone has no uninstall screen for other apps. Open the app's settings page instead.", "NO_ACTIVITY");
        } catch (Exception e) {
            call.reject("Could not open the uninstall screen: " + msg(e));
        }
    }

    @PluginMethod
    public void isInstalled(PluginCall call) {
        String pkg = pkgArg(call);
        if (pkg == null) { call.reject("No app given.", "BAD_ARGS"); return; }
        try {
            JSObject r = new JSObject();
            r.put("installed", installed(ctx().getPackageManager(), pkg));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not check the app: " + msg(e));
        }
    }

    /* Is any app using the camera or the microphone right now?
     * Cameras: the camera service reports every camera's availability as soon as the callback is
     * registered; a camera held by another app is "unavailable". Microphone: the active recordings
     * on the device (Android hides which app, but not that one is recording).
     * TwinGaze itself holds neither while the phone check runs. */
    @PluginMethod
    public void sensorsInUse(PluginCall call) {
        try {
            final CameraManager cm = (CameraManager) ctx().getSystemService(Context.CAMERA_SERVICE);
            final Map<String, Boolean> avail = Collections.synchronizedMap(new HashMap<>());
            final Handler h = new Handler(Looper.getMainLooper());
            final CameraManager.AvailabilityCallback cb = new CameraManager.AvailabilityCallback() {
                @Override public void onCameraAvailable(String id) { avail.put(id, true); }
                @Override public void onCameraUnavailable(String id) { avail.put(id, false); }
            };
            if (cm != null) cm.registerAvailabilityCallback(cb, h);
            h.postDelayed(() -> {
                JSObject r = new JSObject();
                JSArray cams = new JSArray();
                boolean anyCam = false;
                try {
                    if (cm != null) {
                        cm.unregisterAvailabilityCallback(cb);
                        for (String id : cm.getCameraIdList()) {
                            JSObject c = new JSObject();
                            c.put("id", id);
                            String facing = "other";
                            try {
                                Integer f = cm.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING);
                                if (f != null) facing = f == CameraCharacteristics.LENS_FACING_FRONT ? "front" : f == CameraCharacteristics.LENS_FACING_BACK ? "back" : "external";
                            } catch (Exception ignored) { }
                            c.put("facing", facing);
                            Boolean a = avail.get(id);
                            boolean inUse = a != null && !a;
                            c.put("known", a != null);
                            c.put("inUse", inUse);
                            anyCam |= inUse;
                            cams.put(c);
                        }
                    }
                } catch (Exception e) {
                    r.put("cameraError", msg(e));
                }
                r.put("cameras", cams);
                r.put("cameraInUse", anyCam);
                try {
                    AudioManager am = (AudioManager) ctx().getSystemService(Context.AUDIO_SERVICE);
                    List<AudioRecordingConfiguration> recs = am != null ? am.getActiveRecordingConfigurations() : null;
                    int n = recs == null ? 0 : recs.size();
                    r.put("micInUse", n > 0);
                    r.put("micRecordings", n);
                } catch (Exception e) {
                    r.put("micError", msg(e));
                }
                call.resolve(r);
            }, 700);
        } catch (Exception e) {
            call.reject("Could not check the camera and microphone: " + msg(e));
        }
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        String pkg = pkgArg(call);
        if (pkg == null) { call.reject("No app given.", "BAD_ARGS"); return; }
        List<Intent> tries = new ArrayList<>();
        tries.add(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", pkg, null)));
        tries.add(new Intent(Settings.ACTION_MANAGE_APPLICATIONS_SETTINGS));
        openFirst(call, tries);
    }

    /** page: accessibility | deviceAdmin | developer | notificationAccess | security | lock | update */
    @PluginMethod
    public void openSettings(PluginCall call) {
        String page = call.getString("page", "");
        List<Intent> tries = new ArrayList<>();
        switch (page == null ? "" : page) {
            case "accessibility":
                tries.add(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
                break;
            case "deviceAdmin":
                tries.add(new Intent("android.settings.DEVICE_ADMIN_SETTINGS"));
                tries.add(new Intent().setComponent(new ComponentName("com.android.settings", "com.android.settings.Settings$DeviceAdminSettingsActivity")));
                tries.add(new Intent().setComponent(new ComponentName("com.android.settings", "com.android.settings.DeviceAdminSettings")));
                tries.add(new Intent(Settings.ACTION_SECURITY_SETTINGS));
                break;
            case "developer":
                tries.add(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS));
                break;
            case "notificationAccess":
                tries.add(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
                break;
            case "security":
            case "lock":
                tries.add(new Intent(Settings.ACTION_SECURITY_SETTINGS));
                break;
            case "update":
                tries.add(new Intent("android.settings.SYSTEM_UPDATE_SETTINGS"));   // AOSP + most phone makers
                tries.add(new Intent(Settings.ACTION_DEVICE_INFO_SETTINGS));
                break;
            case "wifi":
                tries.add(new Intent(Settings.ACTION_WIFI_SETTINGS));
                break;
            case "privateDns":                                            // under "Network & internet" on most phones
            case "network":
                tries.add(new Intent(Settings.ACTION_WIRELESS_SETTINGS));
                break;
            case "vpn":
                tries.add(new Intent(Settings.ACTION_VPN_SETTINGS));
                break;
            case "location":
                tries.add(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
                break;
            default:
                call.reject("Unknown settings page: " + page, "BAD_ARGS");
                return;
        }
        tries.add(new Intent(Settings.ACTION_SETTINGS));
        openFirst(call, tries);
    }

    /** Opens the first intent the phone can handle; resolves { opened: <action or component> }. */
    private void openFirst(PluginCall call, List<Intent> tries) {
        PackageManager pm = ctx().getPackageManager();
        for (Intent i : tries) {
            try {
                if (i.resolveActivity(pm) == null) continue;
                launch(i);
                JSObject r = new JSObject();
                r.put("opened", i.getAction() != null ? i.getAction() : i.getComponent() != null ? i.getComponent().flattenToShortString() : "");
                call.resolve(r);
                return;
            } catch (Exception ignored) {
                // not there, or not open to other apps: try the next one
            }
        }
        call.reject("Could not open Android settings.", "NO_ACTIVITY");
    }
}
