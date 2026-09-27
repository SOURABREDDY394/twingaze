package in.teamragnarok.twingaze;

import android.Manifest;
import android.app.StatusBarManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import java.util.Locale;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

/**
 * The app's side of "protection outside the app": turns TwinProtectService on and off, asks for the
 * permissions it needs (notifications, location for the SOS, SMS so the SOS can go without you pressing
 * send), passes it the trusted contacts and the known spy-app list, and hands taps from its
 * notifications (a fake call answered, an alert opened) to the web app.
 */
@CapacitorPlugin(
    name = "TwinProtect",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "sms", strings = { Manifest.permission.SEND_SMS })
    }
)
public class TwinProtectPlugin extends Plugin {

    private SharedPreferences prefs() { return getContext().getSharedPreferences(TwinProtectService.PREFS, Context.MODE_PRIVATE); }

    @Override
    public void load() {
        takeIntent(getActivity().getIntent());
        // protection was on (e.g. the phone restarted, or the system stopped it): turn it back on now the app is open
        if (prefs().getBoolean("on", false) && !TwinProtectService.running) startService(TwinProtectService.ACT_START);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        takeIntent(intent);
    }

    private void takeIntent(Intent i) {
        if (i == null) return;
        String who = i.getStringExtra("twingaze.fakecall");
        if (who != null) {
            i.removeExtra("twingaze.fakecall");
            startService(TwinProtectService.ACT_FAKE_ANSWER);        // stop the ringing
            JSObject d = new JSObject();
            d.put("name", who);
            notifyListeners("fakeAnswer", d, true);
        }
        String open = i.getStringExtra("twingaze.open");
        if (open != null) {
            i.removeExtra("twingaze.open");
            JSObject d = new JSObject();
            d.put("screen", open);
            notifyListeners("open", d, true);
        }
    }

    private void startService(String action) {
        try {
            Intent s = new Intent(getContext(), TwinProtectService.class).setAction(action);
            ContextCompat.startForegroundService(getContext(), s);
        } catch (Exception ignored) { }
    }

    private boolean granted(String p) { return ContextCompat.checkSelfPermission(getContext(), p) == PackageManager.PERMISSION_GRANTED; }

    private JSObject status() {
        SharedPreferences p = prefs();
        JSObject r = new JSObject();
        r.put("on", p.getBoolean("on", false));
        r.put("running", TwinProtectService.running);
        r.put("notifications", Build.VERSION.SDK_INT < 33 || granted(Manifest.permission.POST_NOTIFICATIONS));
        r.put("location", granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION));
        r.put("sms", granted(Manifest.permission.SEND_SMS));
        r.put("telephony", getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY));
        boolean battery = true;
        try { PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE); battery = pm.isIgnoringBatteryOptimizations(getContext().getPackageName()); } catch (Exception ignored) { }
        r.put("unrestricted", battery);
        r.put("oem", autostartPages().length > 0);
        int n = 0;
        try { n = new org.json.JSONArray(p.getString("contacts", "[]")).length(); } catch (Exception ignored) { }
        r.put("contacts", n);
        r.put("lastSos", TwinProtectService.lastSos);
        return r;
    }

    @PluginMethod
    public void status(PluginCall call) { call.resolve(status()); }

    /** { contacts: [{name, phone}], caller, spyPkgs: [...], spyCerts: [...], note, myName } */
    @PluginMethod
    public void configure(PluginCall call) {
        save(call);
        if (TwinProtectService.running) startService(TwinProtectService.ACT_CONFIG);
        call.resolve(status());
    }

    private void save(PluginCall call) {
        SharedPreferences.Editor e = prefs().edit();
        JSArray c = call.getArray("contacts");
        if (c != null) e.putString("contacts", c.toString());
        String caller = call.getString("caller");
        if (caller != null) e.putString("caller", caller);
        JSArray sp = call.getArray("spyPkgs");
        if (sp != null) e.putString("spyPkgs", sp.toString());
        JSArray sc = call.getArray("spyCerts");
        if (sc != null) e.putString("spyCerts", sc.toString());
        String note = call.getString("note");
        if (note != null) e.putString("note", note);
        String me = call.getString("myName");
        if (me != null) e.putString("myName", me);
        e.apply();
    }

    /** Turns protection on: asks for what it needs, then starts the service (SMS is optional). */
    @PluginMethod
    public void start(PluginCall call) {
        save(call);
        java.util.List<String> need = new java.util.ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) need.add("notifications");
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) need.add("location");
        if (!granted(Manifest.permission.SEND_SMS)) need.add("sms");
        if (need.isEmpty()) { begin(call); return; }
        requestPermissionForAliases(need.toArray(new String[0]), call, "startPerms");
    }

    @PermissionCallback
    private void startPerms(PluginCall call) { begin(call); }

    private void begin(PluginCall call) {
        prefs().edit().putBoolean("on", true).apply();
        startService(TwinProtectService.ACT_START);
        getBridge().executeOnMainThread(() -> call.resolve(status()));
    }

    /** "Allow notifications" / "Allow SMS": asks again; if Android no longer shows the prompt (denied
     *  twice), opens TwinGaze's page in the phone's settings. what: "notifications" | "sms" | "location" */
    @PluginMethod
    public void allow(PluginCall call) {
        String what = call.getString("what", "notifications");
        String perm = "sms".equals(what) ? Manifest.permission.SEND_SMS : "location".equals(what) ? Manifest.permission.ACCESS_FINE_LOCATION
            : Build.VERSION.SDK_INT >= 33 ? Manifest.permission.POST_NOTIFICATIONS : null;
        if (perm == null || granted(perm)) { call.resolve(status()); return; }
        requestPermissionForAlias(what, call, "allowPerms");
    }

    @PermissionCallback
    private void allowPerms(PluginCall call) {
        String what = call.getString("what", "notifications");
        String perm = "sms".equals(what) ? Manifest.permission.SEND_SMS : "location".equals(what) ? Manifest.permission.ACCESS_FINE_LOCATION : Manifest.permission.POST_NOTIFICATIONS;
        if (!granted(perm)) {
            try {
                Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(i);
            } catch (Exception ignored) { }
        } else if (TwinProtectService.running) startService(TwinProtectService.ACT_CONFIG);   // show the notification now
        call.resolve(status());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        prefs().edit().putBoolean("on", false).apply();
        try { getContext().stopService(new Intent(getContext(), TwinProtectService.class)); } catch (Exception ignored) { }
        call.resolve(status());
    }

    /** Runs the whole SOS (countdown, location) but only reports what it would send. */
    @PluginMethod
    public void testSos(PluginCall call) {
        try {
            Intent s = new Intent(getContext(), TwinProtectService.class).setAction(TwinProtectService.ACT_SOS)
                .putExtra("dryRun", true).putExtra("why", "test");
            ContextCompat.startForegroundService(getContext(), s);
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    /** The fake call rung by the service, so it still rings if you leave the app. */
    @PluginMethod
    public void fakeCall(PluginCall call) {
        Integer d = call.getInt("delay", 10);
        String who = call.getString("caller");
        if (who != null) prefs().edit().putString("caller", who).apply();
        try {
            Intent s = new Intent(getContext(), TwinProtectService.class).setAction(TwinProtectService.ACT_FAKE).putExtra("delay", d == null ? 10 : d);
            ContextCompat.startForegroundService(getContext(), s);
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    /** Xiaomi, vivo/iQOO and OPPO also stop apps that aren't on their own "Autostart" list. */
    private static ComponentName[] autostartPages() {
        String m = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase(Locale.ROOT);
        if (m.contains("xiaomi") || m.contains("redmi") || m.contains("poco"))
            return new ComponentName[] { new ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity") };
        if (m.contains("vivo") || m.contains("iqoo"))
            return new ComponentName[] { new ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
                new ComponentName("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager") };
        if (m.contains("oppo") || m.contains("realme") || m.contains("oneplus"))
            return new ComponentName[] { new ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity") };
        return new ComponentName[0];
    }

    /** First Android's battery exemption; once that is given, the phone maker's Autostart page. */
    @PluginMethod
    public void allowBackground(PluginCall call) {
        JSObject r = new JSObject();
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        boolean exempt = pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        if (!exempt) {
            try {
                getActivity().startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName())));
                r.put("opened", "battery"); call.resolve(r); return;
            } catch (Exception ignored) { }
        }
        for (ComponentName c : autostartPages()) {
            try {
                getActivity().startActivity(new Intent().setComponent(c).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                r.put("opened", "autostart"); call.resolve(r); return;
            } catch (Exception ignored) { }
        }
        try {
            getActivity().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName())));
            r.put("opened", "details");
        } catch (Exception e) {
            try { getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); r.put("opened", "battery-list"); } catch (Exception ignored) { }
        }
        call.resolve(r);
    }

    /** Android 13+: the system's own "Add this tile to Quick Settings?" dialog. */
    @PluginMethod
    public void addTile(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33) { JSObject r = new JSObject(); r.put("added", false); r.put("manual", true); call.resolve(r); return; }
        try {
            StatusBarManager sbm = getContext().getSystemService(StatusBarManager.class);
            sbm.requestAddTileService(new ComponentName(getContext(), TwinSosTile.class), "SOS",
                Icon.createWithResource(getContext(), R.drawable.ic_stat_twingaze), getContext().getMainExecutor(), result -> {
                    JSObject r = new JSObject();
                    r.put("added", result == StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ADDED || result == StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ALREADY_ADDED);
                    r.put("result", result);
                    call.resolve(r);
                });
        } catch (Exception e) { call.reject(e.getMessage()); }
    }
}
