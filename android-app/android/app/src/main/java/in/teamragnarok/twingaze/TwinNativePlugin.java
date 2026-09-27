package in.teamragnarok.twingaze;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.hardware.Sensor;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.MediaStore;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.view.WindowManager;

import androidx.activity.OnBackPressedCallback;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * The parts of the phone that Android's WebView doesn't give a web page:
 * magnetometer + light sensor readings, text-to-speech, vibration, keeping the screen on,
 * saving photos/videos to the gallery, the share sheet and the clipboard.
 */
@CapacitorPlugin(name = "TwinNative")
public class TwinNativePlugin extends Plugin implements SensorEventListener {

    private SensorManager sensors;
    private long lastMag = 0, lastLight = 0;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private volatile boolean speaking = false;
    private final Map<String, Uri> openFiles = new HashMap<>();

    @Override
    public void load() {
        sensors = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        tts = new TextToSpeech(getContext(), status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            // spoken like navigation directions: other audio (music) is lowered, not cut, while it talks
            if (ttsReady) try {
                tts.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            } catch (Exception ignored) { }
        });
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { speaking = true; }
            @Override public void onDone(String id) { speaking = false; notifyListeners("ttsDone", new JSObject()); }
            @Override public void onError(String id) { speaking = false; notifyListeners("ttsDone", new JSObject()); }
            @Override public void onStop(String id, boolean interrupted) { speaking = false; }
        });
        // Back (button or gesture) goes to the app, which closes what's open and steps back through its
        // screens; by default the WebView app would simply quit, ending a scan in the middle.
        getActivity().runOnUiThread(() -> getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (hasListeners("backButton")) { notifyListeners("backButton", new JSObject()); return; }
                setEnabled(false);
                getActivity().getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        }));
    }

    /* the app decided Back should leave it (from the home screen) */
    @PluginMethod
    public void exitApp(PluginCall call) {
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
    }

    @Override
    protected void handleOnDestroy() {
        if (sensors != null) sensors.unregisterListener(this);
        if (tts != null) tts.shutdown();
        stopSiren();
        stopRingtone();
        setTorch(false);
    }

    /* ---------- sensors ---------- */

    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        r.put("magnetometer", sensors != null && sensors.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD) != null);
        r.put("light", sensors != null && sensors.getDefaultSensor(Sensor.TYPE_LIGHT) != null);
        r.put("tts", ttsReady);
        r.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        call.resolve(r);
    }

    private static int sensorType(String name) {
        if ("light".equals(name)) return Sensor.TYPE_LIGHT;
        if ("orientation".equals(name)) return Sensor.TYPE_GAME_ROTATION_VECTOR;   // gyro + accelerometer, no compass
        return Sensor.TYPE_MAGNETIC_FIELD;
    }

    @PluginMethod
    public void startSensor(PluginCall call) {
        Sensor s = sensors == null ? null : sensors.getDefaultSensor(sensorType(call.getString("type")));
        if (s == null) { call.reject("sensor not available"); return; }
        sensors.registerListener(this, s, SensorManager.SENSOR_DELAY_GAME);
        call.resolve();
    }

    @PluginMethod
    public void stopSensor(PluginCall call) {
        Sensor s = sensors == null ? null : sensors.getDefaultSensor(sensorType(call.getString("type")));
        if (s != null) sensors.unregisterListener(this, s);
        call.resolve();
    }

    private long lastOri = 0;

    @Override
    public void onSensorChanged(SensorEvent e) {
        long now = System.currentTimeMillis();
        if (e.sensor.getType() == Sensor.TYPE_MAGNETIC_FIELD) {
            if (now - lastMag < 45) return;                 // ~20 readings a second is plenty
            lastMag = now;
            JSObject d = new JSObject();
            d.put("x", e.values[0]); d.put("y", e.values[1]); d.put("z", e.values[2]);
            notifyListeners("magnetometer", d);
        } else if (e.sensor.getType() == Sensor.TYPE_GAME_ROTATION_VECTOR) {
            if (now - lastOri < 45) return;
            lastOri = now;
            float[] q = new float[4];
            SensorManager.getQuaternionFromVector(q, e.values);    // [w, x, y, z]
            JSObject d = new JSObject();
            d.put("x", q[1]); d.put("y", q[2]); d.put("z", q[3]); d.put("w", q[0]);
            notifyListeners("orientation", d);
        } else if (e.sensor.getType() == Sensor.TYPE_LIGHT) {
            if (now - lastLight < 200) return;
            lastLight = now;
            JSObject d = new JSObject();
            d.put("lux", e.values[0]);
            notifyListeners("light", d);
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) { }

    /* ---------- voice ---------- */

    @PluginMethod
    public void speak(PluginCall call) {
        if (!ttsReady) { call.reject("text-to-speech not ready"); return; }
        String text = call.getString("text", "");
        String lang = call.getString("lang", "en-IN");
        Locale loc = Locale.forLanguageTag(lang);
        int ok = tts.isLanguageAvailable(loc);
        android.speech.tts.Voice v = ok >= TextToSpeech.LANG_AVAILABLE ? pickVoice(loc) : null;
        if (v != null) tts.setVoice(v);
        else tts.setLanguage(ok >= TextToSpeech.LANG_AVAILABLE ? loc : new Locale("en", "IN"));
        tts.setSpeechRate(call.getFloat("rate", 1.0f));
        tts.setPitch(1.0f);
        Bundle params = new Bundle();
        speaking = true;
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, "tg" + System.currentTimeMillis());
        JSObject r = new JSObject();
        r.put("languageAvailable", ok >= TextToSpeech.LANG_AVAILABLE);
        call.resolve(r);
    }

    private final Map<String, android.speech.tts.Voice> bestVoice = new HashMap<>();

    /** The clearest installed voice for a language: offline, highest quality, the same region
     *  (en-IN, hi-IN, te-IN) first, low latency. Cached per language. */
    private android.speech.tts.Voice pickVoice(Locale loc) {
        String key = loc.toLanguageTag();
        String want = getContext().getSharedPreferences("twingaze-voice", Context.MODE_PRIVATE).getString(key, null);
        if (want != null) {
            try {
                for (android.speech.tts.Voice v : tts.getVoices()) {
                    if (!want.equals(v.getName())) continue;
                    if (v.isNetworkConnectionRequired() && !online()) break;      // no internet: fall back to the best offline voice
                    return v;
                }
            } catch (Exception ignored) { }
        }
        if (bestVoice.containsKey(key)) return bestVoice.get(key);
        android.speech.tts.Voice best = null;
        int bs = Integer.MIN_VALUE;
        try {
            for (android.speech.tts.Voice v : tts.getVoices()) {
                Locale vl = v.getLocale();
                if (vl == null || !vl.getLanguage().equals(loc.getLanguage())) continue;
                java.util.Set<String> f = v.getFeatures();
                if (f != null && f.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                int sc = v.getQuality() - v.getLatency() / 10
                    + (loc.getCountry().equalsIgnoreCase(vl.getCountry()) ? 200 : 0)
                    + (v.isNetworkConnectionRequired() ? -300 : 0);
                if (sc > bs) { bs = sc; best = v; }
            }
        } catch (Exception ignored) { }
        bestVoice.put(key, best);
        return best;
    }

    private boolean online() {
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            android.net.NetworkCapabilities nc = cm.getNetworkCapabilities(cm.getActiveNetwork());
            return nc != null && nc.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        } catch (Exception e) { return false; }
    }

    /** The voices installed for a language: [{name, quality, latency, network, region}], and the one in use. */
    @PluginMethod
    public void voiceList(PluginCall call) {
        JSObject r = new JSObject();
        JSArray out = new JSArray();
        Locale loc = Locale.forLanguageTag(call.getString("lang", "en-IN"));
        if (ttsReady) {
            try {
                for (android.speech.tts.Voice v : tts.getVoices()) {
                    Locale vl = v.getLocale();
                    if (vl == null || !vl.getLanguage().equals(loc.getLanguage())) continue;
                    java.util.Set<String> f = v.getFeatures();
                    if (f != null && f.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                    JSObject o = new JSObject();
                    o.put("name", v.getName());
                    o.put("quality", v.getQuality());
                    o.put("latency", v.getLatency());
                    o.put("network", v.isNetworkConnectionRequired());
                    o.put("region", vl.getCountry());
                    out.put(o);
                }
            } catch (Exception ignored) { }
            android.speech.tts.Voice cur = pickVoice(loc);
            r.put("current", cur == null ? JSONObject.NULL : cur.getName());
        }
        r.put("voices", out);
        r.put("online", online());
        call.resolve(r);
    }

    /** Remembers the voice for a language (name null = back to the automatic choice). */
    @PluginMethod
    public void setVoice(PluginCall call) {
        String lang = call.getString("lang", "en-IN"), name = call.getString("name");
        android.content.SharedPreferences.Editor e = getContext().getSharedPreferences("twingaze-voice", Context.MODE_PRIVATE).edit();
        if (name == null || name.isEmpty()) e.remove(Locale.forLanguageTag(lang).toLanguageTag()); else e.putString(Locale.forLanguageTag(lang).toLanguageTag(), name);
        e.apply();
        call.resolve();
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        if (tts != null) tts.stop();
        speaking = false;
        call.resolve();
    }

    @PluginMethod
    public void isSpeaking(PluginCall call) {
        JSObject r = new JSObject();
        r.put("speaking", speaking);
        call.resolve(r);
    }

    @PluginMethod
    public void voices(PluginCall call) {
        JSObject r = new JSObject();
        for (String tag : new String[] { "en-IN", "hi-IN", "te-IN" }) {
            boolean avail = ttsReady && tts.isLanguageAvailable(Locale.forLanguageTag(tag)) >= TextToSpeech.LANG_AVAILABLE;
            r.put(tag, avail);
            android.speech.tts.Voice v = avail ? pickVoice(Locale.forLanguageTag(tag)) : null;
            if (v != null) r.put(tag + ":voice", v.getName() + " · quality " + v.getQuality() + (v.isNetworkConnectionRequired() ? " · online" : " · offline"));
        }
        call.resolve(r);
    }

    /* ---------- vibration, screen ---------- */

    @PluginMethod
    public void vibrate(PluginCall call) {
        Vibrator v = (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
        JSArray arr = call.getArray("pattern");
        if (v == null || arr == null) { call.resolve(); return; }
        try {
            long[] timings = new long[arr.length() + 1];
            timings[0] = 0;                                  // Android patterns start with a pause
            for (int i = 0; i < arr.length(); i++) timings[i + 1] = arr.getLong(i);
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(timings, -1));
            else v.vibrate(timings, -1);
        } catch (Exception ignored) { }
        call.resolve();
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    /* ---------- safety: flash as a strobe, a siren on the alarm channel, the phone's own ringtone ---------- */

    private String torchId;

    /** The flash without opening the camera (only while no scan holds the camera). */
    private boolean setTorch(boolean on) {
        try {
            CameraManager cm = (CameraManager) getContext().getSystemService(Context.CAMERA_SERVICE);
            if (cm == null) return false;
            if (torchId == null) {
                for (String id : cm.getCameraIdList()) {
                    Boolean f = cm.getCameraCharacteristics(id).get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                    if (Boolean.TRUE.equals(f)) { torchId = id; break; }
                }
            }
            if (torchId == null) return false;
            cm.setTorchMode(torchId, on);
            return true;
        } catch (Exception e) { return false; }
    }

    @PluginMethod
    public void torch(PluginCall call) {
        JSObject r = new JSObject();
        r.put("ok", setTorch(Boolean.TRUE.equals(call.getBoolean("on", false))));
        call.resolve(r);
    }

    private volatile AudioTrack siren;

    /** A loud two-tone siren on the ALARM stream (its own volume, usually high; the user's
     *  media volume and settings are not touched). Generated here, looped until stopped. */
    @PluginMethod
    public void siren(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        stopSiren();
        JSObject r = new JSObject();
        if (on) {
            try {
                int rate = 22050, secs = 2;
                short[] pcm = new short[rate * secs];
                double ph = 0;
                for (int i = 0; i < pcm.length; i++) {
                    double t = (double) i / rate;
                    double f = t % 1.0 < 0.5 ? 960 + 700 * ((t % 0.5) / 0.5) : 1660 - 700 * (((t % 1.0) - 0.5) / 0.5);   // wail up and down
                    ph += 2 * Math.PI * f / rate;
                    double v = Math.sin(ph) + 0.35 * Math.sin(3 * ph);                                                 // a harsher tone carries further
                    pcm[i] = (short) Math.max(-32767, Math.min(32767, v * 0.72 * 32767));
                }
                AudioTrack tr = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setTransferMode(AudioTrack.MODE_STATIC).setBufferSizeInBytes(pcm.length * 2).build();
                tr.write(pcm, 0, pcm.length);
                tr.setLoopPoints(0, pcm.length, -1);
                tr.play();
                siren = tr;
                r.put("ok", true);
            } catch (Exception e) { r.put("ok", false); r.put("error", e.getMessage()); }
        } else r.put("ok", true);
        call.resolve(r);
    }

    private void stopSiren() {
        AudioTrack tr = siren;
        siren = null;
        if (tr != null) { try { tr.stop(); } catch (Exception ignored) { } try { tr.release(); } catch (Exception ignored) { } }
    }

    private volatile Ringtone ring;

    /** The phone's own ringtone, for the fake incoming call. */
    @PluginMethod
    public void ringtone(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        stopRingtone();
        JSObject r = new JSObject();
        if (on) {
            try {
                Uri u = RingtoneManager.getActualDefaultRingtoneUri(getContext(), RingtoneManager.TYPE_RINGTONE);
                if (u == null) u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
                Ringtone rt = RingtoneManager.getRingtone(getContext(), u);
                if (rt != null) {
                    if (Build.VERSION.SDK_INT >= 28) rt.setLooping(true);
                    rt.play();
                    ring = rt;
                }
                r.put("ok", rt != null);
            } catch (Exception e) { r.put("ok", false); r.put("error", e.getMessage()); }
        } else r.put("ok", true);
        call.resolve(r);
    }

    private void stopRingtone() {
        Ringtone rt = ring;
        ring = null;
        if (rt != null) { try { rt.stop(); } catch (Exception ignored) { } }
    }

    /* ---------- files: written in chunks so a long video never has to cross the bridge at once ---------- */

    @PluginMethod
    public void beginFile(PluginCall call) {
        String name = call.getString("name", "twingaze");
        String mime = call.getString("mime", "application/octet-stream");
        String kind = call.getString("kind", "download");
        if (Build.VERSION.SDK_INT < 29) { call.reject("saving needs Android 10 or newer"); return; }
        try {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            Uri collection;
            String dir;
            if ("image".equals(kind)) { collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI; dir = Environment.DIRECTORY_PICTURES + "/TwinGaze"; }
            else if ("video".equals(kind)) { collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI; dir = Environment.DIRECTORY_MOVIES + "/TwinGaze"; }
            else { collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI; dir = Environment.DIRECTORY_DOWNLOADS + "/TwinGaze"; }
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, dir);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = getContext().getContentResolver().insert(collection, v);
            if (uri == null) { call.reject("could not create the file"); return; }
            String id = "f" + System.nanoTime();
            openFiles.put(id, uri);
            JSObject r = new JSObject();
            r.put("id", id);
            r.put("path", dir + "/" + name);
            call.resolve(r);
        } catch (Exception ex) { call.reject(ex.getMessage()); }
    }

    @PluginMethod
    public void appendFile(PluginCall call) {
        Uri uri = openFiles.get(call.getString("id", ""));
        if (uri == null) { call.reject("unknown file"); return; }
        try (OutputStream os = getContext().getContentResolver().openOutputStream(uri, "wa")) {
            os.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            call.resolve();
        } catch (Exception ex) { call.reject(ex.getMessage()); }
    }

    @PluginMethod
    public void endFile(PluginCall call) {
        Uri uri = openFiles.remove(call.getString("id", ""));
        if (uri == null) { call.reject("unknown file"); return; }
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        try { getContext().getContentResolver().update(uri, v, null, null); }
        catch (Exception e) { try { getContext().getContentResolver().delete(uri, null, null); } catch (Exception ignored) { } call.reject(e.getMessage()); return; }
        JSObject r = new JSObject();
        r.put("uri", uri.toString());
        call.resolve(r);
    }

    /* ---------- share sheet, clipboard ---------- */

    @PluginMethod
    public void share(PluginCall call) {
        try {
            String text = call.getString("text", "");
            String title = call.getString("title", "TwinGaze");
            JSArray files = call.getArray("files");
            ArrayList<Uri> uris = new ArrayList<>();
            boolean allImages = true;
            if (files != null) {
                File dir = new File(getContext().getCacheDir(), "share");
                dir.mkdirs();
                for (int i = 0; i < files.length(); i++) {
                    JSONObject f = files.getJSONObject(i);
                    File out = new File(dir, f.getString("name"));
                    try (FileOutputStream fos = new FileOutputStream(out)) { fos.write(Base64.decode(f.getString("data"), Base64.DEFAULT)); }
                    uris.add(FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", out));
                    if (!f.optString("mime", "").startsWith("image/")) allImages = false;
                }
            }
            Intent send;
            if (uris.isEmpty()) {
                send = new Intent(Intent.ACTION_SEND).setType("text/plain");
            } else {
                send = new Intent(Intent.ACTION_SEND_MULTIPLE).setType(allImages ? "image/*" : "*/*");
                send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }
            send.putExtra(Intent.EXTRA_TEXT, text);
            send.putExtra(Intent.EXTRA_SUBJECT, title);
            Intent chooser = Intent.createChooser(send, title);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(chooser);
            call.resolve();
        } catch (Exception ex) { call.reject(ex.getMessage()); }
    }

    @PluginMethod
    public void copy(PluginCall call) {
        try {
            ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("TwinGaze", call.getString("text", "")));
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }
}
