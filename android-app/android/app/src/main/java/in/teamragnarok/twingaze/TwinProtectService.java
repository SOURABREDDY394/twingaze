package in.teamragnarok.twingaze;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.content.pm.Signature;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.hardware.camera2.CameraManager;
import android.location.Location;
import android.location.LocationManager;
import android.media.AudioManager;
import android.media.AudioRecordingConfiguration;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.ProxyInfo;
import android.net.Uri;
import android.net.wifi.WifiInfo;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.telephony.SmsManager;
import android.telephony.SubscriptionManager;

import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Protection that keeps working when TwinGaze is closed. A foreground service (Android requires the
 * notification that says it is running) that:
 *  - opens SOS when the power button is pressed 3 times quickly (works with the screen off and locked),
 *    or the phone is shaken hard while the screen is on: a 5-second countdown you can cancel, then an SMS
 *    with your location to your trusted contacts (or, without the SMS permission, a text ready to send);
 *  - rings a fake incoming call from its notification;
 *  - warns when the camera or microphone is used while the screen is off (stalkerware records then,
 *    and Android's green / orange dot is invisible), when a known spy app or a hidden app with
 *    sensitive permissions is installed, and when the phone joins an open Wi-Fi or one with a proxy.
 * Settings come from the app (TwinProtectPlugin) through SharedPreferences.
 */
public class TwinProtectService extends Service implements SensorEventListener {

    static final String PKG = "in.teamragnarok.twingaze";
    static final String ACT_START = PKG + ".PROTECT_START", ACT_STOP = PKG + ".PROTECT_STOP", ACT_CONFIG = PKG + ".PROTECT_CONFIG";
    static final String ACT_SOS = PKG + ".SOS", ACT_SOS_CANCEL = PKG + ".SOS_CANCEL";
    static final String ACT_FAKE = PKG + ".FAKE_CALL", ACT_FAKE_ANSWER = PKG + ".FAKE_ANSWER", ACT_FAKE_DECLINE = PKG + ".FAKE_DECLINE";
    static final String PREFS = "twingaze-protect";
    static final String CH_ON = "protect", CH_ALERT = "alerts", CH_SOS = "sos", CH_CALL = "fakecall";
    static final int NID_ON = 71, NID_SOS = 72, NID_CALL = 73, NID_SENT = 74;
    static final int COUNTDOWN_S = 5;

    static volatile boolean running = false;
    private boolean watching = false;
    static volatile String lastSos = null;           // what the last SOS did, for the app to show

    private final Handler main = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private SensorManager sensors;
    private PowerManager power;
    private Vibrator vibrator;

    /* ---------- lifecycle ---------- */

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        sensors = (SensorManager) getSystemService(SENSOR_SERVICE);
        power = (PowerManager) getSystemService(POWER_SERVICE);
        vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        channels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent == null ? ACT_START : String.valueOf(intent.getAction());
        if (ACT_STOP.equals(a)) { prefs.edit().putBoolean("on", false).apply(); stopSelf(); return START_NOT_STICKY; }
        if (!running) {
            if (!goForeground()) { stopSelf(); return START_NOT_STICKY; }
            running = true;
            if (prefs.getBoolean("on", false)) { watching = true; watchAll(); }
        }
        switch (a) {
            case ACT_START:
            case ACT_CONFIG:
                if (watching) unwatchAll();
                watching = prefs.getBoolean("on", false);
                if (watching) watchAll();
                notifyOn();
                break;
            case ACT_SOS: startSos(intent.getStringExtra("why"), intent.getBooleanExtra("dryRun", false)); break;
            case ACT_SOS_CANCEL: cancelSos(); break;
            case ACT_FAKE: scheduleFake(intent.getIntExtra("delay", 10)); break;
            case ACT_FAKE_ANSWER: answerFake(); break;
            case ACT_FAKE_DECLINE: endFake(); break;
            default: break;
        }
        return prefs.getBoolean("on", false) ? START_STICKY : START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        letCpuSleep();
        if (watching) unwatchAll();
        watching = false;
        cancelSos();
        endFake();
        super.onDestroy();
    }

    /** Location type when allowed (the SOS reads your location), else "special use" (a safety app). */
    private boolean goForeground() {
        Notification n = onNotification();
        if (Build.VERSION.SDK_INT >= 29 && hasLocation()) {
            try { startForeground(NID_ON, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION); return true; } catch (Exception ignored) { }
        }
        if (Build.VERSION.SDK_INT >= 34) {
            try { startForeground(NID_ON, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE); return true; } catch (Exception ignored) { }
            return false;
        }
        try { startForeground(NID_ON, n); return true; } catch (Exception e) { return false; }
    }

    /* ---------- notifications ---------- */

    private NotificationManager nm() { return (NotificationManager) getSystemService(NOTIFICATION_SERVICE); }

    private void channels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager m = nm();
        NotificationChannel on = new NotificationChannel(CH_ON, "Protection is on", NotificationManager.IMPORTANCE_LOW);
        on.setDescription("Shows while TwinGaze protects you outside the app");
        on.setShowBadge(false);
        m.createNotificationChannel(on);
        NotificationChannel al = new NotificationChannel(CH_ALERT, "Privacy alerts", NotificationManager.IMPORTANCE_HIGH);
        al.setDescription("Camera or microphone used while the screen was off, spy apps, unsafe Wi-Fi");
        m.createNotificationChannel(al);
        NotificationChannel sos = new NotificationChannel(CH_SOS, "SOS", NotificationManager.IMPORTANCE_HIGH);
        sos.setDescription("SOS countdown and messages sent");
        sos.setBypassDnd(true);
        m.createNotificationChannel(sos);
        NotificationChannel call = new NotificationChannel(CH_CALL, "Fake call", NotificationManager.IMPORTANCE_HIGH);
        call.setDescription("The fake incoming call");
        call.setSound(null, null);                  // the service plays the ringtone itself
        m.createNotificationChannel(call);
    }

    private PendingIntent svc(String action, int code) {
        Intent i = new Intent(this, TwinProtectService.class).setAction(action);
        int f = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return Build.VERSION.SDK_INT >= 26 ? PendingIntent.getForegroundService(this, code, i, f) : PendingIntent.getService(this, code, i, f);
    }

    private PendingIntent openApp(String extra, String value, int code) {
        Intent i = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (extra != null) i.putExtra(extra, value);
        return PendingIntent.getActivity(this, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification.Builder builder(String channel) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, channel) : new Notification.Builder(this);
        return b.setSmallIcon(R.drawable.ic_stat_twingaze).setColor(0xFFEE3A4F);
    }

    private Notification onNotification() {
        if (!prefs.getBoolean("on", false)) {
            return builder(CH_ON).setContentTitle("TwinGaze").setContentText("Fake call or SOS test in progress")
                .setOngoing(true).setShowWhen(false).setContentIntent(openApp(null, null, 1)).build();
        }
        List<String> how = new ArrayList<>();
        if (prefs.getBoolean("power", true)) how.add("press power 3×");
        if (prefs.getBoolean("shake", true)) how.add("shake hard");
        String text = how.isEmpty() ? "SOS from this notification" : "SOS: " + String.join(" or ", how) + ", even with the app closed";
        Notification.Builder b = builder(CH_ON)
            .setContentTitle("TwinGaze protection is on")
            .setContentText(text)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(openApp(null, null, 1))
            .addAction(new Notification.Action.Builder(null, "SOS", svc(ACT_SOS, 2)).build())
            .addAction(new Notification.Action.Builder(null, "Fake call", svc(ACT_FAKE, 3)).build());
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return b.build();
    }

    private void notifyOn() { try { nm().notify(NID_ON, onNotification()); } catch (Exception ignored) { } }

    private void alert(int id, String title, String text, PendingIntent tap) {
        try {
            nm().notify(id, builder(CH_ALERT).setContentTitle(title).setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text)).setAutoCancel(true)
                .setContentIntent(tap != null ? tap : openApp("twingaze.open", "guard", 10)).build());
        } catch (Exception ignored) { }
    }

    private void vibrate(long[] pattern) {
        try {
            if (vibrator == null) return;
            long[] t = new long[pattern.length + 1];
            System.arraycopy(pattern, 0, t, 1, pattern.length);
            if (Build.VERSION.SDK_INT >= 26) vibrator.vibrate(VibrationEffect.createWaveform(t, -1));
            else vibrator.vibrate(t, -1);
        } catch (Exception ignored) { }
    }

    /* ---------- watching ---------- */

    private BroadcastReceiver screenRx, pkgRx;
    private CameraManager.AvailabilityCallback camCb;
    private AudioManager.AudioRecordingCallback micCb;
    private ConnectivityManager.NetworkCallback netCb;
    private boolean accelOn = false;

    private void watchAll() {
        // screen on/off: counts power-button presses, and turns the shake detector on only while the screen is on
        screenRx = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) { onScreen(Intent.ACTION_SCREEN_ON.equals(i.getAction())); }
        };
        IntentFilter sf = new IntentFilter();
        sf.addAction(Intent.ACTION_SCREEN_ON);
        sf.addAction(Intent.ACTION_SCREEN_OFF);
        ContextCompat.registerReceiver(this, screenRx, sf, ContextCompat.RECEIVER_NOT_EXPORTED);
        if (prefs.getBoolean("shake", true) && power != null && power.isInteractive()) accel(true);

        if (prefs.getBoolean("sensors", true)) watchSensors();
        if (prefs.getBoolean("apps", true)) {
            pkgRx = new BroadcastReceiver() { @Override public void onReceive(Context c, Intent i) { onPackageAdded(i); } };
            IntentFilter pf = new IntentFilter(Intent.ACTION_PACKAGE_ADDED);
            pf.addDataScheme("package");
            ContextCompat.registerReceiver(this, pkgRx, pf, ContextCompat.RECEIVER_EXPORTED);   // a protected system broadcast
        }
        if (prefs.getBoolean("wifi", true)) watchWifi();
    }

    private void unwatchAll() {
        accel(false);
        try { if (screenRx != null) unregisterReceiver(screenRx); } catch (Exception ignored) { }
        try { if (pkgRx != null) unregisterReceiver(pkgRx); } catch (Exception ignored) { }
        screenRx = pkgRx = null;
        try { if (camCb != null) ((CameraManager) getSystemService(CAMERA_SERVICE)).unregisterAvailabilityCallback(camCb); } catch (Exception ignored) { }
        try { if (micCb != null) ((AudioManager) getSystemService(AUDIO_SERVICE)).unregisterAudioRecordingCallback(micCb); } catch (Exception ignored) { }
        try { if (netCb != null) ((ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE)).unregisterNetworkCallback(netCb); } catch (Exception ignored) { }
        camCb = null; micCb = null; netCb = null;
    }

    /* ---------- trigger 1: the power button pressed 3 times within 3 seconds ---------- */

    private final long[] presses = new long[3];
    private int pressN = 0;

    private void onScreen(boolean on) {
        if (prefs.getBoolean("shake", true)) accel(on);             // the motion sensor sleeps with the screen
        if (on) screenOffAt = 0; else screenOffAt = SystemClock.elapsedRealtime();
        if (!prefs.getBoolean("power", true)) return;
        try {
            int mode = ((AudioManager) getSystemService(AUDIO_SERVICE)).getMode();
            if (mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION || mode == AudioManager.MODE_RINGTONE) { pressN = 0; return; }
        } catch (Exception ignored) { }
        long now = SystemClock.elapsedRealtime();
        presses[pressN % 3] = now;
        pressN++;
        if (pressN >= 3) {
            long oldest = presses[pressN % 3];                      // the press 3 back
            if (now - oldest < 3000) { pressN = 0; startSos("power button", false); }
        }
    }

    /* ---------- trigger 2: three hard shakes (over 2.6 g) within 1.6 s, screen on ---------- */

    private final long[] peaks = new long[3];
    private int peakN = 0;
    private long lastPeak = 0, lastShakeSos = 0;

    private void accel(boolean on) {
        if (sensors == null) return;
        if (on && !accelOn) {
            Sensor s = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            if (s != null) accelOn = sensors.registerListener(this, s, SensorManager.SENSOR_DELAY_GAME);
        } else if (!on && accelOn) { sensors.unregisterListener(this); accelOn = false; }
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        float x = e.values[0], y = e.values[1], z = e.values[2];
        double m = Math.sqrt(x * x + y * y + z * z);
        if (m < 25.5) return;
        long t = SystemClock.elapsedRealtime();
        if (t - lastPeak < 150) return;                            // the same jolt
        lastPeak = t;
        peaks[peakN % 3] = t;
        peakN++;
        if (peakN >= 3 && t - peaks[peakN % 3] < 1600 && t - lastShakeSos > 8000 && sosAt == 0) {
            peakN = 0; lastShakeSos = t;
            startSos("shake", false);
        }
    }

    @Override public void onAccuracyChanged(Sensor s, int a) { }

    /* ---------- SOS: countdown, location, SMS ---------- */

    private long sosAt = 0;
    private boolean sosDry = false;
    private String sosWhy = null;
    private final Runnable sosTick = this::sosTick;

    private PowerManager.WakeLock cpu;
    private boolean locating = false;

    private void holdCpu(long ms) {
        try {
            if (power == null) return;
            if (cpu == null) { cpu = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TwinGaze:wait"); cpu.setReferenceCounted(false); }
            cpu.acquire(ms);
        } catch (Exception ignored) { }
    }

    private void letCpuSleep() { try { if (cpu != null && cpu.isHeld()) cpu.release(); } catch (Exception ignored) { } }

    private void startSos(String why, boolean dry) {
        if (sosAt != 0) return;                                     // already counting down
        holdCpu((COUNTDOWN_S + 40) * 1000L);                        // countdown + location fix + sending
        sosAt = SystemClock.elapsedRealtime();
        sosDry = dry;
        sosWhy = why == null ? "button" : why;
        vibrate(new long[] { 400, 150, 400, 150, 400 });
        sosTick();
    }

    private void sosTick() {
        if (sosAt == 0) return;
        int left = COUNTDOWN_S - (int) ((SystemClock.elapsedRealtime() - sosAt) / 1000);
        if (left <= 0) { main.removeCallbacks(sosTick); sosAt = 0; nm().cancel(NID_SOS); sendSos(); return; }
        List<JSONObject> cs = contacts();
        String who = cs.isEmpty() ? "No trusted contact yet" : "To " + names(cs);
        try {
            nm().notify(NID_SOS, builder(CH_SOS)
                .setContentTitle("SOS in " + left + " s" + (sosDry ? " (test)" : ""))
                .setContentText(who + ": your location. Tap Cancel if this was a mistake.")
                .setOngoing(true).setOnlyAlertOnce(false)
                .setCategory(Notification.CATEGORY_ALARM)
                .addAction(new Notification.Action.Builder(null, "Cancel", svc(ACT_SOS_CANCEL, 20)).build())
                .setContentIntent(svc(ACT_SOS_CANCEL, 21))
                .build());
        } catch (Exception ignored) { }
        if (left < COUNTDOWN_S) vibrate(new long[] { 250 });
        main.postDelayed(sosTick, 1000);
    }

    private void cancelSos() {
        if (sosAt == 0) return;
        sosAt = 0;
        main.removeCallbacks(sosTick);
        nm().cancel(NID_SOS);
        lastSos = "cancelled at " + clock();
        vibrate(new long[] { 60 });
        maybeStop();
    }

    private void sendSos() {
        vibrate(new long[] { 600 });
        final boolean dry = sosDry;
        locating = true;
        getLocation(loc -> {
            locating = false;
            String text = sosText(loc);
            List<JSONObject> cs = contacts();
            boolean canSms = !cs.isEmpty() && prefs.getBoolean("sms", true)
                && ContextCompat.checkSelfPermission(this, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED;
            String result;
            if (canSms && !dry) {
                int ok = 0;
                for (JSONObject c : cs) {
                    try {
                        SmsManager sm = smsManager();
                        ArrayList<String> parts = sm.divideMessage(text);
                        sm.sendMultipartTextMessage(c.optString("phone"), null, parts, null, null);
                        ok++;
                    } catch (Exception ignored) { }
                }
                result = ok > 0 ? "SOS sent to " + names(cs) + " at " + clock() + (loc != null ? " with your location" : " (location unavailable)")
                    : "SOS could not be sent by SMS. Tap to send it yourself.";
            } else if (dry) {
                result = "Test: SOS would go to " + (cs.isEmpty() ? "nobody (add a trusted contact)" : names(cs)) + (canSms ? " by SMS" : " (SMS not allowed: a text opens instead)") + (loc != null ? ", with your location" : ", location unavailable");
            } else {
                result = cs.isEmpty() ? "No trusted contact: tap to send your location to someone" : "Tap to send the SOS text (SMS permission is off)";
            }
            lastSos = result + " · " + sosWhy;
            Uri to = Uri.parse("smsto:" + (cs.isEmpty() ? "" : joinPhones(cs)));
            Intent sms = new Intent(Intent.ACTION_SENDTO, to).putExtra("sms_body", text).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent tapSms = PendingIntent.getActivity(this, 30, sms, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Intent dial = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:112")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent call112 = PendingIntent.getActivity(this, 31, dial, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            try {
                nm().notify(NID_SENT, builder(CH_SOS).setContentTitle(canSms && !dry ? "SOS sent" : dry ? "SOS test" : "SOS ready to send")
                    .setContentText(result).setStyle(new Notification.BigTextStyle().bigText(result + "\n\n" + text))
                    .setAutoCancel(true).setContentIntent(canSms && !dry ? call112 : tapSms)
                    .addAction(new Notification.Action.Builder(null, "Call 112", call112).build())
                    .addAction(new Notification.Action.Builder(null, "Send again", tapSms).build())
                    .build());
            } catch (Exception ignored) { }
            maybeStop();
        });
    }

    private SmsManager smsManager() {
        SmsManager base = Build.VERSION.SDK_INT >= 31 ? getSystemService(SmsManager.class) : SmsManager.getDefault();
        try {
            int sub = SubscriptionManager.getDefaultSmsSubscriptionId();
            if (sub == SubscriptionManager.INVALID_SUBSCRIPTION_ID) sub = SubscriptionManager.getDefaultVoiceSubscriptionId();
            if (sub != SubscriptionManager.INVALID_SUBSCRIPTION_ID)
                return Build.VERSION.SDK_INT >= 31 ? base.createForSubscriptionId(sub) : SmsManager.getSmsManagerForSubscriptionId(sub);
        } catch (Exception ignored) { }
        return base;
    }

    private String sosText(Location loc) {
        String name = prefs.getString("myName", "");
        StringBuilder b = new StringBuilder("SOS from TwinGaze").append(name.isEmpty() ? "" : " (" + name + ")").append(": I need help. Please call me now.");
        if (loc != null) b.append(String.format(Locale.US, "\nMy location (%s): https://maps.google.com/?q=%.6f,%.6f (±%d m)",
            clock(), loc.getLatitude(), loc.getLongitude(), Math.round(loc.getAccuracy())));
        else b.append("\nMy location was unavailable (").append(clock()).append(").");
        String note = prefs.getString("note", "");
        if (!note.isEmpty()) b.append("\n").append(note);
        return b.toString();
    }

    interface LocCb { void got(Location l); }

    /** A fresh fix (up to 8 s), else the last known one from the past 10 minutes, else null. */
    private void getLocation(LocCb cb) {
        final LocationManager lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        final boolean[] done = { false };
        final Location[] last = { null };
        Runnable give = () -> { if (!done[0]) { done[0] = true; cb.got(last[0]); } };
        if (lm == null || !hasLocation()) { cb.got(null); return; }
        try {
            for (String p : lm.getProviders(true)) {
                @SuppressWarnings("MissingPermission") Location l = lm.getLastKnownLocation(p);
                if (l != null && System.currentTimeMillis() - l.getTime() < 600000 && (last[0] == null || l.getAccuracy() < last[0].getAccuracy())) last[0] = l;
            }
        } catch (SecurityException ignored) { }
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                String prov = Build.VERSION.SDK_INT >= 31 && lm.hasProvider(LocationManager.FUSED_PROVIDER) ? LocationManager.FUSED_PROVIDER
                    : lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ? LocationManager.GPS_PROVIDER : LocationManager.NETWORK_PROVIDER;
                CancellationSignal cancel = new CancellationSignal();
                lm.getCurrentLocation(prov, cancel, ContextCompat.getMainExecutor(this), l -> { if (l != null) last[0] = l; main.post(give); });
                main.postDelayed(() -> { cancel.cancel(); give.run(); }, 8000);
                return;
            } catch (SecurityException | IllegalArgumentException ignored) { }
        } else {
            try {
                String prov = lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) ? LocationManager.NETWORK_PROVIDER : LocationManager.GPS_PROVIDER;
                final android.location.LocationListener one = new android.location.LocationListener() {
                    @Override public void onLocationChanged(Location l) { if (l != null) last[0] = l; main.post(give); }
                    @Override public void onStatusChanged(String p, int st, android.os.Bundle b) { }
                    @Override public void onProviderEnabled(String p) { }
                    @Override public void onProviderDisabled(String p) { }
                };
                lm.requestSingleUpdate(prov, one, Looper.getMainLooper());
                main.postDelayed(() -> { try { lm.removeUpdates(one); } catch (Exception ignored) { } give.run(); }, 8000);
                return;
            } catch (SecurityException | IllegalArgumentException ignored) { }
        }
        give.run();
    }

    private boolean hasLocation() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private List<JSONObject> contacts() {
        List<JSONObject> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(prefs.getString("contacts", "[]"));
            for (int i = 0; i < a.length() && out.size() < 3; i++) {
                JSONObject c = a.getJSONObject(i);
                if (!c.optString("phone").isEmpty()) out.add(c);
            }
        } catch (Exception ignored) { }
        return out;
    }

    private static String names(List<JSONObject> cs) {
        List<String> n = new ArrayList<>();
        for (JSONObject c : cs) n.add(c.optString("name").isEmpty() ? c.optString("phone") : c.optString("name"));
        return String.join(", ", n);
    }

    private static String joinPhones(List<JSONObject> cs) {
        List<String> n = new ArrayList<>();
        for (JSONObject c : cs) n.add(c.optString("phone"));
        return String.join(",", n);
    }

    private static String clock() { return new SimpleDateFormat("d MMM, h:mm a", Locale.ENGLISH).format(new Date()); }

    /* ---------- fake incoming call ---------- */

    private Ringtone ring;
    private boolean fakePending = false;          // a fake call is waiting to ring
    private final Runnable ringNow = this::ringFake;
    private final Runnable ringBuzz = this::buzz;
    private final Runnable missed = this::endFake;

    private void scheduleFake(int delay) {
        endFake();
        holdCpu((Math.max(0, delay) + 60) * 1000L);                 // the wait + 45 s of ringing
        fakePending = true;
        main.postDelayed(ringNow, Math.max(0, delay) * 1000L);
        alert(NID_CALL, "Fake call in " + delay + " s", "Put the phone away: it will ring like a real call from " + prefs.getString("caller", "Mom") + ".", svc(ACT_FAKE_DECLINE, 40));
    }

    private void ringFake() {
        fakePending = false;
        String who = prefs.getString("caller", "Mom");
        try {
            Uri u = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_RINGTONE);
            if (u == null) u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            ring = RingtoneManager.getRingtone(this, u);
            if (ring != null) { if (Build.VERSION.SDK_INT >= 28) ring.setLooping(true); ring.play(); }
        } catch (Exception ignored) { }
        buzz();
        try {
            nm().notify(NID_CALL, builder(CH_CALL).setContentTitle(who).setContentText("Incoming call")
                .setCategory(Notification.CATEGORY_CALL).setOngoing(true)
                .setContentIntent(openApp("twingaze.fakecall", who, 41))
                .addAction(new Notification.Action.Builder(null, "Decline", svc(ACT_FAKE_DECLINE, 42)).build())
                .addAction(new Notification.Action.Builder(null, "Answer", openApp("twingaze.fakecall", who, 43)).build())
                .build());
        } catch (Exception ignored) { }
        main.postDelayed(missed, 45000);                           // like a real missed call
    }

    private void buzz() { vibrate(new long[] { 800, 600, 800 }); main.postDelayed(ringBuzz, 2400); }

    private void stopRing() {
        main.removeCallbacks(ringNow); main.removeCallbacks(ringBuzz); main.removeCallbacks(missed);
        fakePending = false;
        if (ring != null) { try { ring.stop(); } catch (Exception ignored) { } ring = null; }
        try { if (vibrator != null) vibrator.cancel(); } catch (Exception ignored) { }
    }

    /* Answer opens the app (its call screen has the timer); the app then tells us to stop ringing */
    private void answerFake() { stopRing(); try { nm().cancel(NID_CALL); } catch (Exception ignored) { } maybeStop(); }

    private void endFake() { stopRing(); try { nm().cancel(NID_CALL); } catch (Exception ignored) { } maybeStop(); }

    /** Protection off, and no call or SOS pending: the service was only here for that, so it goes. */
    private void maybeStop() {
        if (sosAt == 0 && ring == null && !fakePending && !locating) letCpuSleep();
        main.postDelayed(() -> {
            if (!prefs.getBoolean("on", false) && sosAt == 0 && ring == null && !fakePending) stopSelf();
        }, 1500);
    }

    /* ---------- camera / microphone used while the screen is off ---------- */

    private long screenOffAt = 0, camFrom = 0, micFrom = 0;

    private boolean screenOff() { return power != null && !power.isInteractive(); }

    private void watchSensors() {
        try {
            CameraManager cm = (CameraManager) getSystemService(CAMERA_SERVICE);
            camCb = new CameraManager.AvailabilityCallback() {
                @Override public void onCameraUnavailable(String id) { if (screenOff() && camFrom == 0) camFrom = System.currentTimeMillis(); }
                @Override public void onCameraAvailable(String id) {
                    if (camFrom == 0) return;
                    long secs = (System.currentTimeMillis() - camFrom) / 1000;
                    long from = camFrom; camFrom = 0;
                    if (secs >= 2) alert(50, "Camera used while the screen was off",
                        "At " + new SimpleDateFormat("h:mm a", Locale.ENGLISH).format(new Date(from)) + ", for " + secs + " s, an app used the camera while your screen was off. If you didn't expect that, open TwinGaze → Check phone.", null);
                }
            };
            cm.registerAvailabilityCallback(camCb, main);
        } catch (Exception ignored) { }
        try {
            AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
            micCb = new AudioManager.AudioRecordingCallback() {
                @Override public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configs) {
                    int mode = am.getMode();
                    boolean call = mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION;
                    if (configs != null && !configs.isEmpty()) { if (screenOff() && !call && micFrom == 0) micFrom = System.currentTimeMillis(); return; }
                    if (micFrom == 0) return;
                    long secs = (System.currentTimeMillis() - micFrom) / 1000;
                    long from = micFrom; micFrom = 0;
                    if (secs >= 5) alert(51, "Microphone used while the screen was off",
                        "At " + new SimpleDateFormat("h:mm a", Locale.ENGLISH).format(new Date(from)) + ", for " + secs + " s, an app recorded audio while your screen was off and you weren't on a call. If you didn't expect that, open TwinGaze → Check phone.", null);
                }
            };
            am.registerAudioRecordingCallback(micCb, main);
        } catch (Exception ignored) { }
    }

    /* ---------- a spy app or a hidden app installed ---------- */

    private void onPackageAdded(Intent i) {
        if (i.getBooleanExtra(Intent.EXTRA_REPLACING, false) || i.getData() == null) return;
        String pkg = i.getData().getSchemeSpecificPart();
        if (pkg == null || pkg.equals(getPackageName())) return;
        PackageManager pm = getPackageManager();
        String label = pkg;
        try { label = String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0))); } catch (Exception ignored) { }
        Set<String> spyPkgs = jsonSet("spyPkgs"), spyCerts = jsonSet("spyCerts");
        boolean known = spyPkgs.contains(pkg);
        String cert = certSha1(pm, pkg);
        if (!known && cert != null && spyCerts.contains(cert)) known = true;
        if (known) {
            alert(60, "Spy app installed: " + label, label + " (" + pkg + ") is on the list of known stalkerware and monitoring apps. Open TwinGaze → Check phone to remove it.", openApp("twingaze.open", "guard", 61));
            return;
        }
        boolean launcher = pm.getLaunchIntentForPackage(pkg) != null;
        List<String> sens = new ArrayList<>();
        try {
            PackageInfo pi = pm.getPackageInfo(pkg, PackageManager.GET_PERMISSIONS);
            if (pi.requestedPermissions != null) for (String p : pi.requestedPermissions) {
                if (p.endsWith(".RECORD_AUDIO")) sens.add("microphone");
                else if (p.endsWith(".ACCESS_FINE_LOCATION") || p.endsWith(".ACCESS_BACKGROUND_LOCATION")) { if (!sens.contains("location")) sens.add("location"); }
                else if (p.endsWith(".READ_SMS")) sens.add("SMS");
                else if (p.endsWith(".CAMERA")) sens.add("camera");
                else if (p.endsWith(".BIND_ACCESSIBILITY_SERVICE")) sens.add("screen reading");
            }
        } catch (Exception ignored) { }
        if (!launcher && !sens.isEmpty())
            alert(62, "Hidden app installed: " + label, label + " has no app icon but asks for your " + String.join(", ", sens) + ". That is how spy apps hide. Open TwinGaze → Check phone.", openApp("twingaze.open", "guard", 63));
    }

    private Set<String> jsonSet(String key) {
        Set<String> s = new HashSet<>();
        try { JSONArray a = new JSONArray(prefs.getString(key, "[]")); for (int i = 0; i < a.length(); i++) s.add(a.getString(i).toLowerCase(Locale.US)); }
        catch (Exception ignored) { }
        return s;
    }

    @SuppressWarnings("deprecation")
    private static String certSha1(PackageManager pm, String pkg) {
        try {
            Signature[] sigs;
            if (Build.VERSION.SDK_INT >= 28) {
                PackageInfo pi = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES);
                sigs = pi.signingInfo == null ? null : pi.signingInfo.getApkContentsSigners();
            } else sigs = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES).signatures;
            if (sigs == null || sigs.length == 0) return null;
            byte[] d = MessageDigest.getInstance("SHA-1").digest(sigs[0].toByteArray());
            StringBuilder b = new StringBuilder();
            for (byte x : d) b.append(String.format(Locale.US, "%02x", x & 0xff));
            return b.toString();
        } catch (Exception e) { return null; }
    }

    /* ---------- joining an open Wi-Fi, or one with a proxy ---------- */

    private final Set<String> warnedNets = new HashSet<>();

    private void watchWifi() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            NetworkRequest req = new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build();
            netCb = Build.VERSION.SDK_INT >= 31 ? new ConnectivityManager.NetworkCallback(ConnectivityManager.NetworkCallback.FLAG_INCLUDE_LOCATION_INFO) {
                @Override public void onCapabilitiesChanged(Network n, NetworkCapabilities nc) { checkWifi(nc); }
                @Override public void onLinkPropertiesChanged(Network n, LinkProperties lp) { checkProxy(lp); }
            } : new ConnectivityManager.NetworkCallback() {
                @Override public void onLinkPropertiesChanged(Network n, LinkProperties lp) { checkProxy(lp); }
            };
            cm.registerNetworkCallback(req, netCb);
        } catch (Exception ignored) { }
    }

    private void checkWifi(NetworkCapabilities nc) {
        if (Build.VERSION.SDK_INT < 31 || nc == null || !(nc.getTransportInfo() instanceof WifiInfo)) return;
        WifiInfo wi = (WifiInfo) nc.getTransportInfo();
        int t = wi.getCurrentSecurityType();
        String ssid = String.valueOf(wi.getSSID()).replace("\"", "");
        if ("<unknown ssid>".equals(ssid)) ssid = "this Wi-Fi";
        if ((t == 0 || t == 1) && warnedNets.add("sec:" + ssid))
            alert(70, t == 0 ? "Open Wi-Fi: “" + ssid + "”" : "Weak Wi-Fi: “" + ssid + "” uses WEP",
                (t == 0 ? "This Wi-Fi has no password: anyone nearby can see what this phone sends that isn't encrypted, and which sites you visit."
                    : "WEP can be broken in minutes: treat this Wi-Fi as open.") + " Use mobile data for anything private, or a VPN.", openApp("twingaze.open", "net", 71));
    }

    private void checkProxy(LinkProperties lp) {
        if (lp == null) return;
        ProxyInfo px = lp.getHttpProxy();
        if (px == null || px.getHost() == null || px.getHost().isEmpty()) return;
        String key = "proxy:" + px.getHost() + ":" + px.getPort();
        if (warnedNets.add(key))
            alert(72, "Your Wi-Fi traffic goes through a proxy", "This Wi-Fi sends web traffic through " + px.getHost() + ":" + px.getPort() + ". If you didn't set that, someone may be reading it. Remove it in this Wi-Fi's settings (Proxy: None).", openApp("twingaze.open", "net", 73));
    }
}
