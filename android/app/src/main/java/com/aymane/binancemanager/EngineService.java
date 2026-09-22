package com.aymane.binancemanager;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Foreground service that keeps this process (and the embedded Node.js server
 * running inside it) alive while the app is in the background or the screen is
 * off. Android shows a persistent notification while it runs.
 */
public class EngineService extends Service {
    public static final String CHANNEL_ID = "binance-manager-engine";
    public static final int NOTIFICATION_ID = 4471;
    public static final String PREFS = "binance-manager";
    public static final String PREF_AUTOSTART = "engine.autostart";

    private static volatile boolean running = false;
    private PowerManager.WakeLock wakeLock;

    public static boolean isRunning() {
        return running;
    }

    public static void start(Context context) {
        Intent intent = new Intent(context, EngineService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, EngineService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        acquireWakeLock();
        running = true;
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void acquireWakeLock() {
        if (wakeLock != null) return;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm == null) return;
        // Partial wake lock: CPU keeps ticking for the 15-second checks while the screen is off.
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BinanceManager:engine");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Trading server", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while the built-in trading server is running");
        channel.setShowBadge(false);
        nm.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, piFlags);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        return b.setContentTitle("Binance Manager is running")
            .setContentText("Stop ladders and bots are being watched. Tap to open.")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(tap)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build();
    }
}
