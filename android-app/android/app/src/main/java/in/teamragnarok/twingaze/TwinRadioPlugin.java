package in.teamragnarok.twingaze;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.ProxyInfo;
import android.net.RouteInfo;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.SparseArray;

import androidx.core.content.ContextCompat;
import androidx.core.location.LocationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Radio scans the web page can't do on its own: nearby Wi-Fi networks, nearby Bluetooth (BLE)
 * devices, and devices on the Wi-Fi the phone is connected to (open camera ports + ONVIF discovery).
 * Everything here only collects raw data; js/radio.js decides what looks like a camera or tracker.
 */
@CapacitorPlugin(
    name = "TwinRadio",
    permissions = {
        // Android only hands out Wi-Fi scan results (all versions) and, below Android 12, BLE scan
        // results to apps holding precise location. Nothing is located or stored.
        @Permission(alias = TwinRadioPlugin.LOCATION, strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        // Android 13+: the "Nearby devices" permission for Wi-Fi.
        @Permission(alias = TwinRadioPlugin.NEARBY_WIFI, strings = { Manifest.permission.NEARBY_WIFI_DEVICES }),
        // Android 12+: the "Nearby devices" permission for Bluetooth. CONNECT is only for device names.
        @Permission(alias = TwinRadioPlugin.BLUETOOTH, strings = { Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT })
    }
)
public class TwinRadioPlugin extends Plugin {

    static final String LOCATION = "location";
    static final String NEARBY_WIFI = "nearbyWifi";
    static final String BLUETOOTH = "bluetooth";

    private static final String DENIED = "PERMISSION_DENIED";
    private static final long WIFI_WAIT_MS = 6000;
    private static final int[] DEFAULT_PORTS = { 554, 80, 8000, 8080, 8899, 34567, 37777, 5000 };
    private static final int LAN_THREADS = 48;
    private static final int ONVIF_LISTEN_MS = 3000;

    private final ExecutorService io = Executors.newCachedThreadPool();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicBoolean lanBusy = new AtomicBoolean(false);
    private volatile ExecutorService lanPool;
    private volatile BleJob bleJob;
    private volatile WifiJob wifiJob;

    @Override
    protected void handleOnDestroy() {
        BleJob b = bleJob;
        if (b != null) b.finish(null);
        WifiJob w = wifiJob;
        if (w != null) w.finish(false);
        ExecutorService p = lanPool;
        if (p != null) p.shutdownNow();
        io.shutdownNow();
    }

    /* ---------- small helpers ---------- */

    private Context ctx() { return getContext().getApplicationContext(); }

    private boolean granted(String perm) {
        return ContextCompat.checkSelfPermission(getContext(), perm) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean locationOn() {
        try {
            LocationManager lm = (LocationManager) ctx().getSystemService(Context.LOCATION_SERVICE);
            return lm != null && LocationManagerCompat.isLocationEnabled(lm);
        } catch (Exception e) { return true; }            // unknown: don't claim it's off
    }

    private WifiManager wifi() {
        try { return (WifiManager) ctx().getSystemService(Context.WIFI_SERVICE); } catch (Exception e) { return null; }
    }

    private ConnectivityManager conn() {
        try { return (ConnectivityManager) ctx().getSystemService(Context.CONNECTIVITY_SERVICE); } catch (Exception e) { return null; }
    }

    private static Object orNull(Object v) { return v == null ? JSONObject.NULL : v; }

    private static String cleanSsid(String s) {
        if (s == null) return "";
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) s = s.substring(1, s.length() - 1);
        if ("<unknown ssid>".equals(s) || "0x".equals(s)) return "";
        return s;
    }

    private static String hex(byte[] b) {
        if (b == null) return "";
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format(Locale.US, "%02x", x & 0xff));
        return sb.toString();
    }

    private static long ipToLong(Inet4Address a) {
        byte[] b = a.getAddress();
        return ((b[0] & 0xffL) << 24) | ((b[1] & 0xffL) << 16) | ((b[2] & 0xffL) << 8) | (b[3] & 0xffL);
    }

    private static String longToIp(long v) {
        return ((v >>> 24) & 0xff) + "." + ((v >>> 16) & 0xff) + "." + ((v >>> 8) & 0xff) + "." + (v & 0xff);
    }

    private static InetAddress longToAddr(long v) throws Exception {
        return InetAddress.getByAddress(new byte[] { (byte) (v >>> 24), (byte) (v >>> 16), (byte) (v >>> 8), (byte) v });
    }

    /** The Wi-Fi network, even when Android routes the internet over mobile data (e.g. connected
     *  to a camera's own hotspot, which has no internet). VPNs are skipped: they carry no LAN address. */
    @SuppressWarnings("deprecation")
    private Network wifiNetwork() {
        ConnectivityManager cm = conn();
        if (cm == null) return null;
        try {
            Network active = cm.getActiveNetwork();
            if (isPlainWifi(cm, active)) return active;
            for (Network n : cm.getAllNetworks()) if (isPlainWifi(cm, n)) return n;
        } catch (Exception ignored) { }
        return null;
    }

    private static boolean isPlainWifi(ConnectivityManager cm, Network n) {
        if (n == null) return false;
        NetworkCapabilities nc = cm.getNetworkCapabilities(n);
        return nc != null && nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !nc.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
    }

    /** {address, prefixLength, gateway} of the phone on the given network, or null. */
    private static final class LanInfo { Inet4Address self; int prefix; String gateway; }

    private LanInfo lanInfo(Network net) {
        ConnectivityManager cm = conn();
        if (cm == null || net == null) return null;
        LinkProperties lp = cm.getLinkProperties(net);
        if (lp == null) return null;
        LanInfo li = new LanInfo();
        for (LinkAddress la : lp.getLinkAddresses()) {
            if (la.getAddress() instanceof Inet4Address && !la.getAddress().isLoopbackAddress()) {
                li.self = (Inet4Address) la.getAddress();
                li.prefix = la.getPrefixLength();
                break;
            }
        }
        if (li.self == null) return null;
        for (RouteInfo ri : lp.getRoutes()) {
            if (ri.isDefaultRoute() && ri.getGateway() instanceof Inet4Address) { li.gateway = ri.getGateway().getHostAddress(); break; }
        }
        return li;
    }

    /* =====================================================================================
     * Wi-Fi: nearby networks
     * ===================================================================================== */

    @PluginMethod
    public void wifiScan(PluginCall call) {
        boolean needNearby = Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.NEARBY_WIFI_DEVICES);
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION) || needNearby) {
            String[] aliases = Build.VERSION.SDK_INT >= 33 ? new String[] { LOCATION, NEARBY_WIFI } : new String[] { LOCATION };
            requestPermissionForAliases(aliases, call, "wifiPermsCallback");
            return;
        }
        startWifiScan(call);
    }

    @PermissionCallback
    private void wifiPermsCallback(PluginCall call) {
        // Android's documentation: getScanResults()/startScan() need precise location on every
        // version, even with NEARBY_WIFI_DEVICES on Android 13+. So location is the one that matters.
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) {
            call.reject("To list nearby Wi-Fi networks Android requires the precise Location permission (choose 'Precise'). TwinGaze does not track or store your location.", DENIED);
            return;
        }
        startWifiScan(call);
    }

    private void startWifiScan(PluginCall call) {
        try {
            WifiManager wm = wifi();
            if (wm == null) { call.reject("This phone has no Wi-Fi."); return; }
            if (!wm.isWifiEnabled()) {
                JSObject r = new JSObject();
                r.put("wifiOff", true);
                r.put("networks", new JSArray());
                r.put("fresh", false);
                r.put("connected", JSONObject.NULL);
                r.put("locationOff", !locationOn());
                call.resolve(r);
                return;
            }
            WifiJob old = wifiJob;
            if (old != null) old.finish(false);            // a newer request replaces a pending one
            WifiJob job = new WifiJob(call, wm);
            wifiJob = job;
            job.start();
        } catch (Exception e) {
            call.reject("Wi-Fi scan failed: " + e.getMessage());
        }
    }

    /** Asks Android for a fresh scan and waits (up to ~6 s) for the "results ready" broadcast.
     *  Android allows only ~4 scans per 2 minutes per app; when it refuses we return the last results. */
    private final class WifiJob extends BroadcastReceiver implements Runnable {
        final PluginCall call;
        final WifiManager wm;
        final AtomicBoolean finished = new AtomicBoolean(false);
        volatile boolean registered = false;

        WifiJob(PluginCall call, WifiManager wm) { this.call = call; this.wm = wm; }

        @SuppressWarnings("deprecation")
        void start() {
            try {
                // SCAN_RESULTS_AVAILABLE is a protected system broadcast, so an exported receiver is safe.
                ContextCompat.registerReceiver(ctx(), this, new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION), ContextCompat.RECEIVER_EXPORTED);
                registered = true;
            } catch (Exception e) { registered = false; }
            boolean started = false;
            try { started = wm.startScan(); } catch (Exception ignored) { }
            if (!started || !registered) { finish(false); return; }   // throttled or refused: cached results
            main.postDelayed(this, WIFI_WAIT_MS);
        }

        @Override
        public void onReceive(Context c, Intent i) {
            boolean updated = true;
            try { updated = i.getBooleanExtra(WifiManager.EXTRA_RESULTS_UPDATED, true); } catch (Exception ignored) { }
            finish(updated);
        }

        @Override
        public void run() { finish(false); }             // timed out waiting for the broadcast

        void finish(boolean fresh) {
            if (!finished.compareAndSet(false, true)) return;
            main.removeCallbacks(this);
            if (registered) { try { ctx().unregisterReceiver(this); } catch (Exception ignored) { } registered = false; }
            if (wifiJob == this) wifiJob = null;
            try { call.resolve(buildWifiResult(wm, fresh)); }
            catch (Exception e) { call.reject("Could not read Wi-Fi results: " + e.getMessage()); }
        }
    }

    @SuppressWarnings("deprecation")
    private JSObject buildWifiResult(WifiManager wm, boolean fresh) {
        JSArray nets = new JSArray();
        List<android.net.wifi.ScanResult> list = null;
        try { list = wm.getScanResults(); } catch (SecurityException ignored) { }
        long nowUs = SystemClock.elapsedRealtime() * 1000L;
        if (list != null) {
            for (android.net.wifi.ScanResult sr : list) {
                if (sr == null) continue;
                JSObject n = new JSObject();
                n.put("ssid", cleanSsid(sr.SSID));
                n.put("bssid", sr.BSSID == null ? "" : sr.BSSID);
                n.put("level", sr.level);
                n.put("frequency", sr.frequency);
                n.put("capabilities", sr.capabilities == null ? "" : sr.capabilities);
                if (sr.timestamp > 0) n.put("ageMs", Math.max(0L, (nowUs - sr.timestamp) / 1000L));
                nets.put(n);
            }
        }
        JSObject r = new JSObject();
        r.put("networks", nets);
        r.put("fresh", fresh);
        r.put("connected", orNull(connectedInfo(wm)));
        r.put("locationOff", !locationOn());
        r.put("wifiOff", false);
        return r;
    }

    @SuppressWarnings("deprecation")
    private JSObject connectedInfo(WifiManager wm) {
        try {
            Network net = wifiNetwork();
            if (net == null) return null;
            String ssid = "", bssid = null;
            try {
                WifiInfo wi = wm.getConnectionInfo();      // deprecated but still works; needs location for names
                if (wi != null) { ssid = cleanSsid(wi.getSSID()); bssid = wi.getBSSID(); }
            } catch (Exception ignored) { }
            if ("02:00:00:00:00:00".equals(bssid)) bssid = null;   // Android's "hidden from you" placeholder
            LanInfo li = lanInfo(net);
            JSObject c = new JSObject();
            c.put("ssid", orNull(ssid.isEmpty() ? null : ssid));
            c.put("bssid", orNull(bssid));
            c.put("ip", orNull(li == null ? null : li.self.getHostAddress()));
            return c;
        } catch (Exception e) { return null; }
    }

    /* =====================================================================================
     * Network privacy: what Android knows about the connection (no packets are sent)
     * ===================================================================================== */

    @PluginMethod
    public void netInfo(PluginCall call) {
        io.execute(() -> {
            try { call.resolve(buildNetInfo()); }
            catch (Exception e) { call.reject("Network check failed: " + e.getMessage()); }
        });
    }

    @SuppressWarnings("deprecation")
    private JSObject buildNetInfo() {
        JSObject r = new JSObject();
        ConnectivityManager cm = conn();
        WifiManager wm = wifi();
        r.put("wifiOn", wm != null && wm.isWifiEnabled());
        r.put("locationPerm", granted(Manifest.permission.ACCESS_FINE_LOCATION));
        r.put("locationOff", !locationOn());
        if (cm == null) { r.put("active", JSONObject.NULL); r.put("wifi", JSONObject.NULL); r.put("vpn", false); return r; }

        Network active = cm.getActiveNetwork();
        NetworkCapabilities ac = active == null ? null : cm.getNetworkCapabilities(active);
        if (ac != null) {
            JSObject a = new JSObject();
            a.put("wifi", ac.hasTransport(NetworkCapabilities.TRANSPORT_WIFI));
            a.put("cellular", ac.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR));
            a.put("vpn", ac.hasTransport(NetworkCapabilities.TRANSPORT_VPN));
            a.put("ethernet", ac.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET));
            a.put("validated", ac.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
            a.put("captivePortal", ac.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL));
            a.put("notMetered", ac.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED));
            r.put("active", a);
        } else r.put("active", JSONObject.NULL);

        boolean vpn = false;
        try { for (Network n : cm.getAllNetworks()) { NetworkCapabilities nc = cm.getNetworkCapabilities(n); if (nc != null && nc.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) vpn = true; } }
        catch (Exception ignored) { }
        r.put("vpn", vpn);

        try {
            r.put("privateDnsMode", orNull(Settings.Global.getString(ctx().getContentResolver(), "private_dns_mode")));
            r.put("privateDnsHost", orNull(Settings.Global.getString(ctx().getContentResolver(), "private_dns_specifier")));
        } catch (Exception ignored) { }

        Network wn = wifiNetwork();
        if (wn == null) { r.put("wifi", JSONObject.NULL); return r; }
        JSObject w = new JSObject();
        NetworkCapabilities wc = cm.getNetworkCapabilities(wn);
        if (wc != null) {
            w.put("validated", wc.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
            w.put("captivePortal", wc.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL));
            if (Build.VERSION.SDK_INT >= 31 && wc.getTransportInfo() instanceof WifiInfo) {
                int t = ((WifiInfo) wc.getTransportInfo()).getCurrentSecurityType();
                if (t != -1) w.put("securityType", t);
            }
        }
        LinkProperties lp = cm.getLinkProperties(wn);
        if (lp != null) {
            JSArray dns = new JSArray();
            for (InetAddress d : lp.getDnsServers()) dns.put(d.getHostAddress());
            w.put("dns", dns);
            if (Build.VERSION.SDK_INT >= 28) {
                w.put("privateDns", lp.isPrivateDnsActive());
                w.put("privateDnsServer", orNull(lp.getPrivateDnsServerName()));
            }
            ProxyInfo px = lp.getHttpProxy();
            if (px != null) {
                String pac = px.getPacFileUrl() == null || Uri_EMPTY(px.getPacFileUrl().toString()) ? null : px.getPacFileUrl().toString();
                w.put("proxy", px.getHost() != null && !px.getHost().isEmpty() ? px.getHost() + ":" + px.getPort() : (pac != null ? "PAC " + pac : null));
            }
            w.put("domains", orNull(lp.getDomains()));
        }
        LanInfo li = lanInfo(wn);
        if (li != null) { w.put("ip", li.self.getHostAddress()); w.put("prefix", li.prefix); w.put("gateway", orNull(li.gateway)); }
        try {
            WifiInfo wi = wm == null ? null : wm.getConnectionInfo();
            if (wi != null) {
                String ssid = cleanSsid(wi.getSSID());
                w.put("ssid", orNull(ssid.isEmpty() ? null : ssid));
                String b = wi.getBSSID();
                if ("02:00:00:00:00:00".equals(b)) b = null;
                w.put("bssid", orNull(b));
                w.put("rssi", wi.getRssi());
                w.put("linkMbps", wi.getLinkSpeed());
                w.put("frequency", wi.getFrequency());
                w.put("hiddenSsid", wi.getHiddenSSID());
                if (Build.VERSION.SDK_INT >= 31 && !w.has("securityType")) {
                    int t = wi.getCurrentSecurityType();
                    if (t != -1) w.put("securityType", t);
                }
            }
        } catch (Exception ignored) { }
        r.put("wifi", w);
        return r;
    }

    private static boolean Uri_EMPTY(String s) { return s == null || s.isEmpty() || "null".equals(s); }

    /* =====================================================================================
     * Bluetooth LE: nearby devices (cameras with BLE setup, AirTags, Tiles, SmartTags ...)
     * ===================================================================================== */

    @PluginMethod
    public void bleScan(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 31) {
            if (!granted(Manifest.permission.BLUETOOTH_SCAN) || !granted(Manifest.permission.BLUETOOTH_CONNECT)) {
                requestPermissionForAlias(BLUETOOTH, call, "blePermsCallback");
                return;
            }
        } else if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) {
            requestPermissionForAlias(LOCATION, call, "blePermsCallback");
            return;
        }
        startBleScan(call);
    }

    @PermissionCallback
    private void blePermsCallback(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 31) {
            if (!granted(Manifest.permission.BLUETOOTH_SCAN)) {
                call.reject("To find nearby Bluetooth devices TwinGaze needs the 'Nearby devices' permission.", DENIED);
                return;
            }
        } else if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) {
            call.reject("On this Android version, finding nearby Bluetooth devices requires the precise Location permission. TwinGaze does not track or store your location.", DENIED);
            return;
        }
        startBleScan(call);
    }

    @SuppressLint("MissingPermission")
    private void startBleScan(PluginCall call) {
        try {
            Integer d = call.getInt("durationMs", 8000);
            int duration = Math.max(1000, Math.min(30000, d == null ? 8000 : d));
            BluetoothManager bm = (BluetoothManager) ctx().getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter ad = bm == null ? null : bm.getAdapter();
            boolean hasLe = ctx().getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE);
            if (ad == null || !hasLe) { resolveBleOff(call, true); return; }
            if (!ad.isEnabled()) { resolveBleOff(call, false); return; }
            BluetoothLeScanner sc = ad.getBluetoothLeScanner();
            if (sc == null) { resolveBleOff(call, false); return; }
            if (bleJob != null) { call.reject("A Bluetooth scan is already running."); return; }
            BleJob job = new BleJob(call, sc);
            bleJob = job;
            job.start(duration);
        } catch (Exception e) {
            bleJob = null;
            call.reject("Bluetooth scan failed: " + e.getMessage());
        }
    }

    private void resolveBleOff(PluginCall call, boolean unsupported) {
        JSObject r = new JSObject();
        r.put("devices", new JSArray());
        r.put("bluetoothOff", true);
        if (unsupported) r.put("unsupported", true);
        call.resolve(r);
    }

    /** What we remember about one device across all its advertisements. */
    private static final class BleSeen {
        String address, name;
        int rssi = -127;
        int count = 0;
        final Map<Integer, String> manufacturer = new LinkedHashMap<>();
        final Set<String> services = new LinkedHashSet<>();
        final Map<String, String> serviceData = new LinkedHashMap<>();
    }

    private final class BleJob extends ScanCallback implements Runnable {
        final PluginCall call;
        final BluetoothLeScanner scanner;
        final AtomicBoolean finished = new AtomicBoolean(false);
        final Map<String, BleSeen> seen = new LinkedHashMap<>();
        final boolean canConnect;

        BleJob(PluginCall call, BluetoothLeScanner scanner) {
            this.call = call;
            this.scanner = scanner;
            this.canConnect = Build.VERSION.SDK_INT < 31 || granted(Manifest.permission.BLUETOOTH_CONNECT);
        }

        @SuppressLint("MissingPermission")
        void start(int durationMs) {
            ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .setReportDelay(0)
                .build();
            scanner.startScan(null, settings, this);
            main.postDelayed(this, durationMs);
        }

        @Override
        public void onScanResult(int callbackType, ScanResult result) { record(result); }

        @Override
        public void onBatchScanResults(List<ScanResult> results) {
            if (results != null) for (ScanResult r : results) record(r);
        }

        @Override
        public void onScanFailed(int errorCode) {
            // 1 = already started, 2 = app registration failed (often: too many scans too quickly), 3 = internal, 4 = unsupported
            finish("Bluetooth scan failed (Android error " + errorCode + "). Wait 30 seconds and try again.");
        }

        @Override
        public void run() { finish(null); }             // scan time is up

        @SuppressLint("MissingPermission")
        private void record(ScanResult r) {
            if (r == null || finished.get()) return;
            try {
                BluetoothDevice dev = r.getDevice();
                if (dev == null) return;
                String addr = dev.getAddress();
                synchronized (seen) {
                    BleSeen s = seen.get(addr);
                    if (s == null) { s = new BleSeen(); s.address = addr; seen.put(addr, s); }
                    s.count++;
                    if (r.getRssi() > s.rssi) s.rssi = r.getRssi();   // strongest = closest it got
                    ScanRecord rec = r.getScanRecord();
                    String name = rec == null ? null : rec.getDeviceName();  // advertised name: no permission needed
                    if ((name == null || name.isEmpty()) && canConnect) {
                        try { name = dev.getName(); } catch (SecurityException ignored) { }
                    }
                    if (name != null && !name.trim().isEmpty()) s.name = name.trim();
                    if (rec != null) {
                        SparseArray<byte[]> m = rec.getManufacturerSpecificData();
                        if (m != null) for (int i = 0; i < m.size(); i++) s.manufacturer.put(m.keyAt(i), hex(m.valueAt(i)));
                        List<ParcelUuid> uu = rec.getServiceUuids();
                        if (uu != null) for (ParcelUuid u : uu) s.services.add(u.toString());
                        Map<ParcelUuid, byte[]> sd = rec.getServiceData();
                        if (sd != null) for (Map.Entry<ParcelUuid, byte[]> e : sd.entrySet()) {
                            s.services.add(e.getKey().toString());
                            s.serviceData.put(e.getKey().toString(), hex(e.getValue()));
                        }
                    }
                }
            } catch (Exception ignored) { }
        }

        @SuppressLint("MissingPermission")
        void finish(String error) {
            if (!finished.compareAndSet(false, true)) return;
            main.removeCallbacks(this);
            try { scanner.stopScan(this); } catch (Exception ignored) { }   // throws if Bluetooth was just turned off
            if (bleJob == this) bleJob = null;
            JSArray arr = new JSArray();
            synchronized (seen) {
                if (error != null && seen.isEmpty()) { call.reject(error); return; }
                for (BleSeen s : seen.values()) {
                    JSObject o = new JSObject();
                    o.put("address", s.address);
                    o.put("name", orNull(s.name));
                    o.put("rssi", s.rssi);
                    o.put("seen", s.count);
                    JSArray mf = new JSArray();
                    for (Map.Entry<Integer, String> e : s.manufacturer.entrySet()) {
                        JSObject m = new JSObject();
                        m.put("id", e.getKey().intValue());
                        m.put("data", e.getValue());
                        mf.put(m);
                    }
                    o.put("manufacturer", mf);
                    JSArray sv = new JSArray();
                    for (String u : s.services) sv.put(u);
                    o.put("services", sv);
                    JSObject sdo = new JSObject();
                    for (Map.Entry<String, String> e : s.serviceData.entrySet()) sdo.put(e.getKey(), e.getValue());
                    o.put("serviceData", sdo);
                    arr.put(o);
                }
            }
            JSObject r = new JSObject();
            r.put("devices", arr);
            r.put("bluetoothOff", false);
            if (Build.VERSION.SDK_INT < 31) r.put("locationOff", !locationOn());   // below Android 12 BLE results need location on
            call.resolve(r);
        }
    }

    /* =====================================================================================
     * LAN: devices on the same Wi-Fi with camera ports open, plus ONVIF discovery
     * ===================================================================================== */

    @PluginMethod
    public void lanScan(PluginCall call) {
        if (!lanBusy.compareAndSet(false, true)) { call.reject("A network scan is already running."); return; }
        final int[] ports = readPorts(call.getArray("ports"));
        Integer t = call.getInt("timeoutMs", 300);
        final int timeout = Math.max(50, Math.min(5000, t == null ? 300 : t));
        try {
            io.execute(() -> {
                try { runLanScan(call, ports, timeout); }
                catch (Throwable e) { call.reject("Network scan failed: " + e.getMessage()); }
                finally { lanBusy.set(false); }
            });
        } catch (Exception e) {
            lanBusy.set(false);
            call.reject("Network scan failed: " + e.getMessage());
        }
    }

    private static int[] readPorts(JSArray arr) {
        if (arr == null || arr.length() == 0) return DEFAULT_PORTS.clone();
        LinkedHashSet<Integer> set = new LinkedHashSet<>();
        for (int i = 0; i < arr.length() && set.size() < 32; i++) {
            try {
                int p = arr.getInt(i);
                if (p > 0 && p < 65536) set.add(p);
            } catch (Exception ignored) { }
        }
        if (set.isEmpty()) return DEFAULT_PORTS.clone();
        int[] out = new int[set.size()];
        int i = 0;
        for (int p : set) out[i++] = p;
        return out;
    }

    private void runLanScan(PluginCall call, int[] ports, int timeout) throws Exception {
        Network net = wifiNetwork();
        LanInfo li = net == null ? null : lanInfo(net);
        if (li == null) {
            JSObject r = new JSObject();
            r.put("noWifi", true);
            r.put("hosts", new JSArray());
            call.resolve(r);
            return;
        }

        // Scan at most one /24: the phone's own subnet (or a smaller one if the network is smaller).
        int prefix = Math.max(24, Math.min(30, li.prefix));
        long self = ipToLong(li.self);
        long mask = (0xFFFFFFFFL << (32 - prefix)) & 0xFFFFFFFFL;
        long base = self & mask;
        long bcast = base | (~mask & 0xFFFFFFFFL);
        List<Long> targets = new ArrayList<>();
        for (long a = base + 1; a < bcast; a++) if (a != self) targets.add(a);
        final int total = targets.size();

        // ONVIF discovery runs alongside the port scan.
        final Network fnet = net;
        final Inet4Address fself = li.self;
        Future<Map<String, String[]>> onvifF = io.submit(() -> onvifProbe(fnet, fself));

        // UPnP (SSDP) discovery too: TVs, cameras, routers and media boxes describe themselves
        Future<Map<String, String[]>> ssdpF = io.submit(() -> ssdpProbe(fnet, fself));

        final Map<Long, List<Integer>> open = new ConcurrentHashMap<>();
        final Set<Long> alive = ConcurrentHashMap.newKeySet();     // answered at all (even "port closed")
        final AtomicInteger done = new AtomicInteger();
        JSObject p0 = new JSObject();
        p0.put("done", 0);
        p0.put("total", total);
        notifyListeners("lanProgress", p0);

        ExecutorService pool = Executors.newFixedThreadPool(LAN_THREADS);
        lanPool = pool;
        try {
            for (final long target : targets) {
                pool.execute(() -> {
                    try {
                        InetAddress addr = longToAddr(target);
                        List<Integer> found = new ArrayList<>();
                        for (int port : ports) {
                            if (Thread.currentThread().isInterrupted()) break;
                            int st = probe(fnet, addr, port, timeout);
                            if (st >= 0) alive.add(target);
                            if (st == 1) found.add(port);
                        }
                        if (!found.isEmpty()) open.put(target, found);
                    } catch (Exception ignored) { }
                    int d = done.incrementAndGet();
                    if (d % 4 == 0 || d == total) {
                        JSObject p = new JSObject();
                        p.put("done", d);
                        p.put("total", total);
                        notifyListeners("lanProgress", p);
                    }
                });
            }
            pool.shutdown();
            if (!pool.awaitTermination(3, TimeUnit.MINUTES)) pool.shutdownNow();
        } finally {
            lanPool = null;
            if (!pool.isShutdown()) pool.shutdownNow();
        }

        Map<String, String[]> onvif;
        try { onvif = onvifF.get(ONVIF_LISTEN_MS + 5000, TimeUnit.MILLISECONDS); }
        catch (Exception e) { onvif = new HashMap<>(); }
        Map<String, String[]> ssdp;
        try { ssdp = ssdpF.get(ONVIF_LISTEN_MS + 9000, TimeUnit.MILLISECONDS); }
        catch (Exception e) { ssdp = new HashMap<>(); }
        for (String ip : ssdp.keySet()) { try { alive.add(ipToLong((Inet4Address) InetAddress.getByName(ip))); } catch (Exception ignored) { } }
        for (String ip : onvif.keySet()) { try { alive.add(ipToLong((Inet4Address) InetAddress.getByName(ip))); } catch (Exception ignored) { } }
        if (li.gateway != null) { try { alive.add(ipToLong((Inet4Address) InetAddress.getByName(li.gateway))); } catch (Exception ignored) { } }

        // names the router gives the devices (reverse DNS), for at most 64 of them, in parallel
        final Map<Long, String> names = new ConcurrentHashMap<>();
        List<Future<?>> nf = new ArrayList<>();
        int nn = 0;
        for (final long a : alive) {
            if (nn++ >= 64) break;
            nf.add(io.submit(() -> {
                try {
                    String ip = longToIp(a);
                    String h = longToAddr(a).getCanonicalHostName();
                    if (h != null && !h.equals(ip) && !h.isEmpty()) names.put(a, h);
                } catch (Exception ignored) { }
            }));
        }
        long nameDeadline = SystemClock.elapsedRealtime() + 2500;
        for (Future<?> f : nf) {
            long left = nameDeadline - SystemClock.elapsedRealtime();
            try { f.get(Math.max(1, left), TimeUnit.MILLISECONDS); } catch (Exception ignored) { }
        }

        // Merge and sort by address.
        TreeMap<Long, JSObject> hosts = new TreeMap<>();
        for (Map.Entry<Long, List<Integer>> e : open.entrySet()) {
            JSObject h = new JSObject();
            h.put("ip", longToIp(e.getKey()));
            JSArray pa = new JSArray();
            for (int p : e.getValue()) pa.put(p);
            h.put("ports", pa);
            h.put("onvif", JSONObject.NULL);
            hosts.put(e.getKey(), h);
        }
        for (Map.Entry<String, String[]> e : onvif.entrySet()) {
            long key;
            try { key = ipToLong((Inet4Address) InetAddress.getByName(e.getKey())); } catch (Exception ex) { continue; }
            JSObject h = hosts.get(key);
            if (h == null) {
                h = new JSObject();
                h.put("ip", e.getKey());
                h.put("ports", new JSArray());
                hosts.put(key, h);
            }
            JSObject o = new JSObject();
            o.put("xaddrs", e.getValue()[0]);
            o.put("scopes", e.getValue()[1]);
            h.put("onvif", o);
        }
        for (Map.Entry<String, String[]> e : ssdp.entrySet()) {
            long key;
            try { key = ipToLong((Inet4Address) InetAddress.getByName(e.getKey())); } catch (Exception ex) { continue; }
            JSObject h = hosts.get(key);
            if (h == null) {
                h = new JSObject();
                h.put("ip", e.getKey());
                h.put("ports", new JSArray());
                h.put("onvif", JSONObject.NULL);
                hosts.put(key, h);
            }
            String[] v = e.getValue();
            JSObject u = new JSObject();
            u.put("server", v[0]); u.put("types", v[1]); u.put("name", v[2]); u.put("maker", v[3]); u.put("model", v[4]); u.put("deviceType", v[5]);
            h.put("upnp", u);
        }
        for (Map.Entry<Long, JSObject> e : hosts.entrySet()) {
            String nm = names.get(e.getKey());
            if (nm != null) e.getValue().put("name", nm);
        }
        JSArray list = new JSArray();
        for (JSObject h : hosts.values()) list.put(h);
        // every device that answered, with its network name when the router knows it
        JSArray all = new JSArray();
        for (long a : new java.util.TreeSet<>(alive)) {
            JSObject d = new JSObject();
            d.put("ip", longToIp(a));
            d.put("name", orNull(names.get(a)));
            all.put(d);
        }

        JSObject r = new JSObject();
        r.put("alive", all);
        r.put("subnet", longToIp(base) + "/" + prefix);
        r.put("self", li.self.getHostAddress());
        r.put("gateway", orNull(li.gateway));
        r.put("hosts", list);
        call.resolve(r);
    }

    /** TCP connect through the Wi-Fi network (works even when mobile data is the default route).
     *  1 = port open, 0 = the device answered "closed" (so it exists), -1 = no answer. */
    private static int probe(Network net, InetAddress addr, int port, int timeout) {
        Socket s = null;
        try {
            s = net.getSocketFactory().createSocket();
            s.connect(new InetSocketAddress(addr, port), timeout);
            return 1;
        } catch (ConnectException e) {
            String m = String.valueOf(e.getMessage());
            return m.contains("ECONNREFUSED") || m.contains("refused") ? 0 : -1;
        } catch (Exception e) {
            return -1;
        } finally {
            if (s != null) try { s.close(); } catch (Exception ignored) { }
        }
    }

    /* ---------- UPnP / SSDP: devices that announce what they are ---------- */

    private static final Pattern HDR_LOCATION = Pattern.compile("(?im)^location:\\s*(\\S+)");
    private static final Pattern HDR_SERVER = Pattern.compile("(?im)^server:\\s*(.+)$");
    private static final Pattern HDR_ST = Pattern.compile("(?im)^st:\\s*(.+)$");

    /** ip -> {server, types, friendlyName, manufacturer, modelName, deviceType}. Never throws. */
    private Map<String, String[]> ssdpProbe(Network net, Inet4Address self) {
        Map<String, String[]> out = new ConcurrentHashMap<>();
        Map<String, String> locs = new HashMap<>();
        WifiManager.MulticastLock lock = null;
        MulticastSocket sock = null;
        try {
            WifiManager wm = wifi();
            if (wm != null) { lock = wm.createMulticastLock("twingaze-ssdp"); lock.setReferenceCounted(false); lock.acquire(); }
            sock = new MulticastSocket(0);
            try { net.bindSocket(sock); } catch (Exception ignored) { }
            try { NetworkInterface nif = NetworkInterface.getByInetAddress(self); if (nif != null) sock.setNetworkInterface(nif); } catch (Exception ignored) { }
            InetAddress group = InetAddress.getByName("239.255.255.250");
            byte[] q = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n").getBytes(StandardCharsets.US_ASCII);
            DatagramPacket probe = new DatagramPacket(q, q.length, group, 1900);
            try { sock.send(probe); } catch (Exception ignored) { }
            long start = SystemClock.elapsedRealtime(), deadline = start + ONVIF_LISTEN_MS;
            boolean resent = false;
            byte[] buf = new byte[8192];
            while (true) {
                long now = SystemClock.elapsedRealtime(), left = deadline - now;
                if (left <= 0) break;
                if (!resent && now - start > 800) { resent = true; try { sock.send(probe); } catch (Exception ignored) { } }
                sock.setSoTimeout((int) Math.max(50, Math.min(left, 400)));
                DatagramPacket in = new DatagramPacket(buf, buf.length);
                try { sock.receive(in); } catch (SocketTimeoutException e) { continue; }
                if (in.getAddress() == null) continue;
                String txt = new String(in.getData(), in.getOffset(), in.getLength(), StandardCharsets.UTF_8);
                String ip = in.getAddress().getHostAddress();
                String[] v = out.get(ip);
                if (v == null) { v = new String[] { "", "", "", "", "", "" }; out.put(ip, v); }
                Matcher m = HDR_SERVER.matcher(txt); if (m.find() && v[0].isEmpty()) v[0] = m.group(1).trim();
                m = HDR_ST.matcher(txt);
                if (m.find()) { String st = m.group(1).trim(); if (!v[1].contains(st) && v[1].length() < 600) v[1] = v[1].isEmpty() ? st : v[1] + " " + st; }
                m = HDR_LOCATION.matcher(txt); if (m.find() && !locs.containsKey(ip)) locs.put(ip, m.group(1).trim());
            }
        } catch (Exception ignored) {
        } finally {
            if (sock != null) try { sock.close(); } catch (Exception ignored) { }
            if (lock != null) try { if (lock.isHeld()) lock.release(); } catch (Exception ignored) { }
        }
        // the description file each one points to: its name, maker and model (at most 24, 1.5 s each, in parallel)
        List<Future<?>> fs = new ArrayList<>();
        int n = 0;
        for (Map.Entry<String, String> e : locs.entrySet()) {
            if (n++ >= 24) break;
            final String ip = e.getKey(), loc = e.getValue();
            fs.add(io.submit(() -> {
                HttpURLConnection c = null;
                try {
                    URL u = new URL(loc);
                    if (!ip.equals(u.getHost())) return;          // only the device's own description
                    c = (HttpURLConnection) net.openConnection(u);
                    c.setConnectTimeout(1500); c.setReadTimeout(1500);
                    java.io.InputStream is = c.getInputStream();
                    byte[] b = new byte[65536]; int len = 0, k;
                    while (len < b.length && (k = is.read(b, len, b.length - len)) > 0) len += k;
                    String xml = new String(b, 0, len, StandardCharsets.UTF_8);
                    String[] v = out.get(ip);
                    if (v != null) {
                        v[2] = firstTag(tagPattern("friendlyName"), xml);
                        v[3] = firstTag(tagPattern("manufacturer"), xml);
                        v[4] = (firstTag(tagPattern("modelName"), xml) + " " + firstTag(tagPattern("modelNumber"), xml)).trim();
                        v[5] = firstTag(tagPattern("deviceType"), xml);
                    }
                } catch (Exception ignored) {
                } finally { if (c != null) c.disconnect(); }
            }));
        }
        long dl = SystemClock.elapsedRealtime() + 4000;
        for (Future<?> f : fs) { try { f.get(Math.max(1, dl - SystemClock.elapsedRealtime()), TimeUnit.MILLISECONDS); } catch (Exception ignored) { } }
        return out;
    }

    /* ---------- ONVIF WS-Discovery: "any network video transmitters out there?" ---------- */

    private static final String PROBE_TEMPLATE =
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
        + "<e:Envelope xmlns:e=\"http://www.w3.org/2003/05/soap-envelope\""
        + " xmlns:w=\"http://schemas.xmlsoap.org/ws/2004/08/addressing\""
        + " xmlns:d=\"http://schemas.xmlsoap.org/ws/2005/04/discovery\""
        + " xmlns:dn=\"http://www.onvif.org/ver10/network/wsdl\""
        + " xmlns:tds=\"http://www.onvif.org/ver10/device/wsdl\">"
        + "<e:Header>"
        + "<w:MessageID>uuid:%s</w:MessageID>"
        + "<w:To e:mustUnderstand=\"true\">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>"
        + "<w:Action e:mustUnderstand=\"true\">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>"
        + "</e:Header>"
        + "<e:Body><d:Probe><d:Types>%s</d:Types></d:Probe></e:Body>"
        + "</e:Envelope>";

    private static final Pattern XADDRS = tagPattern("XAddrs");
    private static final Pattern SCOPES = tagPattern("Scopes");

    private static Pattern tagPattern(String tag) {
        return Pattern.compile("<(?:[A-Za-z0-9_.-]+:)?" + tag + "(?:\\s[^>]*)?>([^<]*)</(?:[A-Za-z0-9_.-]+:)?" + tag + "\\s*>", Pattern.DOTALL);
    }

    private static String firstTag(Pattern p, String xml) {
        Matcher m = p.matcher(xml);
        return m.find() ? m.group(1).trim().replaceAll("\\s+", " ") : "";
    }

    /** Returns ip -> {xaddrs, scopes} for every device that answered. Never throws. */
    private Map<String, String[]> onvifProbe(Network net, Inet4Address self) {
        Map<String, String[]> out = new HashMap<>();
        WifiManager.MulticastLock lock = null;
        MulticastSocket sock = null;
        try {
            WifiManager wm = wifi();
            if (wm != null) {
                lock = wm.createMulticastLock("twingaze-onvif");
                lock.setReferenceCounted(false);
                lock.acquire();                            // many phones drop multicast replies without this
            }
            sock = new MulticastSocket(0);                 // any free port; cameras answer here by unicast
            try { net.bindSocket(sock); } catch (Exception ignored) { }
            try {
                NetworkInterface nif = NetworkInterface.getByInetAddress(self);
                if (nif != null) sock.setNetworkInterface(nif);
            } catch (Exception ignored) { }

            InetAddress group = InetAddress.getByName("239.255.255.250");
            // Some cameras only answer a probe for "NetworkVideoTransmitter", others only for "Device".
            List<DatagramPacket> probes = new ArrayList<>();
            for (String type : new String[] { "dn:NetworkVideoTransmitter", "tds:Device" }) {
                byte[] b = String.format(Locale.US, PROBE_TEMPLATE, UUID.randomUUID().toString(), type).getBytes(StandardCharsets.UTF_8);
                probes.add(new DatagramPacket(b, b.length, group, 3702));
            }
            for (DatagramPacket p : probes) { try { sock.send(p); } catch (Exception ignored) { } }

            long start = SystemClock.elapsedRealtime();
            long deadline = start + ONVIF_LISTEN_MS;
            boolean resent = false;
            byte[] buf = new byte[65535];
            while (true) {
                long now = SystemClock.elapsedRealtime();
                long left = deadline - now;
                if (left <= 0) break;
                if (!resent && now - start > 700) {         // UDP can get lost: say it once more
                    resent = true;
                    for (DatagramPacket p : probes) { try { sock.send(p); } catch (Exception ignored) { } }
                }
                sock.setSoTimeout((int) Math.max(50, Math.min(left, 400)));
                DatagramPacket in = new DatagramPacket(buf, buf.length);
                try { sock.receive(in); } catch (SocketTimeoutException e) { continue; }
                if (in.getAddress() == null) continue;
                String xml = new String(in.getData(), in.getOffset(), in.getLength(), StandardCharsets.UTF_8);
                if (!xml.contains("ProbeMatch")) continue;  // ignore anything that isn't an answer
                String from = in.getAddress().getHostAddress();
                String xaddrs = firstTag(XADDRS, xml);
                String scopes = firstTag(SCOPES, xml);
                String[] prev = out.get(from);
                if (prev == null) out.put(from, new String[] { xaddrs, scopes });
                else {
                    if (prev[0].isEmpty()) prev[0] = xaddrs;
                    if (prev[1].isEmpty()) prev[1] = scopes;
                }
            }
        } catch (Exception ignored) {
            // multicast blocked or network gone: just return whatever arrived
        } finally {
            if (sock != null) try { sock.close(); } catch (Exception ignored) { }
            if (lock != null) try { if (lock.isHeld()) lock.release(); } catch (Exception ignored) { }
        }
        return out;
    }
}
