import React, { useEffect, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import BleMesh from '../../modules/ble-mesh/src';
import { COLOR_PALETTE } from '../mesh/color';
import { useMesh } from '../mesh/MeshProvider';
import {
  BackgroundDiscoveryPermission,
  getBackgroundDiscoveryPermission,
  requestBackgroundDiscoveryPermission,
  requestStartupPermissions,
} from '../mesh/permissions';
import { PROTOCOL_VERSION } from '../mesh/protocol';
import { APP_BUILD, APP_VERSION } from '../version';
import { palette, radius, shadow } from '../ui/theme';

const PERMISSION_LABELS: Record<string, string> = {
  bluetooth: 'Bluetooth cercano',
  location: 'Ubicación',
  notifications: 'Notificaciones',
  nearbyWifi: 'Wi‑Fi cercano',
};

const AVAILABILITY_LABELS: Record<string, string> = {
  supported: 'Disponible',
  unsupported: 'No soportado',
  'temporarily-unavailable': 'No disponible ahora',
  unknown: 'Sin determinar',
};

const TRANSPORT_ROWS = [
  {
    key: 'ble' as const,
    label: 'Bluetooth LE',
    hint: 'Transporte activo. Descubre y conecta con otros teléfonos automáticamente, sin emparejar.',
    unsupportedHint: 'Este teléfono no puede usar Bluetooth LE, que es el transporte principal de la app.',
  },
  {
    key: 'wifi-aware' as const,
    label: 'Wi‑Fi Aware',
    hint: 'Transporte automático de alta velocidad. Descubre, vincula y cifra el enlace sin emparejamiento manual.',
    unsupportedHint:
      'El hardware o esta versión de Android no ofrecen el canal de datos automático; seguirá funcionando por Bluetooth.',
  },
  {
    key: 'wifi-direct' as const,
    label: 'Wi‑Fi Direct',
    hint: 'El hardware lo soporta. Queda pendiente a futuro: requiere una confirmación del sistema al conectar.',
    unsupportedHint: 'Este teléfono no tiene Wi‑Fi Direct.',
  },
];

export function SettingsScreen({
  onOpenDiagnostics,
}: {
  onOpenDiagnostics?: () => void;
}) {
  const {
    nickname,
    nodeId,
    ttl,
    color,
    setNickname,
    setTtl,
    setColor,
    clearAllMessages,
    status,
    meshEnabled,
    restartMesh,
    stopMesh,
    requestStart,
    nearbyDevices,
    batteryOptimizationIgnored,
    requestIgnoreBatteryOptimizations,
    capabilities,
    hydrationWarnings,
    wifiAwareState,
    powerSaveMode,
  } = useMesh();
  const [draftName, setDraftName] = useState(nickname ?? '');
  const [awareProbe, setAwareProbe] = useState<'idle' | 'running' | 'done'>('idle');
  const [awareProbeText, setAwareProbeText] = useState<string | null>(null);
  const [permissionsText, setPermissionsText] = useState<string | null>(null);
  const connectedLinks = nearbyDevices.filter((peer) => peer.connected).length;

  // Re-asking matters most for the optional grants: someone who declined
  // "Wi-Fi cercano" at startup would otherwise never get a second chance, and
  // the Wi-Fi Aware probe below would keep failing for a reason they can fix.
  const requestPermissionsAgain = async () => {
    const outcomes = await requestStartupPermissions();
    const pending = Object.entries(outcomes)
      .filter(([, value]) => value === 'denied' || value === 'blocked')
      .map(([key]) => PERMISSION_LABELS[key] ?? key);
    setPermissionsText(
      pending.length === 0
        ? 'Todos los permisos están concedidos.'
        : `Falta conceder: ${pending.join(', ')}. Si Android ya no pregunta, hay que activarlos a mano en los ajustes del sistema.`,
    );
  };

  // Reports the first step that failed, because that is the actionable part: a
  // missing permission, Wi-Fi switched off and unsupported hardware all look
  // identical from the capability flag alone.
  const runAwareProbe = async () => {
    setAwareProbe('running');
    setAwareProbeText(null);
    try {
      const probe = await BleMesh.probeWifiAware(12_000);
      if (!probe.supported) {
        setAwareProbeText(probe.error ?? 'Este teléfono no soporta Wi‑Fi Aware.');
      } else if (!probe.permissionGranted || !probe.available || !probe.attached) {
        setAwareProbeText(probe.error ?? 'No se pudo iniciar una sesión de Wi‑Fi Aware.');
      } else if (probe.peersDiscovered > 0) {
        setAwareProbeText(
          `Funciona: sesión activa y se encontró ${probe.peersDiscovered} equipo${
            probe.peersDiscovered === 1 ? '' : 's'
          } por Wi‑Fi Aware.`,
        );
      } else {
        setAwareProbeText(
          'La sesión de Wi‑Fi Aware arrancó bien, pero no apareció ningún otro equipo. ' +
            'Probá de nuevo tocando el botón en los dos teléfonos casi a la vez.',
        );
      }
    } catch (error) {
      setAwareProbeText(
        error instanceof Error ? error.message : 'La prueba falló por un error inesperado.',
      );
    } finally {
      setAwareProbe('done');
    }
  };
  const [backgroundPermission, setBackgroundPermission] =
    useState<BackgroundDiscoveryPermission | 'checking' | 'requesting'>('checking');

  useEffect(() => {
    let active = true;
    void getBackgroundDiscoveryPermission()
      .then((value) => {
        if (active) setBackgroundPermission(value);
      })
      .catch(() => {
        if (active) setBackgroundPermission('not-granted');
      });
    return () => {
      active = false;
    };
  }, []);

  const requestBackgroundPermission = async () => {
    setBackgroundPermission('requesting');
    try {
      if (backgroundPermission === 'blocked') {
        await Linking.openSettings();
        setBackgroundPermission(await getBackgroundDiscoveryPermission());
        return;
      }
      setBackgroundPermission(await requestBackgroundDiscoveryPermission());
    } catch {
      setBackgroundPermission('not-granted');
    }
  };

  const saveNickname = () => {
    const trimmed = draftName.trim().slice(0, 24);
    if (trimmed.length === 0) return;
    setNickname(trimmed);
  };

  const confirmClear = () => {
    Alert.alert(
      'Borrar historial',
      'Esto borra los mensajes de todos los chats, grupos y del canal público guardados en este celular. Los chats y grupos en sí no se eliminan.',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Borrar', style: 'destructive', onPress: clearAllMessages },
      ]
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.pageEyebrow}>CENTRO DE CONTROL</Text>
      <Text style={styles.pageTitle}>Ajustes</Text>
      <Text style={styles.pageSubtitle}>
        Tu identidad, el alcance de la red y la salud de los transportes en un solo lugar.
      </Text>
      <View style={styles.statusHero}>
        <View style={[styles.statusOrb, status === 'running' && styles.statusOrbRunning]}>
          <View style={[styles.statusCore, status === 'running' && styles.statusCoreRunning]} />
        </View>
        <View style={styles.statusCopy}>
          <Text style={styles.statusLabel}>ESTADO DE LA MALLA</Text>
          <Text style={styles.statusValue}>{statusLabel(status, connectedLinks)}</Text>
        </View>
        <Text style={[styles.statusBadge, meshEnabled && styles.statusBadgeOn]}>
          {meshEnabled ? 'ACTIVA' : 'PAUSADA'}
        </Text>
      </View>

      <Text style={styles.section}>Perfil</Text>
      <TextInput
        style={styles.input}
        value={draftName}
        onChangeText={setDraftName}
        maxLength={24}
        placeholder="Tu apodo"
        placeholderTextColor="#8a8f98"
        onBlur={saveNickname}
        onSubmitEditing={saveNickname}
        returnKeyType="done"
      />
      <Text style={styles.hint}>ID de dispositivo: {nodeId}</Text>

      <Text style={styles.section}>Tu color</Text>
      <Text style={styles.hint}>
        Así se destaca tu nombre en el canal público y en los grupos, para
        que se te identifique de un vistazo.
      </Text>
      <View style={styles.colorRow}>
        {COLOR_PALETTE.map((swatch) => (
          <Pressable
            key={swatch}
            onPress={() => setColor(swatch)}
            style={[
              styles.colorSwatch,
              { backgroundColor: swatch },
              color === swatch && styles.colorSwatchSelected,
            ]}
          >
            {color === swatch && <Text style={styles.colorSwatchCheck}>✓</Text>}
          </Pressable>
        ))}
      </View>

      <Text style={styles.section}>Alcance de la red (TTL)</Text>
      <Text style={styles.hint}>
        Cuántos saltos puede recorrer un mensaje antes de dejar de reenviarse.
        Más alto = más alcance, pero más tráfico en la red.
      </Text>
      <View style={styles.stepperRow}>
        <Pressable
          style={styles.stepperButton}
          onPress={() => setTtl(Math.max(1, ttl - 1))}
        >
          <Text style={styles.stepperButtonText}>−</Text>
        </Pressable>
        <Text style={styles.stepperValue}>{ttl}</Text>
        <Pressable
          style={styles.stepperButton}
          onPress={() => setTtl(Math.min(10, ttl + 1))}
        >
          <Text style={styles.stepperButtonText}>+</Text>
        </Pressable>
      </View>

      <Text style={styles.section}>Radios de la malla</Text>
      <Text style={styles.hint}>
        Estado: {statusLabel(status, connectedLinks)}
      </Text>
      <Text style={styles.hint}>
        BLE y Wi‑Fi Aware se administran por separado. Un fallo de uno no
        detiene al otro, y la app elige el enlace de cada salto automáticamente.
      </Text>
      <Text style={styles.hint}>
        Wi‑Fi Aware: {wifiAwareState.running
          ? `${wifiAwareState.connectedPeers} enlace${wifiAwareState.connectedPeers === 1 ? '' : 's'} activo${wifiAwareState.connectedPeers === 1 ? '' : 's'}`
          : wifiAwareState.supported
            ? wifiAwareState.error ?? 'esperando disponibilidad'
            : 'no soportado; BLE sigue disponible'}.
      </Text>
      <Text style={styles.hint}>
        Perfil de ruta: {powerSaveMode ? 'ahorro de batería' : 'máxima velocidad'}.
      </Text>
      <Text style={styles.hint}>
        Preferencia local: {meshEnabled ? 'malla habilitada' : 'malla pausada'}.
      </Text>
      <Pressable
        style={styles.secondaryButton}
        onPress={meshEnabled ? stopMesh : requestStart}
      >
        <Text style={styles.secondaryButtonText}>
          {meshEnabled ? 'Pausar malla' : 'Reanudar malla'}
        </Text>
      </Pressable>
      {meshEnabled && (
        <Pressable style={styles.secondaryButton} onPress={restartMesh}>
          <Text style={styles.secondaryButtonText}>Reiniciar transportes</Text>
        </Pressable>
      )}

      <Text style={styles.section}>Segundo plano</Text>
      <Text style={styles.hint}>
        Android usa un servicio en primer plano con notificación para permitir
        que la radio siga buscando enlaces fuera de esta pantalla mientras el
        proceso continúe disponible. El motor cifrado/persistente todavía
        requiere el runtime de la app: el servicio no garantiza mensajería DTN
        autónoma tras una muerte completa del proceso. Tampoco es inmortal; el
        sistema, el fabricante o el usuario pueden pausarlo o detenerlo. Quitar
        la optimización de batería reduce una restricción, pero no garantiza
        continuidad.
      </Text>
      {batteryOptimizationIgnored ? (
        <Text style={[styles.hint, styles.hintOk]}>
          ✓ Sin restricciones de batería para esta app.
        </Text>
      ) : (
        <Pressable style={styles.secondaryButton} onPress={requestIgnoreBatteryOptimizations}>
          <Text style={styles.secondaryButtonText}>Desactivar optimización de batería</Text>
        </Pressable>
      )}
      {backgroundPermission === 'granted' && (
        <Text style={[styles.hint, styles.hintOk]}>
          ✓ Android autorizó el descubrimiento BLE en segundo plano.
        </Text>
      )}
      {backgroundPermission === 'not-required' && (
        <Text style={styles.hint}>
          Esta versión de Android usa permisos Nearby/Bluetooth o el permiso
          de ubicación ya concedido; no necesita un grant adicional acá.
        </Text>
      )}
      {(backgroundPermission === 'not-granted' ||
        backgroundPermission === 'blocked' ||
        backgroundPermission === 'requesting') && (
        <>
          <Text style={styles.hint}>
            En Android 10–11, conceder ubicación “todo el tiempo” permite recibir
            resultados de escaneo cuando Anyway no está visible. Android puede
            abrir Ajustes para completar este permiso.
          </Text>
          <Pressable
            style={styles.secondaryButton}
            disabled={backgroundPermission === 'requesting'}
            onPress={requestBackgroundPermission}
          >
            <Text style={styles.secondaryButtonText}>
              {backgroundPermission === 'requesting'
                ? 'Solicitando permiso…'
                : backgroundPermission === 'blocked'
                  ? 'Revisar permiso en Ajustes'
                  : 'Permitir descubrimiento en segundo plano'}
            </Text>
          </Pressable>
        </>
      )}

      <Text style={styles.section}>Qué soporta este teléfono</Text>
      <Text style={styles.hint}>
        Detectado en este dispositivo. Si una función figura como no soportada, es una
        limitación del hardware o del sistema, no de la app.
      </Text>
      {TRANSPORT_ROWS.map((row) => {
        const transport = capabilities.transports[row.key];
        const availability = transport?.availability ?? 'unknown';
        return (
          <View key={row.key} style={styles.capabilityRow}>
            <View style={styles.capabilityHeader}>
              <Text style={styles.capabilityName}>{row.label}</Text>
              <Text style={[styles.capabilityBadge, badgeStyleFor(availability)]}>
                {AVAILABILITY_LABELS[availability]}
              </Text>
            </View>
            <Text style={styles.capabilityDetail}>
              {availability === 'unsupported' ? row.unsupportedHint : row.hint}
            </Text>
          </View>
        );
      })}
      <Pressable style={styles.secondaryButton} onPress={requestPermissionsAgain}>
        <Text style={styles.secondaryButtonText}>Revisar permisos</Text>
      </Pressable>
      {permissionsText !== null && <Text style={styles.hint}>{permissionsText}</Text>}

      <Pressable style={styles.secondaryButton} onPress={runAwareProbe} disabled={awareProbe === 'running'}>
        <Text style={styles.secondaryButtonText}>
          {awareProbe === 'running' ? 'Probando Wi‑Fi Aware…' : 'Probar Wi‑Fi Aware'}
        </Text>
      </Pressable>
      <Text style={styles.hint}>
        Con la app abierta en los dos teléfonos, tocá esto en ambos casi al mismo tiempo. Intenta
        una sesión diagnóstica de descubrimiento durante 12 segundos. El transporte normal
        ya se vincula solo; esta prueba sirve únicamente para aislar problemas del hardware.
      </Text>
      {awareProbeText !== null && (
        <View style={styles.capabilityRow}>
          <Text style={styles.capabilityName}>Resultado de la prueba</Text>
          <Text style={styles.capabilityDetail}>{awareProbeText}</Text>
        </View>
      )}

      {hydrationWarnings.length > 0 && (
        <View style={styles.capabilityRow}>
          <Text style={styles.capabilityName}>Avisos del último arranque</Text>
          {hydrationWarnings.map((warning, index) => (
            <Text key={`${warning.stage}:${index}`} style={styles.capabilityDetail}>
              Se descartaron datos guardados en “{warning.stage}”: {warning.message}
            </Text>
          ))}
        </View>
      )}

      <Text style={styles.section}>Diagnóstico</Text>
      <Text style={styles.hint}>
        Consultá capacidades, links, cola persistente y eventos observados. Los
        reportes copiados o compartidos ocultan mensajes, coordenadas, secretos
        e identificadores.
      </Text>
      {onOpenDiagnostics && (
        <Pressable style={styles.secondaryButton} onPress={onOpenDiagnostics}>
          <Text style={styles.secondaryButtonText}>Abrir diagnóstico</Text>
        </Pressable>
      )}

      <Text style={styles.section}>Datos</Text>
      <Pressable style={styles.dangerButton} onPress={confirmClear}>
        <Text style={styles.dangerButtonText}>Borrar historial de mensajes</Text>
      </Pressable>

      <Text style={styles.footer}>
        Anyway no depende de cuentas ni servidores para la malla. El protocolo
        sella de extremo a extremo los mensajes privados y las copias dirigidas
        a miembros de grupos; los nodos de relevo transportan ciphertext. El
        canal global y los avisos SOS globales son públicos para la malla y
        deben tratarse como tales.
      </Text>
      <Text style={styles.versionText}>
        Versión {APP_VERSION} (build {APP_BUILD}) · protocolo v{PROTOCOL_VERSION}
      </Text>
    </ScrollView>
  );
}

function badgeStyleFor(availability: string) {
  switch (availability) {
    case 'supported':
      return styles.capabilityBadgeOk;
    case 'unsupported':
      return styles.capabilityBadgeOff;
    case 'temporarily-unavailable':
      return styles.capabilityBadgeWarn;
    default:
      return styles.capabilityBadgeUnknown;
  }
}

function statusLabel(status: string, connectedLinks: number): string {
  switch (status) {
    case 'running':
      return connectedLinks > 0
        ? `BLE escaneando y anunciando · ${connectedLinks} vecino${connectedLinks === 1 ? '' : 's'} conectado${connectedLinks === 1 ? '' : 's'}`
        : 'BLE escaneando y anunciando · sin links confirmados';
    case 'starting':
      return 'Iniciando…';
    case 'missing-permissions':
      return 'Faltan permisos de Bluetooth';
    case 'bluetooth-off':
      return 'Bluetooth apagado';
    case 'radio-error':
      return 'La radio no pudo iniciar correctamente';
    case 'init-error':
      return 'La app no pudo completar su arranque';
    case 'unsupported':
      return 'No disponible en este dispositivo';
    default:
      return 'Inactivo';
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  content: {
    padding: 20,
  },
  pageEyebrow: { color: palette.amber, fontSize: 10, fontWeight: '900', letterSpacing: 1.6 },
  pageTitle: { color: palette.text, fontSize: 30, lineHeight: 35, fontWeight: '900', letterSpacing: -0.7, marginTop: 4 },
  pageSubtitle: { color: palette.textMuted, fontSize: 13, lineHeight: 19, marginTop: 7 },
  statusHero: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 18,
    padding: 14,
    borderRadius: radius.large,
    backgroundColor: 'rgba(10, 23, 48, 0.94)',
    borderWidth: 1,
    borderColor: palette.border,
    ...shadow,
  },
  statusOrb: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: palette.borderStrong,
    backgroundColor: palette.surfaceRaised,
  },
  statusOrbRunning: { borderColor: 'rgba(61, 220, 151, 0.34)', backgroundColor: palette.greenWash },
  statusCore: { width: 9, height: 9, borderRadius: 5, backgroundColor: palette.textDim },
  statusCoreRunning: { backgroundColor: palette.green },
  statusCopy: { flex: 1, marginHorizontal: 11 },
  statusLabel: { color: palette.textDim, fontSize: 8, fontWeight: '900', letterSpacing: 1.1 },
  statusValue: { color: palette.text, fontSize: 12, lineHeight: 17, fontWeight: '700', marginTop: 3 },
  statusBadge: { color: palette.textDim, fontSize: 8, fontWeight: '900', letterSpacing: 0.8, backgroundColor: palette.surfaceRaised, paddingHorizontal: 7, paddingVertical: 4, borderRadius: radius.pill, overflow: 'hidden' },
  statusBadgeOn: { color: palette.green, backgroundColor: palette.greenWash },
  section: {
    color: palette.cyan,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: 24,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: palette.borderStrong,
    borderRadius: radius.medium,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: palette.text,
    backgroundColor: palette.surface,
  },
  hint: {
    color: palette.textMuted,
    fontSize: 12,
    marginTop: 6,
    lineHeight: 17,
  },
  capabilityRow: {
    backgroundColor: palette.surface,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: palette.border,
    padding: 12,
    marginTop: 10,
  },
  capabilityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  capabilityName: {
    color: palette.text,
    fontSize: 14,
    fontWeight: '700',
    flexShrink: 1,
  },
  capabilityBadge: {
    fontSize: 11,
    fontWeight: '700',
    overflow: 'hidden',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 8,
  },
  capabilityBadgeOk: {
    color: '#bbf7d0',
    backgroundColor: '#14532d',
  },
  capabilityBadgeOff: {
    color: '#fecaca',
    backgroundColor: '#7f1d1d',
  },
  capabilityBadgeWarn: {
    color: '#fde68a',
    backgroundColor: '#78350f',
  },
  capabilityBadgeUnknown: {
    color: '#cbd5e1',
    backgroundColor: '#1f2937',
  },
  capabilityDetail: {
    color: palette.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 6,
  },
  hintOk: {
    color: palette.green,
  },
  colorRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 10,
  },
  colorSwatch: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  colorSwatchSelected: {
    borderColor: palette.white,
  },
  colorSwatchCheck: {
    color: palette.black,
    fontWeight: '700',
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  stepperButton: {
    width: 40,
    height: 40,
    borderRadius: radius.small,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperButtonText: {
    color: palette.text,
    fontSize: 20,
  },
  stepperValue: {
    color: palette.text,
    fontSize: 18,
    fontWeight: '600',
    width: 48,
    textAlign: 'center',
  },
  secondaryButton: {
    marginTop: 10,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    backgroundColor: palette.cyanWash,
    paddingVertical: 10,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: palette.cyanSoft,
    fontWeight: '700',
  },
  dangerButton: {
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: '#dc2626',
    paddingVertical: 10,
    alignItems: 'center',
  },
  dangerButtonText: {
    color: '#FF8F96',
    fontWeight: '600',
  },
  footer: {
    color: palette.textDim,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 32,
    marginBottom: 12,
  },
  versionText: {
    color: palette.textDim,
    fontSize: 11,
    textAlign: 'center',
    marginBottom: 24,
  },
});
