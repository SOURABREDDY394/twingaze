package in.teamragnarok.twingaze;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.content.ContextCompat;

/** After a restart, protection outside the app comes back on by itself if it was on. */
public class TwinBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        if (i == null || !Intent.ACTION_BOOT_COMPLETED.equals(i.getAction())) return;
        try {
            if (!c.getSharedPreferences(TwinProtectService.PREFS, Context.MODE_PRIVATE).getBoolean("on", false)) return;
            ContextCompat.startForegroundService(c, new Intent(c, TwinProtectService.class).setAction(TwinProtectService.ACT_START));
        } catch (Exception ignored) { }    // a phone may refuse starts at boot: it comes back when TwinGaze is opened
    }
}
