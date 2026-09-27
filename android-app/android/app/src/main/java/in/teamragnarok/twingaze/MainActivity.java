package in.teamragnarok.twingaze;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TwinNativePlugin.class);
        registerPlugin(TwinRadioPlugin.class);
        registerPlugin(TwinGuardPlugin.class);
        registerPlugin(TwinProtectPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
