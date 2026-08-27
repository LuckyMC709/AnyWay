package expo.modules.blemesh

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.net.wifi.aware.AttachCallback
import android.net.wifi.aware.DiscoverySessionCallback
import android.net.wifi.aware.PeerHandle
import android.net.wifi.aware.PublishConfig
import android.net.wifi.aware.PublishDiscoverySession
import android.net.wifi.aware.SubscribeConfig
import android.net.wifi.aware.SubscribeDiscoverySession
import android.net.wifi.aware.WifiAwareManager
import android.net.wifi.aware.WifiAwareSession
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import androidx.core.os.bundleOf
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ThreadLocalRandom

/** Reassembly state for one fragmented message coming from one peer. */
private class Reassembly(val total: Int, nowElapsedMs: Long) {
  val chunks = arrayOfNulls<ByteArray>(total)
  var received = 0
  var lastUpdatedElapsedMs = nowElapsedMs
}

/** Identity for one connectGatt attempt. The callback captures this object,
 *  which prevents a late callback for an old GATT from mutating a newer
 *  attempt to the same rotating BLE address within the same radio session. */
private class ConnectionAttempt(
  val generation: Long,
  val address: String,
  val startedElapsedMs: Long
) {
  @Volatile var gatt: BluetoothGatt? = null
}

/** One recently visible advertiser. This intentionally outlives a failed
 * connection so the scheduler can retry it without waiting for a new scan
 * callback, while still expiring stale rotating BLE addresses. */
private class PeerCandidate(
  var device: BluetoothDevice,
  val address: String,
  var rssi: Int?,
  val firstSeenElapsedMs: Long,
  var lastSeenElapsedMs: Long
) {
  var lastDiscoveryEventElapsedMs = 0L
  var lastAttemptElapsedMs: Long? = null
  var nextEligibleElapsedMs = 0L
  var consecutiveFailures = 0
  var lastFailureStage: String? = null
}

private data class ConnectOperation(
  val generation: Long,
  val candidate: PeerCandidate,
  val attempt: ConnectionAttempt
)

private data class SchedulerMaintenance(
  val expiredCandidates: List<String>,
  val expiredReassemblies: Int,
  val connectOperation: ConnectOperation?,
  val budgetFull: Boolean
)

private data class ClientWriteOperation(
  val gatt: BluetoothGatt,
  val payload: ByteArray,
  val token: Long
)

private data class ClientWriteInFlight(
  val gatt: BluetoothGatt,
  val token: Long
)

private data class ServerNotifyOperation(
  val server: BluetoothGattServer,
  val device: BluetoothDevice,
  val characteristic: BluetoothGattCharacteristic,
  val address: String,
  val payload: ByteArray,
  val token: Long
)

/**
 * Dual-role BLE transport: every device simultaneously advertises + runs a
 * GATT server (peripheral role, for centrals that connect to it) and scans +
 * connects out to other advertisers (central role). This lets any two nearby
 * phones link up regardless of which one "discovers" the other first, which
 * is what a peer-to-peer mesh needs (there is no fixed client/server phone).
 *
 * Known simplification: if two devices discover each other at roughly the
 * same time they may end up with two redundant links (A as central of B, and
 * B as central of A) instead of exactly one. Both directions share the same
 * logical peer address and the JS mesh layer de-duplicates messages by id,
 * but the duplicate still consumes extra radio resources. Eliminating it
 * requires exchanging stable node ids before connecting, which BLE's 31-byte
 * legacy advertisement doesn't leave room for here — left as a future improvement.
 */
internal class BleMeshRuntime(private val context: Context) {
  companion object {
    // Anyway protocol identity. Keep these stable across releases and never
    // reuse BLEChat UUIDs: both apps may be installed and active together.
    val SERVICE_UUID: UUID = UUID.fromString("c8f6de10-7936-472b-9a8b-446c0c8d0ad2")
    val CHARACTERISTIC_UUID: UUID = UUID.fromString("d4016952-78b2-4e21-8fc7-36b37e529a04")
    val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    // 16-bit fragment index/count avoids the old 255-fragment ceiling. At the
    // mandatory 23-byte ATT MTU this permits 512 * 14 = 7168 message bytes;
    // larger negotiated MTUs need far fewer GATT operations.
    const val HEADER_SIZE = 6
    const val DEFAULT_MTU = 23

    /**
     * The Bluetooth spec caps a GATT attribute value at 512 octets regardless of
     * the negotiated ATT MTU. With MTU 517 the old `mtu - 3` sizing produced
     * 514-byte fragments, and Android silently truncated them to 512 — the
     * notification/write still reported success, so a two-byte hole appeared in
     * the middle of every multi-fragment message. Single-fragment traffic was
     * unaffected, which is why handshake challenges arrived intact while the
     * larger signed responses failed verification on both peers.
     */
    const val MAX_ATTRIBUTE_VALUE_BYTES = 512

    /** Minimum spacing between sampled per-fragment diagnostics. */
    const val FRAGMENT_DIAGNOSTIC_INTERVAL_MS = 1_000L

    /** Service name used only by the Wi-Fi Aware reachability probe. */
    const val AWARE_PROBE_SERVICE = "anyway-probe"
    const val MAX_QUEUED_FRAGMENTS_PER_PEER = 512
    const val MAX_FRAGMENTS_PER_MESSAGE = 512
    const val BASELINE_MAX_MESSAGE_BYTES =
      MAX_FRAGMENTS_PER_MESSAGE * (DEFAULT_MTU - 3 - HEADER_SIZE)
    // ATT protocol error 0x11. Android exposes no BluetoothGatt constant for
    // this response even though BluetoothGattServer.sendResponse accepts it.
    const val GATT_INSUFFICIENT_RESOURCES_STATUS = 0x11
    const val MAX_REASSEMBLIES_PER_PEER = 32
    const val CONNECTION_WATCHDOG_MS = 15_000L
    const val CLIENT_WRITE_WATCHDOG_MS = 5_000L
    const val SERVER_NOTIFY_WATCHDOG_MS = 5_000L
    const val MAX_LOGICAL_LINKS = 6
    const val MAX_CONCURRENT_CONNECT_GATT = 1
    const val MIN_CONNECT_GAP_MS = 2_000L
    const val INITIAL_RETRY_BACKOFF_MS = 2_000L
    const val MAX_RETRY_BACKOFF_MS = 120_000L
    const val CANDIDATE_TTL_MS = 120_000L

    /**
     * Android rotates a device's BLE address, so the scanner accumulates several
     * addresses that all point at the same phone; every stale one is dead on
     * arrival and fails with GATT error 133 after several seconds. Because only
     * one connectGatt runs at a time, dialing ghosts for the full candidate TTL
     * starves the real peer. A phone that is genuinely advertising is re-observed
     * every few seconds, so only recently seen addresses are worth dialing.
     * Entries are still retained for CANDIDATE_TTL_MS to keep their RSSI and
     * backoff state; this window only gates *initiating* a connection.
     */
    const val CANDIDATE_CONNECT_FRESHNESS_MS = 20_000L
    const val REASSEMBLY_TTL_MS = 30_000L
    const val TOPOLOGY_MAINTENANCE_MS = 10_000L
    const val DISCOVERY_EVENT_INTERVAL_MS = 2_000L
    const val BUDGET_DIAGNOSTIC_INTERVAL_MS = 15_000L
    const val MAX_DEFERRED_MESSAGE_EVENTS = 256
    private const val PREFERENCES_NAME = "anyway_ble_mesh_runtime"
    private const val SESSION_DESIRED_KEY = "session_desired"
  }

  @Volatile private var eventSink: ((String, Bundle) -> Unit)? = null
  @Volatile private var messageDeliveryEnabled = false
  private val eventSinkLock = Any()
  private val deferredMessageEvents = ArrayDeque<Bundle>()

  private var adapter: BluetoothAdapter? = null
  private var scanner: BluetoothLeScanner? = null
  private var advertiser: BluetoothLeAdvertiser? = null
  private var gattServer: BluetoothGattServer? = null
  private var serverCharacteristic: BluetoothGattCharacteristic? = null
  private var scanCallback: ScanCallback? = null
  private var advertiseCallback: AdvertiseCallback? = null
  private var gattServerCallback: BluetoothGattServerCallback? = null
  private var adapterStateReceiver: BroadcastReceiver? = null

  /** Every native callback captures the generation that created it. A stop or
   *  a new start increments this value before touching resources, so delayed
   *  callbacks from an older Android BLE session become harmless no-ops. */
  private val lifecycleLock = Any()
  @Volatile private var sessionGeneration = 0L
  @Volatile private var isStarting = false
  @Volatile private var isRunning = false
  @Volatile private var isScanning = false
  @Volatile private var isAdvertising = false
  @Volatile private var isGattServerReady = false
  @Volatile private var lastScanError: Int? = null
  @Volatile private var lastAdvertisingError: Int? = null
  @Volatile private var lastGattError: Int? = null
  @Volatile private var lastGattFailureStage: String? = null
  @Volatile private var lastStartError: String? = null
  @Volatile private var lastFailureStage: String? = null
  @Volatile private var restoredByForegroundService = false
  @Volatile private var foregroundServiceActive = false

  // address -> BluetoothGatt for links where we are the central (we connected out).
  private val outgoingConnections = ConcurrentHashMap<String, BluetoothGatt>()
  // address -> BluetoothDevice for links where we are the peripheral (they connected to us).
  private val incomingDevices = ConcurrentHashMap<String, BluetoothDevice>()
  // Incoming devices that have subscribed (enabled the notify CCCD) so we may push to them.
  private val notifyEnabled = ConcurrentHashMap.newKeySet<String>()
  // Outgoing links whose service + CCCD discovery completed successfully.
  private val outgoingReady = ConcurrentHashMap.newKeySet<String>()
  // Addresses we've already announced as "connected" to JS, to avoid duplicate events
  // when a pair ends up with both an incoming and an outgoing link.
  private val notifiedConnected = ConcurrentHashMap.newKeySet<String>()
  private val rssiByAddress = ConcurrentHashMap<String, Int>()
  // MTU is negotiated independently for each GATT direction. Collapsing both
  // values could fragment a notification using the client-side MTU (or vice
  // versa), which is not valid when the pair has redundant bidirectional
  // links.
  private val outgoingMtuByAddress = ConcurrentHashMap<String, Int>()
  /** Addresses whose MTU request has already been retried once after landing at the floor. */
  private val mtuRetriedAddresses = java.util.Collections.synchronizedSet(mutableSetOf<String>())
  private val incomingMtuByAddress = ConcurrentHashMap<String, Int>()
  private val candidates = ConcurrentHashMap<String, PeerCandidate>()
  private val connectionAttempts = ConcurrentHashMap<String, ConnectionAttempt>()
  // Connections returned by connectGatt() but not connected/ready yet. They
  // must also be closed during stop; outgoingConnections alone is too late.
  private val pendingConnections = ConcurrentHashMap<String, BluetoothGatt>()
  private val serviceDiscoveryStarted = ConcurrentHashMap.newKeySet<BluetoothGatt>()
  private val mainHandler = Handler(Looper.getMainLooper())
  private var activeConnectionAttempt: ConnectionAttempt? = null
  private var topologySchedulerRunnable: Runnable? = null
  private var topologySchedulerDueElapsedMs = Long.MAX_VALUE
  private var lastConnectGattStartedElapsedMs = Long.MIN_VALUE
  private var lastBudgetDiagnosticElapsedMs = Long.MIN_VALUE
  private val incomingSubscriptionTokens = ConcurrentHashMap<String, Long>()
  private var nextIncomingSubscriptionToken = 0L

  private val clientWriteQueues = ConcurrentHashMap<String, ArrayDeque<ByteArray>>()
  private val clientWriteInFlight = ConcurrentHashMap<String, ClientWriteInFlight>()
  /** One allocator for BOTH the client-write and the server-notify paths.
   *  They share pendingWatchdogs as a keyspace, so two counters — which both
   *  start at 0, both step by 1, and both reset together on a session bump —
   *  hand out the same token to a write and a notification that are in flight
   *  at the same time. The second registration then silently replaces the
   *  first, and cancelWatchdog() cancels the wrong path: one operation loses
   *  the timeout that was meant to rescue it while the other keeps a timer
   *  that fires against an operation which already finished.
   *  Protected by lifecycleLock, like both allocation sites. */
  private var nextOperationToken = 0L
  private val serverNotifyQueues = ConcurrentHashMap<String, ArrayDeque<ByteArray>>()
  /** Addresses with pending server notifications, ordered by their next turn.
   * Protected by lifecycleLock. At most one entry exists per address. */
  private val serverNotifyRoundRobin = ArrayDeque<String>()
  /** Android's GATT server permits one notification operation at a time for
   *  the whole server, not one per peer. Protected by lifecycleLock. */
  private var serverNotifyInFlightAddress: String? = null
  private var serverNotifyInFlightToken: Long? = null

  // remoteAddress -> messageId -> in-progress reassembly.
  private val reassemblyBuffers = ConcurrentHashMap<String, ConcurrentHashMap<Int, Reassembly>>()
  /** Live watchdog runnables by operation token, so a completed op can cancel its own. */
  private val pendingWatchdogs = ConcurrentHashMap<Long, Runnable>()

  private val fragmentDiagnosticLock = Any()
  private var lastFragmentDiagnosticElapsedMs = Long.MIN_VALUE

  private val messageIdLock = Any()
  private var nextMessageId = 0

  fun attachEventSink(sink: (String, Bundle) -> Unit) {
    synchronized(eventSinkLock) {
      if (eventSink !== sink) messageDeliveryEnabled = false
      eventSink = sink
    }
  }

  fun enableMessageDelivery(sink: (String, Bundle) -> Unit) {
    synchronized(eventSinkLock) {
      eventSink = sink
      messageDeliveryEnabled = true
      // Dispatch under this short lock so a newly received message cannot
      // overtake older messages buffered while React was unavailable.
      while (deferredMessageEvents.isNotEmpty()) {
        sink("onMessageReceived", deferredMessageEvents.removeFirst())
      }
    }
  }

  fun detachEventSink(sink: (String, Bundle) -> Unit) {
    synchronized(eventSinkLock) {
      if (eventSink === sink) {
        eventSink = null
        messageDeliveryEnabled = false
      }
    }
  }

  fun disableMessageDelivery(sink: (String, Bundle) -> Unit) {
    synchronized(eventSinkLock) {
      if (eventSink === sink) messageDeliveryEnabled = false
    }
  }

  private fun sendEvent(name: String, payload: Bundle) {
    val sink = synchronized(eventSinkLock) {
      val current = eventSink
      if (name == "onMessageReceived" && (current == null || !messageDeliveryEnabled)) {
        if (deferredMessageEvents.size >= MAX_DEFERRED_MESSAGE_EVENTS) {
          deferredMessageEvents.removeFirst()
        }
        deferredMessageEvents.addLast(Bundle(payload))
        return@synchronized null
      }
      current
    }
    sink?.invoke(name, payload)
  }

  // -------------------------------------------------------------------------
  // Permissions / adapter helpers
  // -------------------------------------------------------------------------

  fun hasRequiredPermissions(): Boolean = hasPermissions()

  fun isBluetoothEnabled(): Boolean = try {
    adapterOrNull()?.isEnabled ?: false
  } catch (_: Exception) {
    false
  }

  fun requestEnableBluetooth() {
    try {
      val intent = Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    } catch (_: Exception) {
      // JS re-checks isBluetoothEnabled() afterwards.
    }
  }

  fun getRadioState(): Bundle = radioStateBundle()

  fun getCapabilities(): Bundle = capabilitiesBundle()

  fun getLinkSnapshots(): List<Bundle> = linkSnapshots()

  fun getConnectedPeers(): List<Bundle> = connectedPeersList()

  fun sendToPeerBase64(address: String, base64Data: String): Boolean {
    val bytes = Base64.decode(base64Data, Base64.NO_WRAP)
    return sendToPeer(address, bytes)
  }

  /**
   * Drops one endpoint on request. Android rotates BLE addresses, so the same
   * phone can be reached under several of them at once and each one negotiates
   * its own MTU, handshake and capability exchange in parallel — which is how a
   * two-phone mesh ended up with four logical links competing for one radio.
   * Only the identity layer in JS can tell that two addresses are the same peer,
   * so it needs a way to hang up the redundant one.
   */
  fun disconnectPeer(address: String) {
    val generation = synchronized(lifecycleLock) { sessionGeneration }
    val outgoing = synchronized(lifecycleLock) { outgoingConnections[address] }
    if (outgoing != null) {
      synchronized(lifecycleLock) {
        outgoingReady.remove(address)
        outgoingConnections.remove(address, outgoing)
        clientWriteQueues.remove(address)
        clientWriteInFlight.remove(address)
        outgoingMtuByAddress.remove(address)
              mtuRetriedAddresses.remove(address)
        serviceDiscoveryStarted.remove(outgoing)
      }
      disconnectAndCloseGatt(outgoing)
    }
    val incomingDevice = synchronized(lifecycleLock) {
      notifyEnabled.remove(address)
      removeServerNotifyQueueLocked(address)
      incomingMtuByAddress.remove(address)
      incomingSubscriptionTokens.remove(address)
      incomingDevices.remove(address)
    }
    val server = synchronized(lifecycleLock) { gattServer }
    if (incomingDevice != null && server != null) {
      try {
        server.cancelConnection(incomingDevice)
      } catch (_: Exception) {
      }
    }
    emitDiagnostic(generation, "duplicate-link-dropped", address = address)
    notifyPeerDisconnectedIfFullyGone(generation, address)
    scheduleTopologyEvaluation(generation, MIN_CONNECT_GAP_MS)
  }

  /**
   * Answers one question with evidence instead of a capability flag: can these
   * two phones actually find each other over Wi-Fi Aware? `isAvailable` only
   * says the service exists, which is why the reports kept showing "supported"
   * while nothing had ever been attempted. This attaches a real session,
   * publishes and subscribes to a probe service, and reports how far it got —
   * without opening a data path, which is the expensive part worth deferring
   * until discovery is proven.
   */
  fun probeWifiAware(timeoutMs: Long, onResult: (Bundle) -> Unit) {
    val result = Bundle().apply {
      putBoolean("supported", false)
      putBoolean("available", false)
      putBoolean("permissionGranted", false)
      putBoolean("attached", false)
      putBoolean("published", false)
      putBoolean("subscribed", false)
      putInt("peersDiscovered", 0)
    }

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      result.putString("error", "Wi-Fi Aware requiere Android 8 o superior.")
      onResult(result)
      return
    }
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE)) {
      result.putString("error", "Este teléfono no tiene hardware de Wi-Fi Aware.")
      onResult(result)
      return
    }
    result.putBoolean("supported", true)

    val permission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      "android.permission.NEARBY_WIFI_DEVICES"
    } else {
      android.Manifest.permission.ACCESS_FINE_LOCATION
    }
    if (context.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
      result.putString(
        "error",
        "Falta el permiso $permission. Concedelo y volvé a probar."
      )
      onResult(result)
      return
    }
    result.putBoolean("permissionGranted", true)

    val manager = context.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager
    if (manager == null || !manager.isAvailable) {
      result.putString(
        "error",
        "Wi-Fi Aware no está disponible ahora. Suele ser el Wi-Fi apagado, o que el " +
          "teléfono está usando Wi-Fi Direct, zona portátil o compartir conexión."
      )
      onResult(result)
      return
    }
    result.putBoolean("available", true)

    val handler = Handler(Looper.getMainLooper())
    val finished = java.util.concurrent.atomic.AtomicBoolean(false)
    var session: WifiAwareSession? = null
    var publishSession: PublishDiscoverySession? = null
    var subscribeSession: SubscribeDiscoverySession? = null
    val peers = java.util.Collections.synchronizedSet(mutableSetOf<PeerHandle>())

    fun finish(error: String?) {
      if (!finished.compareAndSet(false, true)) return
      handler.removeCallbacksAndMessages(null)
      try {
        publishSession?.close()
        subscribeSession?.close()
        session?.close()
      } catch (_: Exception) {
      }
      result.putInt("peersDiscovered", peers.size)
      if (error != null) result.putString("error", error)
      onResult(result)
    }

    handler.postDelayed({ finish(null) }, timeoutMs)

    try {
      manager.attach(
        object : AttachCallback() {
          override fun onAttached(attached: WifiAwareSession) {
            if (finished.get()) {
              try {
                attached.close()
              } catch (_: Exception) {
              }
              return
            }
            session = attached
            result.putBoolean("attached", true)

            val discovery = object : DiscoverySessionCallback() {
              override fun onPublishStarted(discoverySession: PublishDiscoverySession) {
                publishSession = discoverySession
                result.putBoolean("published", true)
              }

              override fun onSubscribeStarted(discoverySession: SubscribeDiscoverySession) {
                subscribeSession = discoverySession
                result.putBoolean("subscribed", true)
              }

              override fun onServiceDiscovered(
                peerHandle: PeerHandle,
                serviceSpecificInfo: ByteArray?,
                matchFilter: MutableList<ByteArray>?
              ) {
                peers.add(peerHandle)
                result.putInt("peersDiscovered", peers.size)
              }

              override fun onSessionConfigFailed() {
                finish("El teléfono rechazó la configuración de publish/subscribe.")
              }
            }

            try {
              attached.publish(
                PublishConfig.Builder().setServiceName(AWARE_PROBE_SERVICE).build(),
                discovery,
                handler
              )
              attached.subscribe(
                SubscribeConfig.Builder().setServiceName(AWARE_PROBE_SERVICE).build(),
                discovery,
                handler
              )
            } catch (error: SecurityException) {
              finish("Permiso denegado al publicar: ${error.message}")
            } catch (error: Exception) {
              finish("Fallo al publicar/suscribir: ${error.message}")
            }
          }

          override fun onAttachFailed() {
            finish("No se pudo iniciar una sesión de Wi-Fi Aware.")
          }
        },
        handler
      )
    } catch (error: SecurityException) {
      finish("Permiso denegado al iniciar Wi-Fi Aware: ${error.message}")
    } catch (error: Exception) {
      finish("Error al iniciar Wi-Fi Aware: ${error.message}")
    }
  }

  private fun hasPermissions(): Boolean {
    val ctx = context
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.BLUETOOTH_SCAN) ==
        PackageManager.PERMISSION_GRANTED &&
        ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.BLUETOOTH_ADVERTISE) ==
        PackageManager.PERMISSION_GRANTED &&
        ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.BLUETOOTH_CONNECT) ==
        PackageManager.PERMISSION_GRANTED
    } else {
      ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    }
  }

  private fun adapterOrNull(): BluetoothAdapter? {
    val mgr = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    return mgr?.adapter
  }

  /** Must be called with lifecycleLock held. The receiver is generation-bound
   *  so an adapter event queued for an old session cannot tear down a newer
   *  one after an automatic restart. */
  private fun registerAdapterStateReceiverLocked(generation: Long) {
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(receiverContext: Context?, intent: Intent?) {
        if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
        val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
        if (state != BluetoothAdapter.STATE_OFF && state != BluetoothAdapter.STATE_TURNING_OFF) {
          return
        }
        failActiveSession(
          generation,
          stage = "adapter",
          errorCode = state,
          message = "Bluetooth adapter was turned off"
        )
      }
    }
    ContextCompat.registerReceiver(
      context,
      receiver,
      IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED),
      ContextCompat.RECEIVER_NOT_EXPORTED
    )
    adapterStateReceiver = receiver
  }

  // -------------------------------------------------------------------------
  // Start / stop
  // -------------------------------------------------------------------------

  fun startMesh(rememberDesiredSession: Boolean = true): Boolean {
    if (rememberDesiredSession) restoredByForegroundService = false
    var shouldEmit = false
    val accepted = synchronized(lifecycleLock) {
      if (isStarting || isRunning) {
        val sessionStillHealthy = try {
          hasPermissions() &&
            adapter?.isEnabled == true &&
            scanner != null &&
            advertiser != null &&
            gattServer != null &&
            (isStarting || (isScanning && isAdvertising && isGattServerReady))
        } catch (_: Exception) {
          false
        }
        if (sessionStillHealthy) return@synchronized true
        sessionGeneration += 1
        cleanupResourcesLocked(stopKeepAlive = false)
      }

      // Invalidate every callback/resource from a previous partial session.
      // cleanup is deliberately unconditional: a failed start may have
      // opened a GATT server or begun scanning before `isRunning` was true.
      sessionGeneration += 1
      cleanupResourcesLocked(stopKeepAlive = false)
      lastScanError = null
      lastAdvertisingError = null
      lastGattError = null
      lastGattFailureStage = null
      lastStartError = null
      lastFailureStage = null
      shouldEmit = true

      if (!hasPermissions()) {
        lastStartError = "Required Bluetooth permissions are missing"
        lastFailureStage = "permissions"
        shouldEmit = true
        return@synchronized false
      }

      try {
        val btManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
          ?: throw IllegalStateException("BluetoothManager is unavailable")
        val btAdapter = btManager.adapter
          ?: throw IllegalStateException("BluetoothAdapter is unavailable")
        if (!btAdapter.isEnabled) {
          lastStartError = "Bluetooth adapter is disabled"
          lastFailureStage = "adapter"
          shouldEmit = true
          return@synchronized false
        }

        adapter = btAdapter
        scanner = btAdapter.bluetoothLeScanner
        advertiser = btAdapter.bluetoothLeAdvertiser
        if (scanner == null) throw IllegalStateException("BLE scanner is unavailable")
        if (advertiser == null) throw IllegalStateException("BLE advertiser is unavailable")

        val generation = sessionGeneration
        registerAdapterStateReceiverLocked(generation)
        val serverCallback = createGattServerCallback(generation)
        val newAdvertiseCallback = createAdvertiseCallback(generation)
        val newScanCallback = createScanCallback(generation)
        gattServerCallback = serverCallback
        advertiseCallback = newAdvertiseCallback
        scanCallback = newScanCallback
        isStarting = true

        if (!setupGattServer(btManager, serverCallback)) {
          throw IllegalStateException("Could not open or configure the GATT server")
        }
        if (!isCurrentGeneration(generation)) return@synchronized false
        startAdvertising(newAdvertiseCallback)
        if (!isCurrentGeneration(generation)) return@synchronized false
        startScanning(newScanCallback)
        if (!isCurrentGeneration(generation)) return@synchronized false
        // Android has no positive scan-start callback. The request is
        // tentatively healthy unless onScanFailed() says otherwise.
        isScanning = true
        refreshLifecycleFlagsLocked()
        scheduleTopologyEvaluationLocked(generation, 0L)
        startForegroundKeepAlive()
        true
      } catch (e: Exception) {
        val error = "${e.javaClass.simpleName}: ${e.message ?: "BLE start failed"}"
        sessionGeneration += 1
        cleanupResourcesLocked()
        lastStartError = error
        lastFailureStage = "start"
        shouldEmit = true
        false
      }
    }
    if (rememberDesiredSession) setSessionDesired(accepted)
    if (!accepted) stopForegroundKeepAlive()
    if (shouldEmit) emitRadioState()
    return accepted
  }

  fun stopMesh(clearDesiredSession: Boolean = true) {
    if (clearDesiredSession) {
      setSessionDesired(false)
      restoredByForegroundService = false
      synchronized(eventSinkLock) { deferredMessageEvents.clear() }
    }
    synchronized(lifecycleLock) {
      sessionGeneration += 1
      cleanupResourcesLocked()
      // An explicit stop is a healthy terminal state, not a continuation of
      // the previous failure. In particular, restartMesh() must not receive
      // a stopped snapshot carrying an old error and mistake it for failure
      // of the new start attempt.
      lastScanError = null
      lastAdvertisingError = null
      lastGattError = null
      lastGattFailureStage = null
      lastStartError = null
      lastFailureStage = null
    }
    emitRadioState()
  }

  /** Called by the foreground service. A sticky restart is legitimate only
   * after a user-started session was persisted; merely recreating the service
   * must never show an "active mesh" notification with idle radios. */
  fun ensureSessionForForegroundService(): Boolean {
    val alreadyActive = synchronized(lifecycleLock) { isStarting || isRunning }
    if (alreadyActive) return true
    if (!isSessionDesired()) return false
    val restored = startMesh(rememberDesiredSession = false)
    restoredByForegroundService = restored
    return restored
  }

  fun setForegroundServiceActive(active: Boolean) {
    if (foregroundServiceActive == active) return
    foregroundServiceActive = active
    emitRadioState()
  }

  /** Stopping one radio must not remove the shared process owner while the
   * independent radio still has a user-requested session. */
  fun isDesiredOrActive(): Boolean = synchronized(lifecycleLock) {
    isSessionDesired() || isStarting || isRunning
  }

  private fun isSessionDesired(): Boolean = try {
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
      .getBoolean(SESSION_DESIRED_KEY, false)
  } catch (_: Exception) {
    false
  }

  private fun setSessionDesired(desired: Boolean) {
    try {
      context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
        .edit()
        .putBoolean(SESSION_DESIRED_KEY, desired)
        .commit()
    } catch (_: Exception) {
    }
  }

  /** Must be called with lifecycleLock held. Does not clear error fields so
   *  getRadioState() can explain why the previous session stopped. */
  private fun cleanupResourcesLocked(stopKeepAlive: Boolean = true) {
    isStarting = false
    isRunning = false
    isScanning = false
    isAdvertising = false
    isGattServerReady = false

    if (stopKeepAlive) stopForegroundKeepAlive()
    val oldScanner = scanner
    val oldScanCallback = scanCallback
    if (oldScanner != null && oldScanCallback != null) {
      try {
        oldScanner.stopScan(oldScanCallback)
      } catch (_: Exception) {
      }
    }
    val oldAdvertiser = advertiser
    val oldAdvertiseCallback = advertiseCallback
    if (oldAdvertiser != null && oldAdvertiseCallback != null) {
      try {
        oldAdvertiser.stopAdvertising(oldAdvertiseCallback)
      } catch (_: Exception) {
      }
    }

    val allClientGatts = (
      pendingConnections.values +
        outgoingConnections.values +
        connectionAttempts.values.mapNotNull { it.gatt }
      ).toSet()
    allClientGatts.forEach(::disconnectAndCloseGatt)
    val oldServer = gattServer
    incomingDevices.values.forEach { device ->
      try {
        oldServer?.cancelConnection(device)
      } catch (_: Exception) {
      }
    }
    try {
      oldServer?.close()
    } catch (_: Exception) {
    }

    outgoingConnections.clear()
    pendingConnections.clear()
    serviceDiscoveryStarted.clear()
    mainHandler.removeCallbacksAndMessages(null)
    pendingWatchdogs.clear()
    topologySchedulerRunnable = null
    topologySchedulerDueElapsedMs = Long.MAX_VALUE
    activeConnectionAttempt = null
    lastConnectGattStartedElapsedMs = Long.MIN_VALUE
    lastBudgetDiagnosticElapsedMs = Long.MIN_VALUE
    incomingSubscriptionTokens.clear()
    nextIncomingSubscriptionToken = 0L
    incomingDevices.clear()
    notifyEnabled.clear()
    outgoingReady.clear()
    notifiedConnected.forEach { address ->
      try {
        sendEvent("onPeerDisconnected", bundleOf("address" to address))
      } catch (_: Exception) {
      }
    }
    notifiedConnected.clear()
    clientWriteQueues.clear()
    clientWriteInFlight.clear()
    nextOperationToken = 0L
    serverNotifyQueues.clear()
    serverNotifyRoundRobin.clear()
    serverNotifyInFlightAddress = null
    serverNotifyInFlightToken = null
    reassemblyBuffers.clear()
    connectionAttempts.clear()
    candidates.clear()
    outgoingMtuByAddress.clear()
    mtuRetriedAddresses.clear()
    incomingMtuByAddress.clear()
    rssiByAddress.clear()

    gattServer = null
    serverCharacteristic = null
    scanner = null
    advertiser = null
    adapter = null
    scanCallback = null
    advertiseCallback = null
    gattServerCallback = null
    adapterStateReceiver?.let { receiver ->
      try {
        context.unregisterReceiver(receiver)
      } catch (_: Exception) {
      }
    }
    adapterStateReceiver = null
  }

  private fun refreshLifecycleFlagsLocked() {
    isRunning = isScanning && isAdvertising && isGattServerReady
    isStarting = !isRunning && (gattServer != null || isScanning || isAdvertising)
  }

  private fun isCurrentGeneration(generation: Long): Boolean =
    generation == sessionGeneration

  private fun failActiveSession(
    generation: Long,
    stage: String,
    errorCode: Int? = null,
    message: String? = null
  ) {
    var didFail = false
    synchronized(lifecycleLock) {
      if (!isCurrentGeneration(generation)) return@synchronized
      when (stage) {
        "scan" -> lastScanError = errorCode
        "advertising" -> lastAdvertisingError = errorCode
        else -> lastGattError = errorCode
      }
      if (stage != "scan" && stage != "advertising") lastGattFailureStage = stage
      sessionGeneration += 1
      cleanupResourcesLocked()
      lastFailureStage = stage
      if (message != null) lastStartError = message
      didFail = true
    }
    if (didFail) emitRadioState()
  }

  private fun recordGattError(generation: Long, stage: String, status: Int) {
    var changed = false
    synchronized(lifecycleLock) {
      if (!isCurrentGeneration(generation)) return@synchronized
      lastGattError = status
      lastGattFailureStage = stage
      changed = true
    }
    if (changed) emitRadioState()
  }

  private fun radioStateBundle(): android.os.Bundle = synchronized(lifecycleLock) {
    val bluetoothEnabled = try {
      adapter?.isEnabled ?: (adapterOrNull()?.isEnabled ?: false)
    } catch (_: Exception) {
      false
    }
    val permissionsGranted = try {
      hasPermissions()
    } catch (_: Exception) {
      false
    }
    val state = bundleOf(
      "bluetoothEnabled" to bluetoothEnabled,
      "hasPermissions" to permissionsGranted,
      "starting" to isStarting,
      "running" to isRunning,
      "scanning" to isScanning,
      "advertising" to isAdvertising,
      "gattServerReady" to isGattServerReady,
      "generation" to sessionGeneration,
      "connectedPeers" to notifiedConnected.size,
      "outgoingConnections" to outgoingReady.size,
      "incomingConnections" to notifyEnabled.size,
      "logicalLinks" to logicalLinkAddressesLocked().size,
      "logicalLinkBudget" to MAX_LOGICAL_LINKS,
      "occupiedLinkSlots" to occupiedLinkAddressesLocked().size,
      "candidateCount" to candidates.size,
      "connectGattInFlight" to (activeConnectionAttempt != null),
      "deferredMessages" to synchronized(eventSinkLock) { deferredMessageEvents.size },
      "restoredByForegroundService" to restoredByForegroundService,
      "foregroundServiceActive" to foregroundServiceActive
    )
    lastScanError?.let { state.putInt("scanError", it) }
    lastAdvertisingError?.let { state.putInt("advertisingError", it) }
    lastGattError?.let { state.putInt("gattError", it) }
    lastGattFailureStage?.let { state.putString("gattFailureStage", it) }
    val fatalError = lastScanError ?: lastAdvertisingError ?: when (lastFailureStage) {
      "gatt-server", "start" -> lastGattError
      else -> null
    }
    fatalError?.let { state.putInt("error", it) }
    lastFailureStage?.let { stage ->
      state.putString(
        "phase",
        when (stage) {
          "advertising" -> "advertising"
          "scan" -> "scanning"
          else -> "startup"
        }
      )
    }
    lastStartError?.let { state.putString("startError", it) }
    lastFailureStage?.let { state.putString("failureStage", it) }
    state
  }

  private fun emitRadioState() {
    try {
      sendEvent("onAdapterStateChanged", radioStateBundle())
    } catch (_: Exception) {
      // The Expo event sink may already be detached during bridge teardown.
    }
  }

  private fun logicalLinkAddressesLocked(): Set<String> =
    LinkedHashSet<String>().apply {
      addAll(outgoingReady)
      addAll(notifyEnabled)
    }

  /** Includes negotiations as reservations. Without this, an incoming CCCD
   * subscription racing an outgoing connect could push the logical topology
   * beyond the six-neighbour radio budget. Duplicate directions to the same
   * address consume only one logical slot. */
  private fun occupiedLinkAddressesLocked(): Set<String> =
    LinkedHashSet<String>().apply {
      addAll(logicalLinkAddressesLocked())
      addAll(incomingDevices.keys)
      addAll(outgoingConnections.keys)
      addAll(pendingConnections.keys)
      addAll(connectionAttempts.keys)
    }

  /**
   * Fragment-level diagnostics fire once per GATT operation. At the 23-byte
   * fallback MTU a single message spans hundreds of them, which floods the ring
   * buffer, hides everything else and burns CPU on the bridge. Rate-limiting by
   * time keeps the signal (traffic is flowing, and how big the frames are)
   * without the flood.
   */
  private fun shouldSampleFragmentDiagnostic(): Boolean {
    val now = SystemClock.elapsedRealtime()
    synchronized(fragmentDiagnosticLock) {
      if (now - lastFragmentDiagnosticElapsedMs < FRAGMENT_DIAGNOSTIC_INTERVAL_MS) return false
      lastFragmentDiagnosticElapsedMs = now
      return true
    }
  }

  private fun emitDiagnostic(
    generation: Long,
    type: String,
    address: String? = null,
    rssi: Int? = null,
    failureCount: Int? = null,
    retryInMs: Long? = null,
    stage: String? = null,
    count: Int? = null
  ) {
    val event = synchronized(lifecycleLock) {
      if (!isCurrentGeneration(generation)) return@synchronized null
      bundleOf(
        "type" to type,
        "timestampMs" to System.currentTimeMillis(),
        "generation" to generation,
        "transport" to "ble",
        "logicalLinks" to logicalLinkAddressesLocked().size,
        "occupiedLinkSlots" to occupiedLinkAddressesLocked().size,
        "linkBudget" to MAX_LOGICAL_LINKS,
        "candidateCount" to candidates.size,
        "connectGattInFlight" to (activeConnectionAttempt != null),
        "deferredMessages" to synchronized(eventSinkLock) { deferredMessageEvents.size }
      ).also { payload ->
        address?.let { payload.putString("address", it) }
        rssi?.let { payload.putInt("rssi", it) }
        failureCount?.let { payload.putInt("failureCount", it) }
        retryInMs?.let { payload.putDouble("retryInMs", it.toDouble()) }
        stage?.let { payload.putString("stage", it) }
        count?.let { payload.putInt("count", it) }
      }
    } ?: return
    try {
      sendEvent("onDiagnostic", event)
    } catch (_: Exception) {
      // The Expo event sink may be unavailable during bridge teardown.
    }
  }

  private fun capabilitiesBundle(): android.os.Bundle {
    val packageManager = context.packageManager
    val bluetoothAdapter = try {
      adapterOrNull()
    } catch (_: Exception) {
      null
    }
    val bluetoothEnabled = try {
      bluetoothAdapter?.isEnabled == true
    } catch (_: Exception) {
      false
    }
    val bleSupported = packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)
    val scannerAvailable = bluetoothEnabled && try {
      bluetoothAdapter?.bluetoothLeScanner != null
    } catch (_: Exception) {
      false
    }
    val multipleAdvertisingSupported = try {
      bluetoothAdapter?.isMultipleAdvertisementSupported == true
    } catch (_: Exception) {
      false
    }
    val advertiserAvailable = bluetoothEnabled && try {
      bluetoothAdapter?.bluetoothLeAdvertiser != null
    } catch (_: Exception) {
      false
    }

    val wifiAwareSupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE)
    val wifiAwareAvailable = wifiAwareSupported && try {
      isWifiAwareAvailableApi26()
    } catch (_: Exception) {
      false
    }
    val wifiDirectSupported = packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT)

    return bundleOf(
      "apiLevel" to Build.VERSION.SDK_INT,
      "manufacturer" to Build.MANUFACTURER,
      "model" to Build.MODEL,
      "activeTransport" to "ble",
      "serviceUuid" to SERVICE_UUID.toString(),
      "characteristicUuid" to CHARACTERISTIC_UUID.toString(),
      "maxLogicalLinks" to MAX_LOGICAL_LINKS,
      "maxConcurrentConnectGatt" to MAX_CONCURRENT_CONNECT_GATT,
      "baselineMaxMessageBytes" to BASELINE_MAX_MESSAGE_BYTES,
      "lifecycle" to bundleOf(
        "owner" to "radio-process-runtime",
        "radioReactBridgeIndependent" to true,
        "radioStickyServiceRestorationConfigured" to true,
        // Only the BLE radio/link runtime is native. Store-and-forward,
        // routing, encryption and durable message handling still live in JS.
        "messagingHeadlessDurable" to false,
        "survivesForceStop" to false,
        "survivesReboot" to false,
        "requiresRestartAfterBluetoothOff" to true
      ),
      "ble" to bundleOf(
        "supported" to bleSupported,
        "enabled" to bluetoothEnabled,
        "permissionsGranted" to try {
          hasPermissions()
        } catch (_: Exception) {
          false
        },
        "scanningSupported" to bleSupported,
        "scanningAvailable" to scannerAvailable,
        "advertisingSupported" to multipleAdvertisingSupported,
        "advertisingAvailable" to advertiserAvailable,
        "automaticTransport" to true
      ),
      "wifiAware" to bundleOf(
        "supported" to wifiAwareSupported,
        "available" to wifiAwareAvailable,
        "automaticTransport" to (
          wifiAwareSupported && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
          ),
        "reportOnly" to (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q)
      ),
      "wifiDirect" to bundleOf(
        "supported" to wifiDirectSupported,
        "automaticTransport" to false,
        "reportOnly" to true
      )
    )
  }

  @RequiresApi(Build.VERSION_CODES.O)
  private fun isWifiAwareAvailableApi26(): Boolean {
    val manager = context.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager
    return manager?.isAvailable == true
  }

  private fun disconnectAndCloseGatt(gatt: BluetoothGatt) {
    try {
      gatt.disconnect()
    } catch (_: Exception) {
    }
    try {
      gatt.close()
    } catch (_: Exception) {
    }
  }

  private fun startForegroundKeepAlive() {
    try {
      val intent = Intent(context, AnywayForegroundService::class.java)
      ContextCompat.startForegroundService(context, intent)
    } catch (e: Exception) {
      // Best-effort: the mesh still runs without this, just with a lower
      // OS priority while backgrounded.
    }
  }

  private fun stopForegroundKeepAlive() {
    foregroundServiceActive = false
    if (WifiAwareRuntimeRegistry.peek()?.isDesiredOrActive() == true) return
    try {
      context.stopService(Intent(context, AnywayForegroundService::class.java))
    } catch (e: Exception) {
    }
  }

  fun isIgnoringBatteryOptimizations(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
    val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
    return powerManager?.isIgnoringBatteryOptimizations(context.packageName) ?: true
  }

  fun requestIgnoreBatteryOptimizations() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
    try {
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
        data = Uri.parse("package:${context.packageName}")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
    } catch (e: Exception) {
      // Some OEMs block this intent entirely; nothing more we can do here.
    }
  }

  private fun setupGattServer(
    btManager: BluetoothManager,
    callback: BluetoothGattServerCallback
  ): Boolean {
    val characteristic = BluetoothGattCharacteristic(
      CHARACTERISTIC_UUID,
      BluetoothGattCharacteristic.PROPERTY_WRITE or
        BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or
        BluetoothGattCharacteristic.PROPERTY_NOTIFY,
      BluetoothGattCharacteristic.PERMISSION_WRITE
    )
    val cccd = BluetoothGattDescriptor(
      CCCD_UUID,
      BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
    )
    characteristic.addDescriptor(cccd)

    val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    service.addCharacteristic(characteristic)

    val server = btManager.openGattServer(context, callback) ?: return false
    gattServer = server
    serverCharacteristic = characteristic
    val accepted = server.addService(service)
    if (!accepted) {
      try {
        server.close()
      } catch (_: Exception) {
      }
      gattServer = null
      serverCharacteristic = null
    }
    return accepted
  }

  private fun startAdvertising(callback: AdvertiseCallback) {
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      .setConnectable(true)
      .build()
    val data = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .addServiceUuid(ParcelUuid(SERVICE_UUID))
      .build()
    requireNotNull(advertiser).startAdvertising(settings, data, callback)
  }

  private fun startScanning(callback: ScanCallback) {
    val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
    requireNotNull(scanner).startScan(listOf(filter), settings, callback)
  }

  // -------------------------------------------------------------------------
  // Connection/topology scheduler
  // -------------------------------------------------------------------------

  /** Coalesces scan storms into one evaluation. An earlier requested wake-up
   * replaces a later one, but repeated scan callbacks cannot enqueue a burst
   * of scheduler runnables. Must be called with lifecycleLock held. */
  private fun scheduleTopologyEvaluationLocked(generation: Long, delayMs: Long) {
    if (!isCurrentGeneration(generation) || !isScanning) return
    val now = SystemClock.elapsedRealtime()
    val due = now + delayMs.coerceAtLeast(0L)
    val scheduled = topologySchedulerRunnable
    if (scheduled != null && topologySchedulerDueElapsedMs <= due) return
    if (scheduled != null) mainHandler.removeCallbacks(scheduled)

    val runnable = object : Runnable {
      override fun run() {
        val shouldRun = synchronized(lifecycleLock) {
          if (topologySchedulerRunnable !== this) return@synchronized false
          topologySchedulerRunnable = null
          topologySchedulerDueElapsedMs = Long.MAX_VALUE
          isCurrentGeneration(generation)
        }
        if (shouldRun) runTopologyScheduler(generation)
      }
    }
    topologySchedulerRunnable = runnable
    topologySchedulerDueElapsedMs = due
    mainHandler.postDelayed(runnable, (due - now).coerceAtLeast(0L))
  }

  private fun scheduleTopologyEvaluation(generation: Long, delayMs: Long = 0L) {
    synchronized(lifecycleLock) {
      scheduleTopologyEvaluationLocked(generation, delayMs)
    }
  }

  private fun runTopologyScheduler(generation: Long) {
    val maintenance = synchronized(lifecycleLock) {
      if (!isCurrentGeneration(generation) || !isScanning) return@synchronized null
      val now = SystemClock.elapsedRealtime()
      val occupied = occupiedLinkAddressesLocked()

      val expiredCandidates = mutableListOf<String>()
      for ((address, candidate) in candidates) {
        if (address !in occupied && now - candidate.lastSeenElapsedMs > CANDIDATE_TTL_MS) {
          if (candidates.remove(address, candidate)) {
            rssiByAddress.remove(address)
            expiredCandidates.add(address)
          }
        }
      }

      var expiredReassemblies = 0
      for ((address, perAddress) in reassemblyBuffers) {
        for ((messageId, reassembly) in perAddress) {
          if (now - reassembly.lastUpdatedElapsedMs > REASSEMBLY_TTL_MS &&
            perAddress.remove(messageId, reassembly)
          ) {
            expiredReassemblies++
          }
        }
        if (perAddress.isEmpty()) reassemblyBuffers.remove(address, perAddress)
      }

      var operation: ConnectOperation? = null
      var budgetFull = false
      var nextWakeDelayMs = TOPOLOGY_MAINTENANCE_MS
      val currentOccupied = occupiedLinkAddressesLocked()
      val missingCandidates = candidates.values.filter { candidate ->
        now - candidate.lastSeenElapsedMs <= CANDIDATE_CONNECT_FRESHNESS_MS &&
          candidate.address !in currentOccupied
      }

      if (isRunning && activeConnectionAttempt == null && missingCandidates.isNotEmpty()) {
        if (currentOccupied.size >= MAX_LOGICAL_LINKS) {
          if (now - lastBudgetDiagnosticElapsedMs >= BUDGET_DIAGNOSTIC_INTERVAL_MS) {
            lastBudgetDiagnosticElapsedMs = now
            budgetFull = true
          }
        } else {
          val globalEligibleAt = if (lastConnectGattStartedElapsedMs == Long.MIN_VALUE) {
            now
          } else {
            lastConnectGattStartedElapsedMs + MIN_CONNECT_GAP_MS
          }
          val eligible = missingCandidates.filter { candidate ->
            candidate.nextEligibleElapsedMs <= now && globalEligibleAt <= now
          }
          val selected = eligible.sortedWith(
            compareByDescending<PeerCandidate> { it.rssi ?: Int.MIN_VALUE }
              .thenByDescending { it.lastSeenElapsedMs }
              .thenBy { it.consecutiveFailures }
          ).firstOrNull()
          if (selected != null) {
            val attempt = ConnectionAttempt(generation, selected.address, now)
            selected.lastAttemptElapsedMs = now
            connectionAttempts[selected.address] = attempt
            activeConnectionAttempt = attempt
            lastConnectGattStartedElapsedMs = now
            operation = ConnectOperation(generation, selected, attempt)
          } else {
            val earliestCandidateAt = missingCandidates.minOfOrNull {
              maxOf(it.nextEligibleElapsedMs, globalEligibleAt)
            }
            if (earliestCandidateAt != null) {
              nextWakeDelayMs = minOf(
                nextWakeDelayMs,
                (earliestCandidateAt - now).coerceAtLeast(0L)
              )
            }
          }
        }
      }

      scheduleTopologyEvaluationLocked(generation, nextWakeDelayMs)
      SchedulerMaintenance(expiredCandidates, expiredReassemblies, operation, budgetFull)
    } ?: return

    maintenance.expiredCandidates.forEach { address ->
      emitDiagnostic(generation, "candidate-expired", address = address)
    }
    if (maintenance.expiredReassemblies > 0) {
      emitDiagnostic(
        generation,
        "reassembly-expired",
        count = maintenance.expiredReassemblies
      )
    }
    if (maintenance.budgetFull) {
      emitDiagnostic(generation, "link-budget-full")
    }
    maintenance.connectOperation?.let { operation ->
      emitDiagnostic(
        generation,
        "connection-attempt-started",
        address = operation.candidate.address,
        rssi = operation.candidate.rssi,
        failureCount = operation.candidate.consecutiveFailures
      )
      beginConnectOperation(operation)
    }
  }

  private fun beginConnectOperation(operation: ConnectOperation) {
    val generation = operation.generation
    val address = operation.candidate.address
    val attempt = operation.attempt
    val stillCurrent = synchronized(lifecycleLock) {
      isCurrentGeneration(generation) &&
        activeConnectionAttempt === attempt &&
        connectionAttempts[address] === attempt
    }
    if (!stillCurrent) return

    val newGatt = try {
      operation.candidate.device.connectGatt(
        context,
        false,
        createGattClientCallback(attempt),
        BluetoothDevice.TRANSPORT_LE
      )
    } catch (_: Exception) {
      failConnectionAttempt(
        generation,
        address,
        attempt,
        "gatt-client-connect",
        BluetoothGatt.GATT_FAILURE
      )
      return
    }

    if (newGatt == null) {
      failConnectionAttempt(
        generation,
        address,
        attempt,
        "gatt-client-connect-null",
        BluetoothGatt.GATT_FAILURE
      )
      return
    }

    var shouldClose = false
    var shouldWatch = false
    synchronized(lifecycleLock) {
      when {
        !isCurrentGeneration(generation) -> shouldClose = true
        outgoingConnections[address] === newGatt -> {
          // A vendor callback may race connectGatt() returning.
          attempt.gatt = newGatt
          pendingConnections.remove(address, newGatt)
          shouldWatch = !outgoingReady.contains(address)
        }
        connectionAttempts[address] !== attempt || activeConnectionAttempt !== attempt -> {
          shouldClose = true
        }
        else -> {
          attempt.gatt = newGatt
          pendingConnections[address] = newGatt
          shouldWatch = true
        }
      }
    }
    if (shouldClose) disconnectAndCloseGatt(newGatt)
    if (shouldWatch) scheduleConnectionWatchdog(generation, address, newGatt)
  }

  private fun recordCandidateFailureLocked(
    address: String,
    stage: String,
    nowElapsedMs: Long
  ): Pair<Int, Long>? {
    val candidate = candidates[address] ?: return null
    candidate.consecutiveFailures = (candidate.consecutiveFailures + 1).coerceAtMost(16)
    candidate.lastFailureStage = stage
    val exponent = (candidate.consecutiveFailures - 1).coerceAtMost(6)
    val baseDelay = (INITIAL_RETRY_BACKOFF_MS * (1L shl exponent))
      .coerceAtMost(MAX_RETRY_BACKOFF_MS)
    // "Equal jitter": retain half of the exponential delay and randomize the
    // other half. Unlike additive jitter followed by a clamp, this continues
    // to spread retries even after the backoff reaches its maximum.
    val jitterFloor = (baseDelay / 2L).coerceAtLeast(1L)
    val retryDelay = jitterFloor +
      ThreadLocalRandom.current().nextLong((baseDelay - jitterFloor) + 1L)
    candidate.nextEligibleElapsedMs = nowElapsedMs + retryDelay
    return candidate.consecutiveFailures to retryDelay
  }

  private fun releaseConnectionAttemptLocked(address: String, attempt: ConnectionAttempt): Boolean {
    val removed = connectionAttempts.remove(address, attempt)
    if (activeConnectionAttempt === attempt) activeConnectionAttempt = null
    return removed
  }

  private fun failConnectionAttempt(
    generation: Long,
    address: String,
    attempt: ConnectionAttempt,
    stage: String,
    status: Int,
    gatt: BluetoothGatt? = attempt.gatt
  ) {
    var owned = false
    var retry: Pair<Int, Long>? = null
    synchronized(lifecycleLock) {
      if (!isCurrentGeneration(generation)) return@synchronized
      owned = releaseConnectionAttemptLocked(address, attempt)
      if (gatt != null) {
        pendingConnections.remove(address, gatt)
        outgoingConnections.remove(address, gatt)
        outgoingReady.remove(address)
        serviceDiscoveryStarted.remove(gatt)
      }
      if (owned) {
        clientWriteQueues.remove(address)
        clientWriteInFlight.remove(address)
        outgoingMtuByAddress.remove(address)
              mtuRetriedAddresses.remove(address)
        retry = recordCandidateFailureLocked(address, stage, SystemClock.elapsedRealtime())
        scheduleTopologyEvaluationLocked(generation, MIN_CONNECT_GAP_MS)
      }
    }
    gatt?.let(::disconnectAndCloseGatt)
    if (!owned) return
    recordGattError(generation, stage, status)
    notifyPeerDisconnectedIfFullyGone(generation, address)
    emitDiagnostic(
      generation,
      "connection-backoff",
      address = address,
      failureCount = retry?.first,
      retryInMs = retry?.second,
      stage = stage
    )
  }

  // -------------------------------------------------------------------------
  // Advertising / scanning callbacks
  // -------------------------------------------------------------------------

  private fun createAdvertiseCallback(generation: Long): AdvertiseCallback =
    object : AdvertiseCallback() {
      override fun onStartFailure(errorCode: Int) {
        failActiveSession(
          generation,
          stage = "advertising",
          errorCode = errorCode,
          message = "BLE advertising failed with code $errorCode"
        )
      }

      override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
        var changed = false
        synchronized(lifecycleLock) {
          if (!isCurrentGeneration(generation)) return@synchronized
          isAdvertising = true
          refreshLifecycleFlagsLocked()
          scheduleTopologyEvaluationLocked(generation, 0L)
          changed = true
        }
        if (changed) emitRadioState()
      }
    }

  private fun createScanCallback(generation: Long): ScanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      val address = try {
        result.device.address
      } catch (_: SecurityException) {
        return
      }
      val now = SystemClock.elapsedRealtime()
      var isNewCandidate = false
      val shouldReport = synchronized(lifecycleLock) {
        if (!isCurrentGeneration(generation) || !isScanning) return@synchronized false
        rssiByAddress[address] = result.rssi
        val existing = candidates[address]
        val candidate = if (existing == null) {
          isNewCandidate = true
          PeerCandidate(result.device, address, result.rssi, now, now).also {
            candidates[address] = it
          }
        } else {
          existing.device = result.device
          existing.rssi = existing.rssi?.let { previous ->
            ((previous * 3) + result.rssi) / 4
          } ?: result.rssi
          existing.lastSeenElapsedMs = now
          existing
        }
        val report = isNewCandidate ||
          now - candidate.lastDiscoveryEventElapsedMs >= DISCOVERY_EVENT_INTERVAL_MS
        if (report) candidate.lastDiscoveryEventElapsedMs = now
        scheduleTopologyEvaluationLocked(generation, 0L)
        report
      }
      if (shouldReport) {
        try {
          sendEvent(
            "onPeerDiscovered",
            bundleOf("address" to address, "rssi" to result.rssi)
          )
        } catch (_: Exception) {
        }
      }
      if (isNewCandidate) {
        emitDiagnostic(generation, "candidate-added", address = address, rssi = result.rssi)
      }
    }

    override fun onScanFailed(errorCode: Int) {
      failActiveSession(
        generation,
        stage = "scan",
        errorCode = errorCode,
        message = "BLE scan failed with code $errorCode"
      )
    }
  }

  // -------------------------------------------------------------------------
  // GATT server callback (peripheral role: devices connecting to us)
  // -------------------------------------------------------------------------

  private fun createGattServerCallback(generation: Long): BluetoothGattServerCallback =
    object : BluetoothGattServerCallback() {
    override fun onServiceAdded(status: Int, service: BluetoothGattService) {
      if (service.uuid != SERVICE_UUID) return
      if (status != BluetoothGatt.GATT_SUCCESS) {
        failActiveSession(
          generation,
          stage = "gatt-server",
          errorCode = status,
          message = "GATT service registration failed with status $status"
        )
        return
      }
      val changed = synchronized(lifecycleLock) {
        if (!isCurrentGeneration(generation)) return@synchronized false
        isGattServerReady = true
        refreshLifecycleFlagsLocked()
        scheduleTopologyEvaluationLocked(generation, 0L)
        true
      }
      if (changed) emitRadioState()
    }

    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      val address = device.address
      var disconnected = false
      var rejectedForBudget = false
      var serverForRejection: BluetoothGattServer? = null
      var acceptedSubscriptionToken: Long? = null
      val current = synchronized(lifecycleLock) {
        if (!isCurrentGeneration(generation)) return@synchronized false
        if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
          val occupied = occupiedLinkAddressesLocked()
          if (address !in occupied && occupied.size >= MAX_LOGICAL_LINKS) {
            rejectedForBudget = true
            serverForRejection = gattServer
          } else {
            incomingDevices[address] = device
            val now = SystemClock.elapsedRealtime()
            candidates[address]?.let { candidate ->
              candidate.device = device
              candidate.lastSeenElapsedMs = now
            } ?: run {
              candidates[address] = PeerCandidate(device, address, null, now, now)
            }
            val token = ++nextIncomingSubscriptionToken
            incomingSubscriptionTokens[address] = token
            acceptedSubscriptionToken = token
          }
        } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
          candidates[address]?.lastSeenElapsedMs = SystemClock.elapsedRealtime()
          incomingDevices.remove(address)
          incomingSubscriptionTokens.remove(address)
          notifyEnabled.remove(address)
          removeServerNotifyQueueLocked(address)
          incomingMtuByAddress.remove(address)
          // A peer walking out of range mid-notification is an ordinary event,
          // but Android never delivers onNotificationSent for the operation it
          // flushed. Leaving the in-flight slot pointing at the departed
          // address blocks processServerNotifyQueue for *every* peer, since the
          // GATT server permits one notification at a time for the whole
          // server — and the watchdog that eventually notices does not simply
          // release the slot, it bumps the session generation and tears the
          // whole mesh down. Release it here so the queue just advances.
          if (serverNotifyInFlightAddress == address) {
            serverNotifyInFlightToken?.let { cancelWatchdog(it) }
            serverNotifyInFlightAddress = null
            serverNotifyInFlightToken = null
          }
          disconnected = true
          scheduleTopologyEvaluationLocked(generation, MIN_CONNECT_GAP_MS)
        }
        true
      }
      if (!current) return
      acceptedSubscriptionToken?.let { token ->
        scheduleIncomingSubscriptionWatchdog(generation, address, device, token)
      }
      if (rejectedForBudget) {
        try {
          serverForRejection?.cancelConnection(device)
        } catch (_: Exception) {
        }
        emitDiagnostic(generation, "incoming-rejected-budget", address = address)
      } else if (disconnected) {
        notifyPeerDisconnectedIfFullyGone(generation, address)
        processServerNotifyQueue(generation)
        emitDiagnostic(generation, "incoming-disconnected", address = address)
      } else if (status != BluetoothGatt.GATT_SUCCESS) {
        recordGattError(generation, "gatt-server-connection", status)
      }
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray
    ) {
      val activeServer = synchronized(lifecycleLock) {
        if (isCurrentGeneration(generation)) gattServer else null
      } ?: return

      // Acknowledge Android's ATT transaction before any reassembly, Base64
      // conversion or JS event work. Several OEM stacks disconnect a peer if
      // this callback is held while an entire logical message is assembled.
      val responseStatus = when {
        characteristic.uuid != CHARACTERISTIC_UUID -> BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED
        preparedWrite -> BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED
        offset != 0 -> BluetoothGatt.GATT_INVALID_OFFSET
        else -> BluetoothGatt.GATT_SUCCESS
      }
      val acceptedValue = if (responseStatus == BluetoothGatt.GATT_SUCCESS) {
        // The platform-owned callback buffer must not escape this callback.
        value.copyOf()
      } else {
        null
      }
      if (responseNeeded) {
        try {
          activeServer.sendResponse(device, requestId, responseStatus, 0, null)
        } catch (_: Exception) {
        }
      }
      if (acceptedValue != null) {
        val address = device.address
        mainHandler.post {
          val stillCurrent = synchronized(lifecycleLock) {
            isCurrentGeneration(generation) &&
              gattServer === activeServer &&
              incomingDevices.containsKey(address)
          }
          if (stillCurrent) handleIncomingChunk(generation, address, acceptedValue)
        }
      }
    }

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray
    ) {
      val address = device.address
      var enabled = false
      var disabled = false
      var rejectedForBudget = false
      var responseStatus = BluetoothGatt.GATT_SUCCESS
      var resubscribeToken: Long? = null
      val activeServer = synchronized(lifecycleLock) {
        if (!isCurrentGeneration(generation)) return@synchronized null
        if (descriptor.uuid == CCCD_UUID) {
          if (value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
            val occupied = occupiedLinkAddressesLocked()
            if (address in occupied || occupied.size < MAX_LOGICAL_LINKS) {
              notifyEnabled.add(address)
              incomingSubscriptionTokens.remove(address)
              enabled = true
            } else {
              rejectedForBudget = true
              responseStatus = GATT_INSUFFICIENT_RESOURCES_STATUS
            }
          } else {
            notifyEnabled.remove(address)
            removeServerNotifyQueueLocked(address)
            if (incomingDevices.containsKey(address)) {
              val token = ++nextIncomingSubscriptionToken
              incomingSubscriptionTokens[address] = token
              resubscribeToken = token
            }
            disabled = true
          }
        }
        gattServer
      } ?: return
      if (enabled) {
        notifyPeerConnected(generation, address)
        // Anything queued while subscription was pending can go out now.
        processServerNotifyQueue(generation)
        emitDiagnostic(generation, "incoming-link-ready", address = address)
      } else if (disabled) {
        notifyPeerDisconnectedIfFullyGone(generation, address)
        processServerNotifyQueue(generation)
        scheduleTopologyEvaluation(generation, MIN_CONNECT_GAP_MS)
        resubscribeToken?.let { token ->
          scheduleIncomingSubscriptionWatchdog(generation, address, device, token)
        }
      }
      if (responseNeeded) {
        try {
          activeServer.sendResponse(device, requestId, responseStatus, 0, null)
        } catch (e: SecurityException) {
        }
      }
      if (rejectedForBudget) {
        try {
          activeServer.cancelConnection(device)
        } catch (_: Exception) {
        }
        emitDiagnostic(generation, "incoming-rejected-budget", address = address)
      }
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      synchronized(lifecycleLock) {
        if (isCurrentGeneration(generation)) incomingMtuByAddress[device.address] = mtu
      }
    }

    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
      // Failures are always reported; successes are sampled because there is one
      // per fragment and a single message can span hundreds of them.
      if (status != BluetoothGatt.GATT_SUCCESS || shouldSampleFragmentDiagnostic()) {
        emitDiagnostic(
          generation,
          "server-notify-confirmed",
          address = device.address,
          stage = if (status == BluetoothGatt.GATT_SUCCESS) "success" else "status-$status"
        )
      }
      finishServerNotification(generation, device, status)
    }
  }

  private fun scheduleIncomingSubscriptionWatchdog(
    generation: Long,
    address: String,
    device: BluetoothDevice,
    token: Long
  ) {
    mainHandler.postDelayed({
      var timedOut = false
      val activeServer = synchronized(lifecycleLock) {
        if (!isCurrentGeneration(generation) ||
          incomingSubscriptionTokens[address] != token ||
          incomingDevices[address] !== device ||
          notifyEnabled.contains(address)
        ) {
          return@synchronized null
        }
        incomingSubscriptionTokens.remove(address, token)
        incomingDevices.remove(address, device)
        removeServerNotifyQueueLocked(address)
        incomingMtuByAddress.remove(address)
        scheduleTopologyEvaluationLocked(generation, MIN_CONNECT_GAP_MS)
        timedOut = true
        gattServer
      }
      if (!timedOut) return@postDelayed
      try {
        activeServer?.cancelConnection(device)
      } catch (_: Exception) {
      }
      notifyPeerDisconnectedIfFullyGone(generation, address)
      processServerNotifyQueue(generation)
      emitDiagnostic(generation, "incoming-subscription-timeout", address = address)
    }, CONNECTION_WATCHDOG_MS)
  }

  // -------------------------------------------------------------------------
  // GATT client callback (central role: one instance shared by every
  // connection we initiate; `gatt.device.address` disambiguates the peer)
  // -------------------------------------------------------------------------

  private fun createGattClientCallback(attempt: ConnectionAttempt): BluetoothGattCallback =
    object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      val generation = attempt.generation
      val address = gatt.device.address
      if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
        var shouldNegotiate = false
        var shouldClose = false
        synchronized(lifecycleLock) {
          when {
            !isCurrentGeneration(generation) -> shouldClose = true
            outgoingConnections[address] === gatt -> Unit // duplicate callback
            connectionAttempts[address] === attempt -> {
              attempt.gatt = gatt
              candidates[address]?.lastSeenElapsedMs = SystemClock.elapsedRealtime()
              pendingConnections.remove(address, gatt)
              outgoingConnections[address] = gatt
              shouldNegotiate = true
            }
            else -> shouldClose = true
          }
        }
        if (shouldClose) {
          disconnectAndCloseGatt(gatt)
          return
        }
        if (!shouldNegotiate) return
        // Every fragment costs one connection interval, and Android defaults to
        // roughly 48 ms. A message split into a hundred fragments therefore
        // takes seconds purely in radio scheduling, regardless of how fast the
        // code above it is. High priority pulls the interval down to about
        // 11 ms, which is the single largest latency win available here.
        try {
          gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
        } catch (_: Exception) {
          // Advisory only: the link still works at the default interval.
        }
        try {
          val mtuRequested = gatt.requestMtu(517)
          if (!mtuRequested) {
            discoverServices(generation, gatt)
          }
        } catch (_: Exception) {
          discoverServices(generation, gatt)
        }
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        var owned = false
        var wasReady = false
        var retry: Pair<Int, Long>? = null
        synchronized(lifecycleLock) {
          if (isCurrentGeneration(generation)) {
            val ownedAttempt = releaseConnectionAttemptLocked(address, attempt)
            val ownedPending = pendingConnections.remove(address, gatt)
            val ownedOutgoing = outgoingConnections.remove(address, gatt)
            owned = ownedAttempt || ownedPending || ownedOutgoing
            if (owned) {
              candidates[address]?.lastSeenElapsedMs = SystemClock.elapsedRealtime()
              serviceDiscoveryStarted.remove(gatt)
              wasReady = outgoingReady.remove(address)
              clientWriteQueues.remove(address)
              clientWriteInFlight.remove(address)
              outgoingMtuByAddress.remove(address)
              mtuRetriedAddresses.remove(address)
              retry = recordCandidateFailureLocked(
                address,
                "gatt-client-disconnected",
                SystemClock.elapsedRealtime()
              )
              scheduleTopologyEvaluationLocked(generation, MIN_CONNECT_GAP_MS)
            }
          }
        }
        disconnectAndCloseGatt(gatt)
        if (wasReady) notifyPeerDisconnectedIfFullyGone(generation, address)
        if (owned && status != BluetoothGatt.GATT_SUCCESS) {
          recordGattError(generation, "gatt-client-connection", status)
        }
        if (owned) {
          emitDiagnostic(
            generation,
            "connection-backoff",
            address = address,
            failureCount = retry?.first,
            retryInMs = retry?.second,
            stage = "gatt-client-disconnected"
          )
        }
      } else if (status != BluetoothGatt.GATT_SUCCESS) {
        recordGattError(generation, "gatt-client-connection", status)
        closeOutgoingGatt(generation, gatt, attempt, "gatt-client-connection")
      }
    }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      val generation = attempt.generation
      val isCurrent = synchronized(lifecycleLock) {
        if (!isCurrentGattLocked(generation, gatt)) return@synchronized false
        if (status == BluetoothGatt.GATT_SUCCESS) {
          outgoingMtuByAddress[gatt.device.address] = mtu
        }
        true
      }
      if (!isCurrent) return
      if (status != BluetoothGatt.GATT_SUCCESS) {
        recordGattError(generation, "gatt-client-mtu", status)
      }
      // Staying at the 23-byte floor costs ~14 usable bytes per GATT operation,
      // so a single signed envelope becomes hundreds of fragments. Surface it:
      // it is a throughput cliff, not a cosmetic detail.
      val address = gatt.device.address
      emitDiagnostic(
        generation,
        "mtu-negotiated",
        address = address,
        count = mtu,
        stage = if (mtu <= DEFAULT_MTU) "minimum" else "negotiated"
      )

      // Landing on the floor costs ~14 usable bytes per GATT operation instead
      // of ~500, turning one signed envelope into hundreds of fragments. An
      // MTU exchange issued right after connect is exactly the one Android
      // stacks most often refuse, so it gets a single second chance before the
      // link is accepted at the slow rate.
      if (mtu <= DEFAULT_MTU && mtuRetriedAddresses.add(address)) {
        val retried = try {
          gatt.requestMtu(517)
        } catch (_: Exception) {
          false
        }
        if (retried) return
      }
      discoverServices(generation, gatt)
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      val generation = attempt.generation
      if (!isCurrentGatt(generation, gatt)) return
      if (status != BluetoothGatt.GATT_SUCCESS) {
        recordGattError(generation, "gatt-client-services", status)
        closeOutgoingGatt(generation, gatt, attempt, "gatt-client-services")
        return
      }
      val characteristic = gatt.getService(SERVICE_UUID)?.getCharacteristic(CHARACTERISTIC_UUID)
      val descriptor = characteristic?.getDescriptor(CCCD_UUID)
      if (characteristic == null || descriptor == null) {
        recordGattError(generation, "gatt-client-characteristic", BluetoothGatt.GATT_FAILURE)
        closeOutgoingGatt(generation, gatt, attempt, "gatt-client-characteristic")
        return
      }
      try {
        if (!gatt.setCharacteristicNotification(characteristic, true)) {
          recordGattError(generation, "gatt-client-notification", BluetoothGatt.GATT_FAILURE)
          closeOutgoingGatt(generation, gatt, attempt, "gatt-client-notification")
          return
        }
        val writeAccepted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          gatt.writeDescriptor(
            descriptor,
            BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
          ) == BluetoothStatusCodes.SUCCESS
        } else {
          @Suppress("DEPRECATION")
          descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
          @Suppress("DEPRECATION")
          gatt.writeDescriptor(descriptor)
        }
        if (!writeAccepted) {
          recordGattError(generation, "gatt-client-cccd", BluetoothGatt.GATT_FAILURE)
          closeOutgoingGatt(generation, gatt, attempt, "gatt-client-cccd")
        }
      } catch (_: Exception) {
        recordGattError(generation, "gatt-client-cccd", BluetoothGatt.GATT_FAILURE)
        closeOutgoingGatt(generation, gatt, attempt, "gatt-client-cccd")
      }
    }

    override fun onDescriptorWrite(
      gatt: BluetoothGatt,
      descriptor: BluetoothGattDescriptor,
      status: Int
    ) {
      val generation = attempt.generation
      if (!isCurrentGatt(generation, gatt) || descriptor.uuid != CCCD_UUID) return
      if (status != BluetoothGatt.GATT_SUCCESS) {
        recordGattError(generation, "gatt-client-cccd", status)
        closeOutgoingGatt(generation, gatt, attempt, "gatt-client-cccd")
        return
      }
      val address = gatt.device.address
      val becameReady = synchronized(lifecycleLock) {
        if (!isCurrentGattLocked(generation, gatt)) return@synchronized false
        releaseConnectionAttemptLocked(address, attempt)
        pendingConnections.remove(address, gatt)
        candidates[address]?.let { candidate ->
          candidate.lastSeenElapsedMs = SystemClock.elapsedRealtime()
          candidate.consecutiveFailures = 0
          candidate.nextEligibleElapsedMs = 0L
          candidate.lastFailureStage = null
        }
        scheduleTopologyEvaluationLocked(generation, MIN_CONNECT_GAP_MS)
        outgoingReady.add(address)
      }
      if (becameReady) {
        notifyPeerConnected(generation, address)
        emitDiagnostic(generation, "outgoing-link-ready", address = address)
      }
    }

    @Suppress("DEPRECATION")
    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      val generation = attempt.generation
      val payload = characteristic.value
      // Per-fragment logging drowned the ring buffer (hundreds of events for a
      // single message at low MTU) and cost real CPU, so it is now sampled.
      if (shouldSampleFragmentDiagnostic()) {
        emitDiagnostic(
          generation,
          "notification-received",
          address = gatt.device.address,
          count = payload?.size ?: -1,
          stage = "legacy-callback"
        )
      }
      if (!isCurrentGatt(generation, gatt)) {
        emitDiagnostic(
          generation,
          "notification-dropped",
          address = gatt.device.address,
          stage = "stale-gatt"
        )
        return
      }
      handleIncomingChunk(generation, gatt.device.address, payload ?: return)
    }

    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray
    ) {
      val generation = attempt.generation
      if (shouldSampleFragmentDiagnostic()) {
        emitDiagnostic(
          generation,
          "notification-received",
          address = gatt.device.address,
          count = value.size,
          stage = "value-callback"
        )
      }
      if (!isCurrentGatt(generation, gatt)) {
        emitDiagnostic(
          generation,
          "notification-dropped",
          address = gatt.device.address,
          stage = "stale-gatt"
        )
        return
      }
      handleIncomingChunk(generation, gatt.device.address, value)
    }

    override fun onCharacteristicWrite(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int
    ) {
      val generation = attempt.generation
      if (characteristic.uuid != CHARACTERISTIC_UUID) return
      val address = gatt.device.address
      val completed = synchronized(lifecycleLock) {
        if (!isCurrentGattLocked(generation, gatt)) return@synchronized false
        val inFlight = clientWriteInFlight[address] ?: return@synchronized false
        if (inFlight.gatt !== gatt) return@synchronized false
        clientWriteInFlight.remove(address, inFlight).also {
          if (it) cancelWatchdog(inFlight.token)
        }
      }
      // A callback from a timed-out/closed GATT cannot own an operation in a
      // replacement connection, so it is ignored and cannot drain that queue.
      if (!completed) return
      if (status != BluetoothGatt.GATT_SUCCESS) {
        recordGattError(generation, "gatt-client-write", status)
        closeOutgoingGatt(generation, gatt, attempt, "gatt-client-write")
        return
      }
      processClientWriteQueue(generation, address)
    }
  }

  private fun isCurrentGattLocked(generation: Long, gatt: BluetoothGatt): Boolean =
    isCurrentGeneration(generation) && outgoingConnections[gatt.device.address] === gatt

  private fun isCurrentGatt(generation: Long, gatt: BluetoothGatt): Boolean =
    synchronized(lifecycleLock) { isCurrentGattLocked(generation, gatt) }

  private fun discoverServices(generation: Long, gatt: BluetoothGatt) {
    val shouldDiscover = synchronized(lifecycleLock) {
      isCurrentGeneration(generation) &&
        outgoingConnections[gatt.device.address] === gatt &&
        serviceDiscoveryStarted.add(gatt)
    }
    if (!shouldDiscover) return
    try {
      if (!gatt.discoverServices()) {
        recordGattError(generation, "gatt-client-services", BluetoothGatt.GATT_FAILURE)
        closeOutgoingGatt(generation, gatt, failureStage = "gatt-client-services")
      }
    } catch (_: Exception) {
      recordGattError(generation, "gatt-client-services", BluetoothGatt.GATT_FAILURE)
      closeOutgoingGatt(generation, gatt, failureStage = "gatt-client-services")
    }
  }

  private fun scheduleConnectionWatchdog(
    generation: Long,
    address: String,
    gatt: BluetoothGatt
  ) {
    mainHandler.postDelayed({
      val timedOutAttempt = synchronized(lifecycleLock) {
        if (!isCurrentGeneration(generation) || outgoingReady.contains(address)) {
          return@synchronized null
        }
        connectionAttempts[address]?.takeIf { attempt ->
          attempt.generation == generation && attempt.gatt === gatt
        }
      }
      if (timedOutAttempt != null) {
        failConnectionAttempt(
          generation,
          address,
          timedOutAttempt,
          "gatt-client-timeout",
          BluetoothGatt.GATT_FAILURE,
          gatt
        )
      }
    }, CONNECTION_WATCHDOG_MS)
  }

  private fun closeOutgoingGatt(
    generation: Long,
    gatt: BluetoothGatt,
    attempt: ConnectionAttempt? = null,
    failureStage: String = "gatt-client-closed",
    expectedClientWriteToken: Long? = null
  ): Boolean {
    val address = gatt.device.address
    var owned = false
    var removedReadyLink = false
    var retry: Pair<Int, Long>? = null
    var permittedToClose = expectedClientWriteToken == null
    synchronized(lifecycleLock) {
      if (isCurrentGeneration(generation)) {
        if (expectedClientWriteToken != null) {
          val inFlight = clientWriteInFlight[address] ?: return@synchronized
          if (outgoingConnections[address] !== gatt ||
            inFlight.gatt !== gatt ||
            inFlight.token != expectedClientWriteToken
          ) {
            return@synchronized
          }
          // Claim the timed-out operation while holding the same lock used by
          // onCharacteristicWrite. Whichever side wins makes the other a no-op.
          clientWriteInFlight.remove(address, inFlight)
          permittedToClose = true
        }
        if (attempt != null) {
          owned = releaseConnectionAttemptLocked(address, attempt) || owned
        } else {
          connectionAttempts[address]?.let { currentAttempt ->
            if (currentAttempt.gatt === gatt) {
              owned = releaseConnectionAttemptLocked(address, currentAttempt) || owned
            }
          }
        }
        owned = pendingConnections.remove(address, gatt) || owned
        serviceDiscoveryStarted.remove(gatt)
        if (outgoingConnections.remove(address, gatt)) {
          owned = true
          removedReadyLink = outgoingReady.remove(address)
          clientWriteQueues.remove(address)
          clientWriteInFlight.remove(address)
          outgoingMtuByAddress.remove(address)
              mtuRetriedAddresses.remove(address)
        }
        if (owned) {
          retry = recordCandidateFailureLocked(
            address,
            failureStage,
            SystemClock.elapsedRealtime()
          )
          scheduleTopologyEvaluationLocked(generation, MIN_CONNECT_GAP_MS)
        }
      }
    }
    if (!permittedToClose) return false
    disconnectAndCloseGatt(gatt)
    if (removedReadyLink) notifyPeerDisconnectedIfFullyGone(generation, address)
    if (owned) {
      emitDiagnostic(
        generation,
        "connection-backoff",
        address = address,
        failureCount = retry?.first,
        retryInMs = retry?.second,
        stage = failureStage
      )
    }
    return owned
  }

  // -------------------------------------------------------------------------
  // Connect/disconnect de-duplication
  // -------------------------------------------------------------------------

  private fun notifyPeerConnected(generation: Long, address: String) {
    synchronized(lifecycleLock) {
      val shouldNotify = isCurrentGeneration(generation) &&
        (outgoingReady.contains(address) || notifyEnabled.contains(address)) &&
        notifiedConnected.add(address)
      if (shouldNotify) sendEvent("onPeerConnected", bundleOf("address" to address))
      if (isCurrentGeneration(generation)) {
        scheduleTopologyEvaluationLocked(generation, MIN_CONNECT_GAP_MS)
      }
    }
  }

  private fun notifyPeerDisconnectedIfFullyGone(generation: Long, address: String) {
    synchronized(lifecycleLock) {
      val shouldNotify = isCurrentGeneration(generation) &&
        !outgoingReady.contains(address) &&
        !notifyEnabled.contains(address) &&
        notifiedConnected.remove(address)
      if (shouldNotify) sendEvent("onPeerDisconnected", bundleOf("address" to address))
      if (isCurrentGeneration(generation) &&
        !outgoingReady.contains(address) &&
        !notifyEnabled.contains(address)
      ) {
        scheduleTopologyEvaluationLocked(generation, MIN_CONNECT_GAP_MS)
      }
    }
  }

  private fun connectedPeersList(): List<android.os.Bundle> = synchronized(lifecycleLock) {
    logicalLinkAddressesLocked().map { address ->
      // Null is intentional: 0 dBm is a real (very strong) measurement and
      // must not be overloaded as "RSSI was never observed".
      bundleOf("address" to address, "rssi" to rssiByAddress[address])
    }
  }

  private fun linkSnapshots(): List<android.os.Bundle> = synchronized(lifecycleLock) {
    val now = SystemClock.elapsedRealtime()
    val logical = logicalLinkAddressesLocked()
    val occupied = occupiedLinkAddressesLocked()
    val addresses = LinkedHashSet<String>().apply {
      addAll(candidates.keys)
      addAll(occupied)
    }

    addresses.sorted().map { address ->
      val candidate = candidates[address]
      val isOutgoingReady = outgoingReady.contains(address)
      val isIncomingReady = notifyEnabled.contains(address)
      val isOutgoingConnected = outgoingConnections.containsKey(address)
      val isIncomingConnected = incomingDevices.containsKey(address)
      val isConnecting = connectionAttempts.containsKey(address) ||
        pendingConnections.containsKey(address)
      val hasOutgoing = isOutgoingReady || isOutgoingConnected || isConnecting
      val hasIncoming = isIncomingReady || isIncomingConnected
      val direction = when {
        hasOutgoing && hasIncoming -> "bidirectional"
        hasOutgoing -> "outgoing"
        hasIncoming -> "incoming"
        else -> "none"
      }
      val state = when {
        isOutgoingReady || isIncomingReady -> "ready"
        isOutgoingConnected -> "negotiating"
        isIncomingConnected -> "incoming-negotiating"
        isConnecting -> "connecting"
        candidate != null && candidate.nextEligibleElapsedMs > now -> "backoff"
        else -> "candidate"
      }
      bundleOf(
        "address" to address,
        "transport" to "ble",
        "state" to state,
        "direction" to direction,
        "logical" to (address in logical),
        "slotReserved" to (address in occupied),
        "outgoingReady" to isOutgoingReady,
        "incomingReady" to isIncomingReady,
        "outgoingConnected" to isOutgoingConnected,
        "incomingConnected" to isIncomingConnected,
        "connectGattInFlight" to (activeConnectionAttempt?.address == address),
        "rssi" to rssiByAddress[address],
        "failureCount" to (candidate?.consecutiveFailures ?: 0),
        "nextRetryInMs" to (
          candidate?.let { (it.nextEligibleElapsedMs - now).coerceAtLeast(0L).toDouble() } ?: 0.0
          )
      ).also { snapshot ->
        candidate?.let {
          snapshot.putDouble(
            "firstSeenAgeMs",
            (now - it.firstSeenElapsedMs).coerceAtLeast(0L).toDouble()
          )
          snapshot.putDouble(
            "lastSeenAgeMs",
            (now - it.lastSeenElapsedMs).coerceAtLeast(0L).toDouble()
          )
          it.lastAttemptElapsedMs?.let { lastAttempt ->
            snapshot.putDouble(
              "lastAttemptAgeMs",
              (now - lastAttempt).coerceAtLeast(0L).toDouble()
            )
          }
          it.lastFailureStage?.let { stage -> snapshot.putString("lastFailureStage", stage) }
        }
        val outgoingMtu = if (isOutgoingReady) {
          outgoingMtuByAddress[address] ?: DEFAULT_MTU
        } else {
          null
        }
        val incomingMtu = if (isIncomingReady) {
          incomingMtuByAddress[address] ?: DEFAULT_MTU
        } else {
          null
        }
        outgoingMtu?.let { snapshot.putInt("outgoingMtu", it) }
        incomingMtu?.let { snapshot.putInt("incomingMtu", it) }
        // Preserve the existing aggregate field for JS callers, using the
        // conservative minimum rather than overstating a duplex link.
        listOfNotNull(outgoingMtu, incomingMtu).minOrNull()?.let { mtu ->
          snapshot.putInt("mtu", mtu)
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Fragmentation (outgoing) / reassembly (incoming)
  // -------------------------------------------------------------------------

  private fun sendToPeer(address: String, bytes: ByteArray): Boolean {
    val messageId = synchronized(messageIdLock) {
      val id = nextMessageId
      nextMessageId = (nextMessageId + 1) and 0xFFFF
      id
    }

    var generation = 0L
    var route = 0
    var widenedBy = 0
    val accepted = synchronized(lifecycleLock) {
      generation = sessionGeneration

      // Prefer client writes, but a full client queue must not hide a healthy
      // inbound subscription to the same peer. Each direction uses its own
      // negotiated MTU and therefore its own fragmentation attempt.
      val clientReady = outgoingReady.contains(address) && outgoingConnections.containsKey(address)
      val notifyReady = notifyEnabled.contains(address) && incomingDevices.containsKey(address)
      val clientMtu = outgoingMtuByAddress[address] ?: DEFAULT_MTU
      val notifyMtu = incomingMtuByAddress[address] ?: DEFAULT_MTU

      // Only the central end of a GATT connection may request a larger MTU, so
      // in a dual-role pair the two links negotiate independently and can land
      // far apart: our outgoing link stuck at the 23-byte floor while the
      // peer's central negotiated 517 for the link we serve. Preferring client
      // writes unconditionally then pinned everything we send to the floor —
      // the same message costs ~22x the fragments, which is exactly what "one
      // phone is always the slow one" looks like. Divert to notifications only
      // in that pathological case; whenever both links negotiated normally,
      // client writes still win for their per-write flow control.
      // clientReady is part of the test, not just the branch below it: without
      // an outgoing link clientMtu is the 23-byte *default*, not a measurement,
      // and treating that as "the narrow side" would claim a widening over a
      // link that never existed. This diagnostic is the evidence used to judge
      // the MTU theory on real hardware, so it has to mean one thing only.
      val preferNotify =
        notifyReady && clientReady && clientMtu <= DEFAULT_MTU && notifyMtu > DEFAULT_MTU

      if (!preferNotify && clientReady) {
        val fragments = fragmentMessage(bytes, messageId, clientMtu)
        if (fragments != null) {
          val queue = clientWriteQueues.computeIfAbsent(address) { ArrayDeque() }
          if (enqueueFragments(queue, fragments)) route = 1
        }
      }

      if (route == 0 && notifyReady) {
        val fragments = fragmentMessage(bytes, messageId, notifyMtu)
        if (fragments != null && enqueueServerNotifyFragmentsLocked(address, fragments)) {
          route = 2
          // Reported only once the wide route actually took the message, so
          // the event count equals the number of messages really rescued.
          if (preferNotify) widenedBy = notifyMtu - clientMtu
        }
      }

      // The wide notify path was preferred but could not take the message
      // (queue full, or too many fragments). The narrow client link is still
      // better than dropping it.
      if (route == 0 && preferNotify && clientReady) {
        val fragments = fragmentMessage(bytes, messageId, clientMtu)
        if (fragments != null) {
          val queue = clientWriteQueues.computeIfAbsent(address) { ArrayDeque() }
          if (enqueueFragments(queue, fragments)) route = 1
        }
      }
      route != 0
    }
    if (widenedBy > 0) {
      emitDiagnostic(generation, "send-route-widened", address = address, count = widenedBy)
    }
    if (!accepted) return false
    if (route == 1) processClientWriteQueue(generation, address)
    else processServerNotifyQueue(generation)
    return true
  }

  private fun fragmentMessage(
    bytes: ByteArray,
    messageId: Int,
    mtu: Int
  ): List<ByteArray>? {
    // A fragment travels as one attribute value, so it is bounded by both the
    // ATT payload (mtu - 3) and the 512-octet attribute ceiling.
    val maxFragmentBytes = (mtu - 3).coerceAtMost(MAX_ATTRIBUTE_VALUE_BYTES)
    val chunkSize = (maxFragmentBytes - HEADER_SIZE).coerceAtLeast(1)
    val totalFragments = if (bytes.isEmpty()) {
      1
    } else {
      ((bytes.size.toLong() + chunkSize - 1L) / chunkSize).toInt()
    }
    if (totalFragments > MAX_FRAGMENTS_PER_MESSAGE) return null

    val fragments = mutableListOf<ByteArray>()
    var offset = 0
    for (i in 0 until totalFragments) {
      val end = (offset + chunkSize).coerceAtMost(bytes.size)
      val payload = if (bytes.isEmpty()) ByteArray(0) else bytes.copyOfRange(offset, end)
      val header = byteArrayOf(
        ((messageId shr 8) and 0xFF).toByte(),
        (messageId and 0xFF).toByte(),
        ((i shr 8) and 0xFF).toByte(),
        (i and 0xFF).toByte(),
        ((totalFragments shr 8) and 0xFF).toByte(),
        (totalFragments and 0xFF).toByte()
      )
      fragments.add(header + payload)
      offset = end
    }
    return fragments
  }

  private fun enqueueFragments(queue: ArrayDeque<ByteArray>, fragments: List<ByteArray>): Boolean =
    synchronized(queue) {
      if (fragments.size > MAX_QUEUED_FRAGMENTS_PER_PEER ||
        queue.size > MAX_QUEUED_FRAGMENTS_PER_PEER - fragments.size
      ) {
        false
      } else {
        fragments.forEach(queue::addLast)
        true
      }
    }

  /** Must be called with lifecycleLock held. */
  private fun enqueueServerNotifyFragmentsLocked(
    address: String,
    fragments: List<ByteArray>
  ): Boolean {
    val queue = serverNotifyQueues.computeIfAbsent(address) { ArrayDeque() }
    if (!enqueueFragments(queue, fragments)) return false
    if (!serverNotifyRoundRobin.contains(address)) serverNotifyRoundRobin.addLast(address)
    return true
  }

  /** Must be called with lifecycleLock held. */
  private fun removeServerNotifyQueueLocked(address: String) {
    serverNotifyQueues.remove(address)
    while (serverNotifyRoundRobin.remove(address)) {
      // Defensive: the enqueue path prevents duplicates, but remove all if a
      // previous session/vendor callback ever introduced one.
    }
  }

  /** Android allows only one outstanding GATT operation per connection, so
   *  fragments are drained one at a time, advancing on each write callback. */
  private fun processClientWriteQueue(generation: Long, address: String) {
    val operation: ClientWriteOperation = synchronized(lifecycleLock) {
      if (!isCurrentGeneration(generation) || !outgoingReady.contains(address)) {
        return@synchronized null
      }
      if (clientWriteInFlight.containsKey(address)) return@synchronized null
      val queue = clientWriteQueues[address]
      val next = queue?.let { synchronized(it) { it.removeFirstOrNull() } }
      val gatt = outgoingConnections[address]
      if (next == null || gatt == null) {
        clientWriteInFlight.remove(address)
        return@synchronized null
      }
      val token = ++nextOperationToken
      clientWriteInFlight[address] = ClientWriteInFlight(gatt, token)
      ClientWriteOperation(gatt, next, token)
    } ?: return
    val gatt = operation.gatt
    val characteristic = gatt.getService(SERVICE_UUID)?.getCharacteristic(CHARACTERISTIC_UUID)
    if (characteristic == null) {
      recordGattError(generation, "gatt-client-write-characteristic", BluetoothGatt.GATT_FAILURE)
      closeOutgoingGatt(generation, gatt, failureStage = "gatt-client-write-characteristic")
      return
    }
    try {
      val accepted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        gatt.writeCharacteristic(
          characteristic,
          operation.payload,
          BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        ) == BluetoothStatusCodes.SUCCESS
      } else {
        @Suppress("DEPRECATION")
        characteristic.value = operation.payload
        @Suppress("DEPRECATION")
        characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        @Suppress("DEPRECATION")
        gatt.writeCharacteristic(characteristic)
      }
      if (!accepted) {
        recordGattError(generation, "gatt-client-write-submit", BluetoothGatt.GATT_FAILURE)
        closeOutgoingGatt(generation, gatt, failureStage = "gatt-client-write-submit")
      } else {
        scheduleClientWriteWatchdog(
          generation,
          operation.gatt,
          operation.token
        )
      }
    } catch (_: Exception) {
      recordGattError(generation, "gatt-client-write-submit", BluetoothGatt.GATT_FAILURE)
      closeOutgoingGatt(generation, gatt, failureStage = "gatt-client-write-submit")
    }
  }

  /** A vendor stack may accept writeCharacteristic() and never deliver its
   * callback. The token makes timeout-vs-callback completion atomic. A timeout
   * closes the whole client GATT: reusing it would let the missing callback
   * advance a later operation whose callback carries no request identifier. */
  /**
   * Cancels a watchdog once its operation completed normally.
   *
   * Without this every fragment left a 5 s runnable resident on the main
   * Looper — hundreds of them during one message at a low MTU, each waking up
   * later only to take lifecycleLock and discover its token is stale. The token
   * check keeps them harmless, but the queue pressure lands on the same thread
   * that services the BLE callbacks and React.
   */
  private fun cancelWatchdog(key: Long) {
    val scheduled = pendingWatchdogs.remove(key) ?: return
    mainHandler.removeCallbacks(scheduled)
  }

  private fun scheduleClientWriteWatchdog(
    generation: Long,
    gatt: BluetoothGatt,
    token: Long
  ) {
    val runnable = Runnable {
      pendingWatchdogs.remove(token)
      val closed = closeOutgoingGatt(
        generation,
        gatt,
        failureStage = "gatt-client-write-timeout",
        expectedClientWriteToken = token
      )
      if (closed) {
        recordGattError(
          generation,
          "gatt-client-write-timeout",
          BluetoothGatt.GATT_FAILURE
        )
      }
    }
    pendingWatchdogs[token] = runnable
    mainHandler.postDelayed(runnable, CLIENT_WRITE_WATCHDOG_MS)
  }

  private fun processServerNotifyQueue(generation: Long) {
    var invalidAddress: String? = null
    val operation: ServerNotifyOperation? = synchronized(lifecycleLock) {
      if (!isCurrentGeneration(generation) || serverNotifyInFlightAddress != null) {
        return@synchronized null
      }
      var selectedAddress: String? = null
      var selectedPayload: ByteArray? = null
      while (serverNotifyRoundRobin.isNotEmpty()) {
        val candidateAddress = serverNotifyRoundRobin.removeFirst()
        val queue = serverNotifyQueues[candidateAddress] ?: continue
        if (!notifyEnabled.contains(candidateAddress)) {
          serverNotifyQueues.remove(candidateAddress, queue)
          continue
        }
        val payload = synchronized(queue) { queue.removeFirstOrNull() }
        if (payload == null) {
          serverNotifyQueues.remove(candidateAddress, queue)
          continue
        }
        val hasMore = synchronized(queue) { queue.isNotEmpty() }
        if (hasMore) {
          // One fragment per peer per turn: a large message cannot starve
          // small pending messages queued for another subscribed peer.
          serverNotifyRoundRobin.addLast(candidateAddress)
        } else {
          serverNotifyQueues.remove(candidateAddress, queue)
        }
        selectedAddress = candidateAddress
        selectedPayload = payload
        break
      }
      val address = selectedAddress ?: return@synchronized null
      val server = gattServer
      val characteristic = serverCharacteristic
      val device = incomingDevices[address]
      if (server == null || characteristic == null || device == null) {
        notifyEnabled.remove(address)
        removeServerNotifyQueueLocked(address)
        invalidAddress = address
        return@synchronized null
      }
      val token = ++nextOperationToken
      serverNotifyInFlightAddress = address
      serverNotifyInFlightToken = token
      ServerNotifyOperation(
        server,
        device,
        characteristic,
        address,
        requireNotNull(selectedPayload),
        token
      )
    }
    if (operation == null) {
      invalidAddress?.let {
        notifyPeerDisconnectedIfFullyGone(generation, it)
        processServerNotifyQueue(generation)
      }
      return
    }
    try {
      val accepted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        operation.server.notifyCharacteristicChanged(
          operation.device,
          operation.characteristic,
          false,
          operation.payload
        ) ==
          BluetoothStatusCodes.SUCCESS
      } else {
        @Suppress("DEPRECATION")
        operation.characteristic.value = operation.payload
        @Suppress("DEPRECATION")
        operation.server.notifyCharacteristicChanged(
          operation.device,
          operation.characteristic,
          false
        )
      }
      if (!accepted || shouldSampleFragmentDiagnostic()) {
        emitDiagnostic(
          generation,
          if (accepted) "server-notify-dispatched" else "server-notify-rejected",
          address = operation.address,
          count = operation.payload.size
        )
      }
      if (!accepted) {
        finishServerNotification(
          generation,
          operation.device,
          BluetoothGatt.GATT_FAILURE,
          "gatt-server-notify-submit"
        )
      } else {
        scheduleServerNotificationWatchdog(generation, operation.address, operation.token)
      }
    } catch (_: Exception) {
      finishServerNotification(
        generation,
        operation.device,
        BluetoothGatt.GATT_FAILURE,
        "gatt-server-notify-submit"
      )
    }
  }

  private fun finishServerNotification(
    generation: Long,
    device: BluetoothDevice,
    status: Int,
    failureStage: String = "gatt-server-notify"
  ) {
    val address = device.address
    var failed = false
    val activeServer = synchronized(lifecycleLock) {
      if (!isCurrentGeneration(generation) || serverNotifyInFlightAddress != address) {
        return@synchronized null
      }
      serverNotifyInFlightToken?.let { cancelWatchdog(it) }
      serverNotifyInFlightAddress = null
      serverNotifyInFlightToken = null
      if (status != BluetoothGatt.GATT_SUCCESS) {
        notifyEnabled.remove(address)
        incomingDevices.remove(address, device)
        incomingSubscriptionTokens.remove(address)
        removeServerNotifyQueueLocked(address)
        incomingMtuByAddress.remove(address)
        scheduleTopologyEvaluationLocked(generation, MIN_CONNECT_GAP_MS)
        failed = true
      }
      gattServer
    } ?: return
    if (failed) {
      recordGattError(generation, failureStage, status)
      try {
        activeServer.cancelConnection(device)
      } catch (_: Exception) {
      }
      notifyPeerDisconnectedIfFullyGone(generation, address)
    }
    processServerNotifyQueue(generation)
  }

  /** Android promises one onNotificationSent callback for each accepted
   *  server notification. If a vendor stack loses it, continuing in the same
   *  GATT-server session would make a late callback indistinguishable from a
   *  newer operation to the same address. Invalidate the whole native
   *  generation instead; JS will perform its bounded clean restart. */
  private fun scheduleServerNotificationWatchdog(
    generation: Long,
    address: String,
    token: Long
  ) {
    val runnable = Runnable {
      pendingWatchdogs.remove(token)
      var didFail = false
      synchronized(lifecycleLock) {
        if (!isCurrentGeneration(generation) ||
          serverNotifyInFlightAddress != address ||
          serverNotifyInFlightToken != token
        ) {
          return@synchronized
        }
        lastGattError = BluetoothGatt.GATT_FAILURE
        lastGattFailureStage = "gatt-server-notify-timeout"
        sessionGeneration += 1
        cleanupResourcesLocked()
        lastFailureStage = "gatt-server"
        lastStartError = "GATT server notification timed out"
        didFail = true
      }
      if (didFail) emitRadioState()
    }
    pendingWatchdogs[token] = runnable
    mainHandler.postDelayed(runnable, SERVER_NOTIFY_WATCHDOG_MS)
  }

  private fun handleIncomingChunk(generation: Long, address: String, chunk: ByteArray) {
    if (chunk.size < HEADER_SIZE) return
    val messageId = ((chunk[0].toInt() and 0xFF) shl 8) or (chunk[1].toInt() and 0xFF)
    val fragmentIndex =
      ((chunk[2].toInt() and 0xFF) shl 8) or (chunk[3].toInt() and 0xFF)
    val totalFragments =
      ((chunk[4].toInt() and 0xFF) shl 8) or (chunk[5].toInt() and 0xFF)
    if (totalFragments <= 0 ||
      totalFragments > MAX_FRAGMENTS_PER_MESSAGE ||
      fragmentIndex >= totalFragments
    ) return
    val payload = chunk.copyOfRange(HEADER_SIZE, chunk.size)
    val now = SystemClock.elapsedRealtime()

    val full = synchronized(lifecycleLock) {
      if (!isCurrentGeneration(generation)) return@synchronized null
      val perAddress = reassemblyBuffers.computeIfAbsent(address) { ConcurrentHashMap() }
      val existingBuffer = perAddress[messageId]
      val buffer = if (existingBuffer == null || existingBuffer.total != totalFragments) {
        if (existingBuffer == null && perAddress.size >= MAX_REASSEMBLIES_PER_PEER) {
          perAddress.entries.minByOrNull { it.value.lastUpdatedElapsedMs }?.let { oldest ->
            perAddress.remove(oldest.key, oldest.value)
          }
        }
        Reassembly(totalFragments, now).also { perAddress[messageId] = it }
      } else existingBuffer
      buffer.lastUpdatedElapsedMs = now
      if (buffer.chunks[fragmentIndex] == null) {
        buffer.chunks[fragmentIndex] = payload
        buffer.received++
      }
      if (buffer.received != buffer.total) return@synchronized null

      perAddress.remove(messageId, buffer)
      val totalSize = buffer.chunks.sumOf { it?.size ?: 0 }
      val assembled = ByteArray(totalSize)
      var assembledOffset = 0
      for (part in buffer.chunks) {
        if (part != null) {
          System.arraycopy(part, 0, assembled, assembledOffset, part.size)
          assembledOffset += part.size
        }
      }
      assembled
    }
    if (full != null) {
      val base64 = Base64.encodeToString(full, Base64.NO_WRAP)
      emitDiagnostic(generation, "message-assembled", address = address, count = full.size)
      // Dispatched outside lifecycleLock on purpose. sendEvent hops into the JS
      // runtime, and lifecycleLock is the same lock the transmit path needs
      // (sendToPeer, processClientWriteQueue, processServerNotifyQueue), so
      // holding it across that hop made receiving a message stall this phone's
      // own sending. sessionGeneration is @Volatile, so the staleness check is
      // still sound, and a late event is harmless: JS de-duplicates by id.
      if (isCurrentGeneration(generation)) {
        sendEvent("onMessageReceived", bundleOf("address" to address, "data" to base64))
      }
    }
  }
}

/** Process-wide owner of the radio session. Holding an application Context
 * keeps BLE independent from React/Activity recreation without leaking either
 * UI object. Android still cannot restart this after a user force-stop. */
internal object BleMeshRuntimeRegistry {
  @Volatile private var runtime: BleMeshRuntime? = null

  fun get(context: Context): BleMeshRuntime {
    runtime?.let { return it }
    return synchronized(this) {
      runtime ?: BleMeshRuntime(context.applicationContext).also { runtime = it }
    }
  }

  fun peek(): BleMeshRuntime? = runtime
}

/** Expo is now only a control/event facade. Destroying a React Native bridge
 * detaches its event sink but deliberately leaves the process-owned radio
 * session running; it does not make the JS message engine headless. An
 * explicit stop() remains the authority that tears radios down. */
class BleMeshModule : Module() {
  private val reactContext: Context
    get() = requireNotNull(appContext.reactContext) { "React context is not available" }

  private val nativeEventSink: (String, Bundle) -> Unit = { name, payload ->
    try {
      sendEvent(name, payload)
    } catch (_: Exception) {
      // A bridge can disappear between callback dispatch and delivery.
    }
  }

  private fun runtime(): BleMeshRuntime = BleMeshRuntimeRegistry.get(reactContext)

  private fun wifiAwareRuntime(): WifiAwareRuntime =
    WifiAwareRuntimeRegistry.get(reactContext)

  override fun definition() = ModuleDefinition {
    Name("BleMesh")

    Events(
      "onPeerDiscovered",
      "onPeerConnected",
      "onPeerDisconnected",
      "onMessageReceived",
      "onAdapterStateChanged",
      "onDiagnostic",
      "onWifiAwarePeerDiscovered",
      "onWifiAwarePeerConnected",
      "onWifiAwarePeerDisconnected",
      "onWifiAwareMessageReceived",
      "onWifiAwareStateChanged",
      "onWifiAwareDiagnostic"
    )

    OnStartObserving {
      runtime().attachEventSink(nativeEventSink)
      wifiAwareRuntime().attachEventSink(nativeEventSink)
    }

    OnStartObserving("onMessageReceived") {
      runtime().enableMessageDelivery(nativeEventSink)
    }

    OnStartObserving("onWifiAwareMessageReceived") {
      wifiAwareRuntime().enableMessageDelivery(nativeEventSink)
    }

    OnStopObserving("onMessageReceived") {
      BleMeshRuntimeRegistry.peek()?.disableMessageDelivery(nativeEventSink)
    }

    OnStopObserving("onWifiAwareMessageReceived") {
      WifiAwareRuntimeRegistry.peek()?.disableMessageDelivery(nativeEventSink)
    }

    OnStopObserving {
      BleMeshRuntimeRegistry.peek()?.detachEventSink(nativeEventSink)
      WifiAwareRuntimeRegistry.peek()?.detachEventSink(nativeEventSink)
    }

    Function("hasRequiredPermissions") { runtime().hasRequiredPermissions() }

    Function("isBluetoothEnabled") { runtime().isBluetoothEnabled() }

    Function("getRadioState") { runtime().getRadioState() }

    Function("getCapabilities") { runtime().getCapabilities() }

    Function("getLinkSnapshots") { runtime().getLinkSnapshots() }

    Function("requestEnableBluetooth") { runtime().requestEnableBluetooth() }

    Function("start") { runtime().startMesh() }

    Function("stop") { runtime().stopMesh() }

    Function("startWifiAware") { localNodeId: String ->
      wifiAwareRuntime().start(localNodeId)
    }

    Function("stopWifiAware") { wifiAwareRuntime().stop() }

    Function("getWifiAwareState") { wifiAwareRuntime().getState() }

    Function("getConnectedWifiAwarePeers") {
      wifiAwareRuntime().getConnectedPeers()
    }

    AsyncFunction("sendToWifiAwarePeer") { endpointId: String, base64Data: String ->
      wifiAwareRuntime().sendBase64(endpointId, base64Data)
    }

    Function("disconnectWifiAwarePeer") { endpointId: String ->
      WifiAwareRuntimeRegistry.peek()?.disconnect(endpointId)
    }

    Function("isPowerSaveMode") { wifiAwareRuntime().isPowerSaveMode() }

    Function("getConnectedPeers") { runtime().getConnectedPeers() }

    Function("isIgnoringBatteryOptimizations") {
      runtime().isIgnoringBatteryOptimizations()
    }

    Function("requestIgnoreBatteryOptimizations") {
      runtime().requestIgnoreBatteryOptimizations()
    }

    AsyncFunction("sendToPeer") { address: String, base64Data: String ->
      runtime().sendToPeerBase64(address, base64Data)
    }

    Function("disconnectPeer") { address: String ->
      BleMeshRuntimeRegistry.peek()?.disconnectPeer(address)
    }

    AsyncFunction("probeWifiAware") { timeoutMs: Int, promise: expo.modules.kotlin.Promise ->
      runtime().probeWifiAware(timeoutMs.toLong()) { result -> promise.resolve(result) }
    }

    OnDestroy {
      BleMeshRuntimeRegistry.peek()?.detachEventSink(nativeEventSink)
      WifiAwareRuntimeRegistry.peek()?.detachEventSink(nativeEventSink)
    }
  }
}
