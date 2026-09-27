package in.teamragnarok.twingaze;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

import androidx.core.content.ContextCompat;

/** "SOS" in the Quick Settings panel: swipe down, tap it, and the SOS countdown starts, app closed or not. */
public class TwinSosTile extends TileService {

    @Override
    public void onStartListening() {
        Tile t = getQsTile();
        if (t == null) return;
        t.setState(Tile.STATE_ACTIVE);
        t.setLabel("SOS");
        if (Build.VERSION.SDK_INT >= 29) t.setSubtitle("TwinGaze");
        t.updateTile();
    }

    @Override
    public void onClick() {
        Intent i = new Intent(this, TwinProtectService.class).setAction(TwinProtectService.ACT_SOS).putExtra("why", "Quick Settings tile");
        try {
            ContextCompat.startForegroundService(this, i);
        } catch (Exception e) {
            // Android refused a background start: open TwinGaze on its SOS sheet instead
            Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("twingaze.open", "sos");
            try {
                if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this, 90, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
                else startActivityAndCollapse(open);
            } catch (Exception ignored) { }
        }
    }
}
