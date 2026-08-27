package expo.modules.blemesh

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.aware.AttachCallback
import android.net.wifi.aware.DiscoverySession
import android.net.wifi.aware.DiscoverySessionCallback
import android.net.wifi.aware.PeerHandle
import android.net.wifi.aware.PublishConfig
import android.net.wifi.aware.PublishDiscoverySession
import android.net.wifi.aware.SubscribeConfig
import android.net.wifi.aware.SubscribeDiscoverySession
import android.net.wifi.aware.WifiAwareManager
import android.net.wifi.aware.WifiAwareNetworkInfo
import android.net.wifi.aware.WifiAwareNetworkSpecifier
import android.net.wifi.aware.WifiAwareSession
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Base64
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import androidx.core.os.bundleOf
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Process-owned Wi-Fi Aware transport, deliberately independent from BLE.
 *
 * Both phones publish and subscribe, while their stable node ids choose one
 * role deterministically: the lower id is client and the higher id is server.
 * The advertised id is only a hint; JS still performs Anyway's signed identity
 * challenge before trusting the endpoint or accepting protocol envelopes.
 */
internal class WifiAwareRuntime(private val context: Context) {
  companion object {
    const val SERVICE_NAME = "anyway-mesh-v1"
    const val MAX_FRAME_BYTES = 256 * 1024
    const val MAX_LINKS = 4
    const val CONNECT_TIMEOUT_MS = 20_000L
    private const val LINK_PSK = "Anyway-Mesh-Aware-v1"
    private const val HELLO_PREFIX = "HELLO|"
    private const val READY_PREFIX = "READY|"
    private const val PREFERENCES_NAME = "anyway_wifi_aware_runtime"
    private const val SESSION_DESIRED_KEY = "session_desired"
    private const val LOCAL_NODE_ID_KEY = "local_node_id"
    private const val MAX_DEFERRED_MESSAGES = 128
  }

  private data class PeerRecord(
    val endpointId: String,
    val nodeIdHint: String,
    var peerHandle: PeerHandle,
    var role: String,
    val discoveredAt: Long,
    var lastSeenAt: Long,
    var connecting: Boolean = false,
    var connectedAt: Long? = null,
    var callback: ConnectivityManager.NetworkCallback? = null,
    var network: Network? = null,
    var serverSocket: ServerSocket? = null,
    var socket: Socket? = null,
    var input: DataInputStream? = null,
    var output: DataOutputStream? = null,
    var readerThread: Thread? = null,
    var connectTimeout: Runnable? = null,
    var bytesSent: Long = 0,
    var bytesReceived: Long = 0
  )

  private val lifecycleLock = Any()
  private val eventSinkLock = Any()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val peers = ConcurrentHashMap<String, PeerRecord>()
  private val deferredMessages = ArrayDeque<Bundle>()

  @Volatile private var eventSink: ((String, Bundle) -> Unit)? = null
  @Volatile private var messageDeliveryEnabled = false
  @Volatile private var generation = 0L
  @Volatile private var localNodeId: String? = null
  @Volatile private var desired = false
  @Volatile private var starting = false
  @Volatile private var running = false
  @Volatile private var attached = false
  @Volatile private var publishing = false
  @Volatile private var subscribing = false
  @Volatile private var foregroundServiceActive = false
  @Volatile private var lastError: String? = null
  @Volatile private var lastFailureStage: String? = null

  private var manager: WifiAwareManager? = null
  private var awareSession: WifiAwareSession? = null
  private var publishSession: PublishDiscoverySession? = null
  private var subscribeSession: SubscribeDiscoverySession? = null
  private var availabilityReceiver: BroadcastReceiver? = null
  private var nextDiscoveryMessageId = 1
  private var sessionRetryRunnable: Runnable? = null

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
      while (deferredMessages.isNotEmpty()) {
        sink("onWifiAwareMessageReceived", deferredMessages.removeFirst())
      }
    }
  }

  fun disableMessageDelivery(sink: (String, Bundle) -> Unit) {
    synchronized(eventSinkLock) {
      if (eventSink === sink) messageDeliveryEnabled = false
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

  private fun sendEvent(name: String, payload: Bundle) {
    val sink = synchronized(eventSinkLock) {
      val current = eventSink
      if (
        name == "onWifiAwareMessageReceived" &&
        (current == null || !messageDeliveryEnabled)
      ) {
        if (deferredMessages.size >= MAX_DEFERRED_MESSAGES) deferredMessages.removeFirst()
        deferredMessages.addLast(Bundle(payload))
        return@synchronized null
      }
      current
    }
    sink?.invoke(name, payload)
  }

  fun getState(): Bundle = synchronized(lifecycleLock) { stateBundleLocked() }

  fun getConnectedPeers(): List<Bundle> = synchronized(lifecycleLock) {
    peers.values
      .filter { it.socket?.isConnected == true && it.socket?.isClosed == false }
      .map {
        bundleOf(
          "endpointId" to it.endpointId,
          "nodeIdHint" to it.nodeIdHint,
          "role" to it.role,
          "connectedAt" to (it.connectedAt ?: 0L),
          "bytesSent" to it.bytesSent.toDouble(),
          "bytesReceived" to it.bytesReceived.toDouble()
        )
      }
  }

  fun isDesiredOrActive(): Boolean = synchronized(lifecycleLock) {
    desired || starting || running
  }

  fun setForegroundServiceActive(active: Boolean) {
    if (foregroundServiceActive == active) return
    foregroundServiceActive = active
    emitState()
  }

  fun isPowerSaveMode(): Boolean = try {
    val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
    power?.isPowerSaveMode == true
  } catch (_: Exception) {
    false
  }

  /**
   * API 29 is the minimum data-path version because it exposes the peer IPv6
   * and server port needed for an automatic TCP socket. Android 7–9 devices
   * remain complete Anyway nodes through the independent BLE transport.
   */
  fun start(localId: String, rememberDesiredSession: Boolean = true): Boolean {
    val normalizedId = localId.trim()
    if (normalizedId.length !in 8..256) {
      failWithoutSession("identity", "Identidad local inválida para Wi-Fi Aware")
      return false
    }
    if (rememberDesiredSession) persistDesired(true, normalizedId)

    val accepted = synchronized(lifecycleLock) {
      desired = true
      localNodeId = normalizedId
      if (running && sessionHealthyLocked()) return@synchronized true

      generation += 1
      cleanupLocked(emitDisconnects = true)
      lastError = null
      lastFailureStage = null

      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        lastFailureStage = "api"
        lastError = "El canal de datos Wi-Fi Aware requiere Android 10 o superior"
        return@synchronized false
      }
      if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE)) {
        lastFailureStage = "hardware"
        lastError = "Este teléfono no incluye Wi-Fi Aware"
        return@synchronized false
      }
      if (!hasPermission()) {
        lastFailureStage = "permissions"
        lastError = "Falta el permiso de dispositivos Wi-Fi cercanos"
        return@synchronized false
      }
      val currentManager = context.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager
      if (currentManager == null || !currentManager.isAvailable) {
        lastFailureStage = "availability"
        lastError = "Wi-Fi Aware no está disponible ahora"
        return@synchronized false
      }

      manager = currentManager
      starting = true
      val currentGeneration = generation
      registerAvailabilityReceiverLocked(currentGeneration)
      mainHandler.post { attachSession(currentGeneration, currentManager, normalizedId) }
      true
    }

    if (accepted) {
      startForegroundKeepAlive()
    } else {
      if (rememberDesiredSession) {
        persistDesired(false, null)
        synchronized(lifecycleLock) { desired = false }
      } else if (desired) {
        scheduleSessionRetry(normalizedId, 15_000L)
      }
      stopForegroundKeepAliveIfUnused()
    }
    emitState()
    return accepted
  }

  fun stop(clearDesiredSession: Boolean = true) {
    if (clearDesiredSession) {
      persistDesired(false, null)
      synchronized(eventSinkLock) { deferredMessages.clear() }
    }
    synchronized(lifecycleLock) {
      desired = !clearDesiredSession && desired
      generation += 1
      cleanupLocked(emitDisconnects = true)
      lastError = null
      lastFailureStage = null
    }
    emitState()
    stopForegroundKeepAliveIfUnused()
  }

  fun ensureSessionForForegroundService(): Boolean {
    if (synchronized(lifecycleLock) { starting || running }) return true
    val restored = readDesiredSession() ?: return false
    return start(restored, rememberDesiredSession = false)
  }

  fun sendBase64(endpointId: String, base64Data: String): Boolean {
    val bytes = try {
      Base64.decode(base64Data, Base64.NO_WRAP)
    } catch (_: Exception) {
      return false
    }
    if (bytes.isEmpty() || bytes.size > MAX_FRAME_BYTES) return false
    val peer = synchronized(lifecycleLock) {
      peers[endpointId]?.takeIf {
        it.socket?.isConnected == true && it.socket?.isClosed == false && it.output != null
      }
    } ?: return false

    return try {
      val output = peer.output ?: return false
      synchronized(output) {
        output.writeInt(bytes.size)
        output.write(bytes)
        output.flush()
      }
      synchronized(lifecycleLock) { peer.bytesSent += bytes.size }
      true
    } catch (error: Exception) {
      disconnectPeer(peer, "write", error.message)
      false
    }
  }

  fun disconnect(endpointId: String) {
    val peer = synchronized(lifecycleLock) { peers[endpointId] } ?: return
    disconnectPeer(peer, "requested", null)
  }

  private fun hasPermission(): Boolean {
    val permission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      android.Manifest.permission.NEARBY_WIFI_DEVICES
    } else {
      android.Manifest.permission.ACCESS_FINE_LOCATION
    }
    return ContextCompat.checkSelfPermission(context, permission) ==
      PackageManager.PERMISSION_GRANTED
  }

  private fun sessionHealthyLocked(): Boolean =
    manager?.isAvailable == true && awareSession != null && publishing && subscribing

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun attachSession(
    currentGeneration: Long,
    awareManager: WifiAwareManager,
    currentLocalId: String
  ) {
    try {
      awareManager.attach(
        object : AttachCallback() {
          override fun onAttached(session: WifiAwareSession) {
            synchronized(lifecycleLock) {
              if (generation != currentGeneration || !desired) {
                try { session.close() } catch (_: Exception) {}
                return
              }
              awareSession = session
              attached = true
            }
            beginDiscovery(currentGeneration, session, currentLocalId)
            emitState()
          }

          override fun onAttachFailed() {
            failSession(currentGeneration, "attach", "Android rechazó la sesión Wi-Fi Aware")
          }
        },
        mainHandler
      )
    } catch (error: Exception) {
      failSession(currentGeneration, "attach", error.message ?: "Fallo al iniciar Wi-Fi Aware")
    }
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun beginDiscovery(
    currentGeneration: Long,
    session: WifiAwareSession,
    currentLocalId: String
  ) {
    val info = currentLocalId.toByteArray(StandardCharsets.UTF_8)
    val publishCallback = object : DiscoverySessionCallback() {
      override fun onPublishStarted(discoverySession: PublishDiscoverySession) {
        synchronized(lifecycleLock) {
          if (generation != currentGeneration) {
            try { discoverySession.close() } catch (_: Exception) {}
            return
          }
          publishSession = discoverySession
          publishing = true
          refreshRunningLocked()
        }
        emitState()
      }

      override fun onMessageReceived(peerHandle: PeerHandle, message: ByteArray) {
        val value = message.toString(StandardCharsets.UTF_8)
        if (!value.startsWith(HELLO_PREFIX)) return
        val remoteId = validRemoteId(value.removePrefix(HELLO_PREFIX), currentLocalId) ?: return
        if (currentLocalId <= remoteId) return
        val peer = upsertPeer(currentGeneration, remoteId, peerHandle, "server") ?: return
        val activePublish = synchronized(lifecycleLock) { publishSession } ?: return
        requestServerPath(currentGeneration, peer, activePublish)
      }

      override fun onMessageSendFailed(messageId: Int) {
        val activePublish = synchronized(lifecycleLock) { publishSession } ?: return
        val serverPeers = synchronized(lifecycleLock) {
          peers.values.filter { it.role == "server" && it.connecting && it.socket == null }
        }
        serverPeers.forEach { peer ->
          sendDiscoveryMessage(
            currentGeneration,
            activePublish,
            peer.peerHandle,
            "$READY_PREFIX$currentLocalId"
          )
        }
      }

      override fun onSessionConfigFailed() {
        failSession(currentGeneration, "publish", "No se pudo publicar el servicio Anyway")
      }

      override fun onSessionTerminated() {
        failSession(currentGeneration, "publish", "La publicación Wi-Fi Aware terminó")
      }
    }

    val subscribeCallback = object : DiscoverySessionCallback() {
      override fun onSubscribeStarted(discoverySession: SubscribeDiscoverySession) {
        synchronized(lifecycleLock) {
          if (generation != currentGeneration) {
            try { discoverySession.close() } catch (_: Exception) {}
            return
          }
          subscribeSession = discoverySession
          subscribing = true
          refreshRunningLocked()
        }
        emitState()
      }

      override fun onServiceDiscovered(
        peerHandle: PeerHandle,
        serviceSpecificInfo: ByteArray?,
        matchFilter: MutableList<ByteArray>?
      ) {
        val remoteId = validRemoteId(
          serviceSpecificInfo?.toString(StandardCharsets.UTF_8),
          currentLocalId
        ) ?: return
        val role = if (currentLocalId < remoteId) "client" else "server-passive"
        val peer = upsertPeer(currentGeneration, remoteId, peerHandle, role) ?: return
        if (role == "client" && !peer.connecting && peer.socket == null) {
          val activeSubscribe = synchronized(lifecycleLock) { subscribeSession } ?: return
          sendDiscoveryMessage(
            currentGeneration,
            activeSubscribe,
            peerHandle,
            "$HELLO_PREFIX$currentLocalId"
          )
        }
      }

      override fun onMessageReceived(peerHandle: PeerHandle, message: ByteArray) {
        val value = message.toString(StandardCharsets.UTF_8)
        if (!value.startsWith(READY_PREFIX)) return
        val remoteId = validRemoteId(value.removePrefix(READY_PREFIX), currentLocalId) ?: return
        if (currentLocalId >= remoteId) return
        val peer = upsertPeer(currentGeneration, remoteId, peerHandle, "client") ?: return
        val activeSubscribe = synchronized(lifecycleLock) { subscribeSession } ?: return
        requestClientPath(currentGeneration, peer, activeSubscribe)
      }

      override fun onMessageSendFailed(messageId: Int) {
        val retryPeers = synchronized(lifecycleLock) {
          peers.values.filter { it.role == "client" && !it.connecting && it.socket == null }
        }
        retryPeers.forEach { peer ->
          scheduleClientRetry(currentGeneration, peer.nodeIdHint, peer.peerHandle)
        }
      }

      override fun onSessionConfigFailed() {
        failSession(currentGeneration, "subscribe", "No se pudo buscar el servicio Anyway")
      }

      override fun onSessionTerminated() {
        failSession(currentGeneration, "subscribe", "La búsqueda Wi-Fi Aware terminó")
      }
    }

    try {
      session.publish(
        PublishConfig.Builder()
          .setServiceName(SERVICE_NAME)
          .setServiceSpecificInfo(info)
          .setTerminateNotificationEnabled(true)
          .build(),
        publishCallback,
        mainHandler
      )
      session.subscribe(
        SubscribeConfig.Builder()
          .setServiceName(SERVICE_NAME)
          .setTerminateNotificationEnabled(true)
          .build(),
        subscribeCallback,
        mainHandler
      )
    } catch (error: Exception) {
      failSession(currentGeneration, "discovery", error.message ?: "Fallo de descubrimiento")
    }
  }

  private fun validRemoteId(value: String?, currentLocalId: String): String? {
    val candidate = value?.trim() ?: return null
    if (candidate == currentLocalId || candidate.length !in 8..256) return null
    if (candidate.any { it.code < 33 || it.code > 126 }) return null
    return candidate
  }

  private fun endpointId(remoteNodeId: String): String {
    val digest = MessageDigest.getInstance("SHA-256")
      .digest(remoteNodeId.toByteArray(StandardCharsets.UTF_8))
    return "aware:" + digest.take(12).joinToString("") {
      "%02x".format(it.toInt() and 0xff)
    }
  }

  private fun upsertPeer(
    currentGeneration: Long,
    remoteId: String,
    handle: PeerHandle,
    role: String
  ): PeerRecord? {
    var discovered = false
    val peer = synchronized(lifecycleLock) {
      if (generation != currentGeneration || (!running && !starting)) return@synchronized null
      val endpoint = endpointId(remoteId)
      val existing = peers[endpoint]
      if (existing != null) {
        existing.peerHandle = handle
        existing.lastSeenAt = System.currentTimeMillis()
        if (role != "server-passive") existing.role = role
        existing
      } else {
        if (peers.size >= MAX_LINKS) return@synchronized null
        discovered = true
        PeerRecord(
          endpointId = endpoint,
          nodeIdHint = remoteId,
          peerHandle = handle,
          role = role,
          discoveredAt = System.currentTimeMillis(),
          lastSeenAt = System.currentTimeMillis()
        ).also { peers[endpoint] = it }
      }
    } ?: return null

    if (discovered) {
      sendEvent(
        "onWifiAwarePeerDiscovered",
        bundleOf(
          "endpointId" to peer.endpointId,
          "nodeIdHint" to peer.nodeIdHint,
          "role" to peer.role
        )
      )
      emitDiagnostic("peer-discovered", peer)
    }
    return peer
  }

  private fun sendDiscoveryMessage(
    currentGeneration: Long,
    session: DiscoverySession,
    peerHandle: PeerHandle,
    message: String
  ) {
    val messageId = synchronized(lifecycleLock) {
      if (generation != currentGeneration) return
      nextDiscoveryMessageId =
        if (nextDiscoveryMessageId == Int.MAX_VALUE) 1 else nextDiscoveryMessageId + 1
      nextDiscoveryMessageId
    }
    try {
      session.sendMessage(
        peerHandle,
        messageId,
        message.toByteArray(StandardCharsets.UTF_8)
      )
    } catch (error: Exception) {
      emitDiagnostic("discovery-message-failed", null, error.message)
    }
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun requestServerPath(
    currentGeneration: Long,
    peer: PeerRecord,
    discoverySession: PublishDiscoverySession
  ) {
    synchronized(lifecycleLock) {
      if (generation != currentGeneration || peer.connecting || peer.socket != null) return
      peer.connecting = true
    }
    val serverSocket = try {
      ServerSocket(0)
    } catch (error: Exception) {
      disconnectPeer(peer, "server-socket", error.message)
      return
    }

    val specifier = try {
      WifiAwareNetworkSpecifier.Builder(discoverySession, peer.peerHandle)
        .setPskPassphrase(LINK_PSK)
        .setPort(serverSocket.localPort)
        .setTransportProtocol(6)
        .build()
    } catch (error: Exception) {
      try { serverSocket.close() } catch (_: Exception) {}
      disconnectPeer(peer, "server-specifier", error.message)
      return
    }

    val callback = createServerNetworkCallback(currentGeneration, peer)
    synchronized(lifecycleLock) {
      if (generation != currentGeneration) {
        try { serverSocket.close() } catch (_: Exception) {}
        return
      }
      peer.serverSocket = serverSocket
      peer.callback = callback
      scheduleConnectTimeoutLocked(currentGeneration, peer)
    }
    if (!requestNetwork(specifier, callback, peer)) return

    sendDiscoveryMessage(
      currentGeneration,
      discoverySession,
      peer.peerHandle,
      "$READY_PREFIX${localNodeId ?: return}"
    )
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun requestClientPath(
    currentGeneration: Long,
    peer: PeerRecord,
    discoverySession: SubscribeDiscoverySession
  ) {
    synchronized(lifecycleLock) {
      if (generation != currentGeneration || peer.connecting || peer.socket != null) return
      peer.connecting = true
    }
    val specifier = try {
      WifiAwareNetworkSpecifier.Builder(discoverySession, peer.peerHandle)
        .setPskPassphrase(LINK_PSK)
        .build()
    } catch (error: Exception) {
      disconnectPeer(peer, "client-specifier", error.message)
      return
    }

    val callback = createClientNetworkCallback(currentGeneration, peer)
    synchronized(lifecycleLock) {
      if (generation != currentGeneration) return
      peer.callback = callback
      scheduleConnectTimeoutLocked(currentGeneration, peer)
    }
    requestNetwork(specifier, callback, peer)
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun requestNetwork(
    specifier: WifiAwareNetworkSpecifier,
    callback: ConnectivityManager.NetworkCallback,
    peer: PeerRecord
  ): Boolean {
    return try {
      val request = NetworkRequest.Builder()
        .addTransportType(NetworkCapabilities.TRANSPORT_WIFI_AWARE)
        .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        .setNetworkSpecifier(specifier)
        .build()
      connectivityManager().requestNetwork(request, callback)
      emitDiagnostic("data-path-requested", peer)
      true
    } catch (error: Exception) {
      disconnectPeer(peer, "network-request", error.message)
      false
    }
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun createServerNetworkCallback(
    currentGeneration: Long,
    peer: PeerRecord
  ): ConnectivityManager.NetworkCallback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) {
      synchronized(lifecycleLock) {
        if (generation != currentGeneration || peers[peer.endpointId] !== peer) return
        peer.network = network
      }
      val server = synchronized(lifecycleLock) { peer.serverSocket } ?: return
      Thread({
        try {
          establishSocket(currentGeneration, peer, server.accept())
        } catch (error: Exception) {
          if (synchronized(lifecycleLock) { generation == currentGeneration }) {
            disconnectPeer(peer, "accept", error.message)
          }
        }
      }, "AnywayAwareAccept-${peer.endpointId.takeLast(8)}").apply {
        isDaemon = true
        start()
      }
    }

    override fun onLost(network: Network) {
      disconnectPeer(peer, "network-lost", null)
    }

    override fun onUnavailable() {
      disconnectPeer(peer, "network-unavailable", null)
    }
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun createClientNetworkCallback(
    currentGeneration: Long,
    peer: PeerRecord
  ): ConnectivityManager.NetworkCallback = object : ConnectivityManager.NetworkCallback() {
    private val connectStarted = AtomicBoolean(false)

    override fun onAvailable(network: Network) {
      synchronized(lifecycleLock) {
        if (generation != currentGeneration || peers[peer.endpointId] !== peer) return
        peer.network = network
      }
    }

    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
      if (!connectStarted.compareAndSet(false, true)) return
      val info = capabilities.transportInfo as? WifiAwareNetworkInfo
      val address = info?.peerIpv6Addr
      val port = info?.port ?: 0
      if (address == null || port <= 0) {
        connectStarted.set(false)
        return
      }
      Thread({
        try {
          establishSocket(
            currentGeneration,
            peer,
            network.socketFactory.createSocket(address, port)
          )
        } catch (error: Exception) {
          disconnectPeer(peer, "connect", error.message)
        }
      }, "AnywayAwareConnect-${peer.endpointId.takeLast(8)}").apply {
        isDaemon = true
        start()
      }
    }

    override fun onLost(network: Network) {
      disconnectPeer(peer, "network-lost", null)
    }

    override fun onUnavailable() {
      disconnectPeer(peer, "network-unavailable", null)
    }
  }

  private fun establishSocket(currentGeneration: Long, peer: PeerRecord, socket: Socket) {
    try {
      socket.tcpNoDelay = true
      socket.keepAlive = true
      val input = DataInputStream(socket.getInputStream())
      val output = DataOutputStream(socket.getOutputStream())
      synchronized(lifecycleLock) {
        if (generation != currentGeneration || peers[peer.endpointId] !== peer) {
          try { socket.close() } catch (_: Exception) {}
          return
        }
        peer.socket?.let { old -> try { old.close() } catch (_: Exception) {} }
        peer.socket = socket
        peer.input = input
        peer.output = output
        peer.connecting = false
        peer.connectedAt = System.currentTimeMillis()
        peer.connectTimeout?.let(mainHandler::removeCallbacks)
        peer.connectTimeout = null
      }
      sendEvent(
        "onWifiAwarePeerConnected",
        bundleOf(
          "endpointId" to peer.endpointId,
          "nodeIdHint" to peer.nodeIdHint,
          "role" to peer.role
        )
      )
      emitDiagnostic("link-ready", peer)
      startReader(currentGeneration, peer, input)
      emitState()
    } catch (error: Exception) {
      try { socket.close() } catch (_: Exception) {}
      disconnectPeer(peer, "socket-setup", error.message)
    }
  }

  private fun startReader(
    currentGeneration: Long,
    peer: PeerRecord,
    input: DataInputStream
  ) {
    val reader = Thread({
      try {
        while (true) {
          val size = input.readInt()
          if (size <= 0 || size > MAX_FRAME_BYTES) {
            throw IllegalStateException("Invalid Aware frame size: $size")
          }
          val bytes = ByteArray(size)
          input.readFully(bytes)
          val accepted = synchronized(lifecycleLock) {
            if (generation != currentGeneration || peers[peer.endpointId] !== peer) false
            else {
              peer.bytesReceived += size
              peer.lastSeenAt = System.currentTimeMillis()
              true
            }
          }
          if (!accepted) break
          sendEvent(
            "onWifiAwareMessageReceived",
            bundleOf(
              "endpointId" to peer.endpointId,
              "nodeIdHint" to peer.nodeIdHint,
              "data" to Base64.encodeToString(bytes, Base64.NO_WRAP)
            )
          )
        }
      } catch (error: Exception) {
        if (synchronized(lifecycleLock) { generation == currentGeneration }) {
          disconnectPeer(peer, "read", error.message)
        }
      }
    }, "AnywayAwareRead-${peer.endpointId.takeLast(8)}").apply {
      isDaemon = true
    }
    synchronized(lifecycleLock) { peer.readerThread = reader }
    reader.start()
  }

  private fun scheduleConnectTimeoutLocked(currentGeneration: Long, peer: PeerRecord) {
    peer.connectTimeout?.let(mainHandler::removeCallbacks)
    val timeout = Runnable {
      val shouldClose = synchronized(lifecycleLock) {
        generation == currentGeneration &&
          peers[peer.endpointId] === peer &&
          peer.socket == null
      }
      if (shouldClose) disconnectPeer(peer, "connect-timeout", null)
    }
    peer.connectTimeout = timeout
    mainHandler.postDelayed(timeout, CONNECT_TIMEOUT_MS)
  }

  private fun disconnectPeer(peer: PeerRecord, stage: String, detail: String?) {
    val wasConnected: Boolean
    val retryGeneration: Long?
    synchronized(lifecycleLock) {
      if (!peers.remove(peer.endpointId, peer)) return
      wasConnected = peer.connectedAt != null
      retryGeneration = generation.takeIf {
        desired && running && peer.role == "client" && stage != "requested"
      }
      closePeerLocked(peer)
    }
    if (wasConnected) {
      sendEvent(
        "onWifiAwarePeerDisconnected",
        bundleOf(
          "endpointId" to peer.endpointId,
          "nodeIdHint" to peer.nodeIdHint,
          "stage" to stage
        )
      )
    }
    emitDiagnostic("link-closed", peer, detail ?: stage)
    emitState()
    retryGeneration?.let {
      scheduleClientRetry(it, peer.nodeIdHint, peer.peerHandle)
    }
  }

  private fun scheduleClientRetry(
    currentGeneration: Long,
    remoteId: String,
    peerHandle: PeerHandle
  ) {
    mainHandler.postDelayed({
      val activeSubscribe = synchronized(lifecycleLock) {
        if (generation != currentGeneration || !desired || !running) null
        else subscribeSession
      } ?: return@postDelayed
      val retryPeer = upsertPeer(currentGeneration, remoteId, peerHandle, "client")
        ?: return@postDelayed
      if (retryPeer.connecting || retryPeer.socket != null) return@postDelayed
      sendDiscoveryMessage(
        currentGeneration,
        activeSubscribe,
        retryPeer.peerHandle,
        "$HELLO_PREFIX${localNodeId ?: return@postDelayed}"
      )
    }, 2_000L)
  }

  private fun closePeerLocked(peer: PeerRecord) {
    peer.connectTimeout?.let(mainHandler::removeCallbacks)
    peer.connectTimeout = null
    peer.callback?.let { callback ->
      try { connectivityManager().unregisterNetworkCallback(callback) } catch (_: Exception) {}
    }
    peer.callback = null
    try { peer.input?.close() } catch (_: Exception) {}
    try { peer.output?.close() } catch (_: Exception) {}
    try { peer.socket?.close() } catch (_: Exception) {}
    try { peer.serverSocket?.close() } catch (_: Exception) {}
    peer.input = null
    peer.output = null
    peer.socket = null
    peer.serverSocket = null
    peer.network = null
    peer.connecting = false
  }

  private fun refreshRunningLocked() {
    running = attached && publishing && subscribing
    starting = !running && (attached || publishSession != null || subscribeSession != null)
  }

  private fun failWithoutSession(stage: String, error: String) {
    synchronized(lifecycleLock) {
      lastFailureStage = stage
      lastError = error
    }
    emitState()
  }

  private fun failSession(currentGeneration: Long, stage: String, error: String) {
    var retryNodeId: String? = null
    synchronized(lifecycleLock) {
      if (generation != currentGeneration) return
      generation += 1
      cleanupLocked(emitDisconnects = true)
      lastFailureStage = stage
      lastError = error
      if (desired && stage !in setOf("identity", "api", "hardware", "permissions")) {
        retryNodeId = localNodeId
      }
    }
    emitDiagnostic("session-failed", null, "$stage: $error")
    emitState()
    stopForegroundKeepAliveIfUnused()
    retryNodeId?.let { scheduleSessionRetry(it, 5_000L) }
  }

  private fun scheduleSessionRetry(nodeId: String, delayMs: Long) {
    val runnable = Runnable {
      synchronized(lifecycleLock) {
        if (sessionRetryRunnable !== null) sessionRetryRunnable = null
        if (!desired || running || starting) return@Runnable
      }
      start(nodeId, rememberDesiredSession = false)
    }
    synchronized(lifecycleLock) {
      sessionRetryRunnable?.let(mainHandler::removeCallbacks)
      sessionRetryRunnable = runnable
    }
    mainHandler.postDelayed(runnable, delayMs)
  }

  private fun cleanupLocked(emitDisconnects: Boolean) {
    sessionRetryRunnable?.let(mainHandler::removeCallbacks)
    sessionRetryRunnable = null
    starting = false
    running = false
    attached = false
    publishing = false
    subscribing = false
    val oldPeers = peers.values.toList()
    peers.clear()
    oldPeers.forEach { peer ->
      val wasConnected = peer.connectedAt != null
      closePeerLocked(peer)
      if (emitDisconnects && wasConnected) {
        try {
          sendEvent(
            "onWifiAwarePeerDisconnected",
            bundleOf(
              "endpointId" to peer.endpointId,
              "nodeIdHint" to peer.nodeIdHint,
              "stage" to "session-stop"
            )
          )
        } catch (_: Exception) {}
      }
    }
    try { subscribeSession?.close() } catch (_: Exception) {}
    try { publishSession?.close() } catch (_: Exception) {}
    try { awareSession?.close() } catch (_: Exception) {}
    subscribeSession = null
    publishSession = null
    awareSession = null
    manager = null
    availabilityReceiver?.let { receiver ->
      try { context.unregisterReceiver(receiver) } catch (_: Exception) {}
    }
    availabilityReceiver = null
  }

  private fun registerAvailabilityReceiverLocked(currentGeneration: Long) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(receiverContext: Context?, intent: Intent?) {
        if (intent?.action != WifiAwareManager.ACTION_WIFI_AWARE_STATE_CHANGED) return
        val available = try {
          val current = context.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager
          current?.isAvailable == true
        } catch (_: Exception) {
          false
        }
        if (!available) {
          failSession(
            currentGeneration,
            "availability",
            "Wi-Fi Aware dejó de estar disponible; BLE continúa independiente"
          )
        }
      }
    }
    ContextCompat.registerReceiver(
      context,
      receiver,
      IntentFilter(WifiAwareManager.ACTION_WIFI_AWARE_STATE_CHANGED),
      ContextCompat.RECEIVER_NOT_EXPORTED
    )
    availabilityReceiver = receiver
  }

  private fun stateBundleLocked(): Bundle = bundleOf(
    "supported" to (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE)
      ),
    "available" to try { manager?.isAvailable ?: isAvailable() } catch (_: Exception) { false },
    "hasPermission" to hasPermission(),
    "starting" to starting,
    "running" to running,
    "attached" to attached,
    "publishing" to publishing,
    "subscribing" to subscribing,
    "generation" to generation,
    "discoveredPeers" to peers.size,
    "connectedPeers" to peers.values.count {
      it.socket?.isConnected == true && it.socket?.isClosed == false
    },
    "powerSaveMode" to isPowerSaveMode(),
    "foregroundServiceActive" to foregroundServiceActive,
    "maxFrameBytes" to MAX_FRAME_BYTES
  ).also { state ->
    lastError?.let { state.putString("error", it) }
    lastFailureStage?.let { state.putString("failureStage", it) }
  }

  private fun isAvailable(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
    val current = context.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager
    return current?.isAvailable == true
  }

  private fun emitState() {
    try { sendEvent("onWifiAwareStateChanged", getState()) } catch (_: Exception) {}
  }

  private fun emitDiagnostic(type: String, peer: PeerRecord?, detail: String? = null) {
    val payload = bundleOf(
      "type" to type,
      "timestampMs" to System.currentTimeMillis(),
      "generation" to generation,
      "transport" to "wifi-aware"
    )
    peer?.let {
      payload.putString("endpointId", it.endpointId)
      payload.putString("nodeIdHint", it.nodeIdHint)
      payload.putString("role", it.role)
    }
    detail?.let { payload.putString("detail", it) }
    try { sendEvent("onWifiAwareDiagnostic", payload) } catch (_: Exception) {}
  }

  private fun connectivityManager(): ConnectivityManager =
    context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

  private fun persistDesired(value: Boolean, nodeId: String?) {
    desired = value
    try {
      context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
        .edit()
        .putBoolean(SESSION_DESIRED_KEY, value)
        .apply {
          if (nodeId == null) remove(LOCAL_NODE_ID_KEY) else putString(LOCAL_NODE_ID_KEY, nodeId)
        }
        .commit()
    } catch (_: Exception) {}
  }

  private fun readDesiredSession(): String? = try {
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
      .takeIf { it.getBoolean(SESSION_DESIRED_KEY, false) }
      ?.getString(LOCAL_NODE_ID_KEY, null)
  } catch (_: Exception) {
    null
  }

  private fun startForegroundKeepAlive() {
    try {
      ContextCompat.startForegroundService(
        context,
        Intent(context, AnywayForegroundService::class.java)
      )
    } catch (_: Exception) {}
  }

  private fun stopForegroundKeepAliveIfUnused() {
    if (BleMeshRuntimeRegistry.peek()?.isDesiredOrActive() == true) return
    try { context.stopService(Intent(context, AnywayForegroundService::class.java)) } catch (_: Exception) {}
  }
}

internal object WifiAwareRuntimeRegistry {
  @Volatile private var runtime: WifiAwareRuntime? = null

  fun get(context: Context): WifiAwareRuntime {
    runtime?.let { return it }
    return synchronized(this) {
      runtime ?: WifiAwareRuntime(context.applicationContext).also { runtime = it }
    }
  }

  fun peek(): WifiAwareRuntime? = runtime
}
