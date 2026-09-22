package com.aymane.binancemanager;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

/**
 * After a reboot, bring the foreground service back if the user enabled the
 * built-in server. The Node.js engine itself is started by the app UI, so the
 * service's notification invites the user to tap and resume; opening the app
 * restarts the engine automatically.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        SharedPreferences prefs = context.getSharedPreferences(EngineService.PREFS, Context.MODE_PRIVATE);
        if (prefs.getBoolean(EngineService.PREF_AUTOSTART, false)) {
            EngineService.start(context);
        }
    }
}
