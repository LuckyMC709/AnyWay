package expo.modules.blemesh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Foreground lifecycle owner for the process-wide nearby-radio runtimes. The Expo
 * module is only a facade, so a React bridge or Activity recreation does not
 * itself tear down scanning, advertising, GATT links, or the bounded native
 * fragment queues.
 *
 * START_STICKY lets Android recreate this service after a recoverable process
 * death. The runtime restores radios only when an explicit start() persisted
 * the desired-session bit; otherwise the service removes its notification and
 * exits. Android never restarts an app after user force-stop, and OEM battery
 * policy, revoked permissions, disabled Bluetooth, or reboot can still prevent
 * restoration. This service does not run the JS routing/store-and-forward
 * engine headlessly, and its volatile native event buffer is not durable
 * messaging. The notification only claims that nearby links are being sought.
 */
class AnywayForegroundService : Service() {
  companion object {
    private const val CHANNEL_ID = "ble_mesh_active"
    private const val NOTIFICATION_ID = 4201
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ensureChannel()
    val notification = buildNotification()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Exception) {
      // A foreground service may not legitimately remain alive without its
      // required foreground notification/permission contract.
      BleMeshRuntimeRegistry.peek()?.setForegroundServiceActive(false)
      stopSelf(startId)
      return START_NOT_STICKY
    }

    val bleActive = try {
      BleMeshRuntimeRegistry.get(applicationContext).ensureSessionForForegroundService()
    } catch (_: Exception) { false }
    val wifiAwareActive = try {
      WifiAwareRuntimeRegistry.get(applicationContext).ensureSessionForForegroundService()
    } catch (_: Exception) { false }
    val sessionActive = bleActive || wifiAwareActive
    if (!sessionActive) {
      BleMeshRuntimeRegistry.peek()?.setForegroundServiceActive(false)
      WifiAwareRuntimeRegistry.peek()?.setForegroundServiceActive(false)
      @Suppress("DEPRECATION")
      stopForeground(true)
      stopSelf(startId)
      return START_NOT_STICKY
    }
    BleMeshRuntimeRegistry.peek()?.setForegroundServiceActive(true)
    WifiAwareRuntimeRegistry.peek()?.setForegroundServiceActive(true)
    return START_STICKY
  }

  override fun onDestroy() {
    BleMeshRuntimeRegistry.peek()?.setForegroundServiceActive(false)
    WifiAwareRuntimeRegistry.peek()?.setForegroundServiceActive(false)
    super.onDestroy()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    // Re-registering an existing channel updates its user-visible name and
    // description while preserving the user's notification preferences.
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Búsqueda de enlaces Anyway",
      NotificationManager.IMPORTANCE_LOW
    ).apply {
      description = "Mantiene la búsqueda Bluetooth y Wi-Fi de enlaces cercanos"
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(): Notification {
    val openAppIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = openAppIntent?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
      )
    }

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Anyway")
      .setContentText("Buscando enlaces cercanos")
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .apply { contentIntent?.let { setContentIntent(it) } }
      .build()
  }
}
