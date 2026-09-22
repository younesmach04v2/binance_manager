package com.aymane.binancemanager;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** Lets the web UI control the foreground service and the battery/notification permissions it needs. */
@CapacitorPlugin(
    name = "KeepAlive",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class KeepAlivePlugin extends Plugin {

    /**
     * The embedded Node.js engine can be started only once per process, but Android may recreate the
     * screen (and its JavaScript) many times while the process lives on. This flag outlives screens.
     */
    private static volatile boolean engineStarted = false;

    @PluginMethod
    public void engineStarted(PluginCall call) {
        JSObject o = new JSObject();
        o.put("started", engineStarted);
        call.resolve(o);
    }

    @PluginMethod
    public void markEngineStarted(PluginCall call) {
        engineStarted = true;
        call.resolve();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(EngineService.PREFS, Context.MODE_PRIVATE);
    }

    private JSObject status() {
        Context ctx = getContext();
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        boolean unrestricted = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        boolean notifications = Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED;
        JSObject o = new JSObject();
        o.put("running", EngineService.isRunning());
        o.put("autoStart", prefs().getBoolean(EngineService.PREF_AUTOSTART, false));
        o.put("batteryUnrestricted", unrestricted);
        o.put("notificationsGranted", notifications);
        return o;
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void start(PluginCall call) {
        prefs().edit().putBoolean(EngineService.PREF_AUTOSTART, true).apply();
        EngineService.start(getContext());
        call.resolve(status());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        prefs().edit().putBoolean(EngineService.PREF_AUTOSTART, false).apply();
        EngineService.stop(getContext());
        call.resolve(status());
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationsResult");
        } else {
            JSObject o = new JSObject();
            o.put("granted", true);
            call.resolve(o);
        }
    }

    @PermissionCallback
    private void notificationsResult(PluginCall call) {
        JSObject o = new JSObject();
        o.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(o);
    }

    /** Opens the system dialog that exempts the app from battery optimisation (needed so Doze does not pause the server). */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        Context ctx = getContext();
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName())) {
            call.resolve(status());
            return;
        }
        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        intent.setData(Uri.parse("package:" + ctx.getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getActivity().startActivity(intent);
        } catch (Exception e) {
            Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(fallback);
        }
        call.resolve(status());
    }
}
