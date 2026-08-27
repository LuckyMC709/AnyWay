import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { formatCoordinates, getLocationAgeMs } from '../emergency/location';
import type { EmergencyLocationFix } from '../emergency/location';
import { palette, radius, shadow } from '../ui/theme';

export type EmergencyPriority = 'important' | 'sos';

export type EmergencyLocationViewState =
  | { status: 'not-requested' }
  | { status: 'requesting-permission' }
  | { status: 'permission-denied'; canAskAgain: boolean }
  | { status: 'services-disabled' }
  | { status: 'locating' }
  | { status: 'ready'; fix: EmergencyLocationFix }
  | { status: 'error'; message?: string };

/**
 * Estado de transporte controlado por la integración. Se diferencia la
 * aceptación de un relevo de la entrega final para no mostrar confirmaciones
 * engañosas en una red store-and-forward.
 */
export type EmergencyTransmissionState =
  | { status: 'idle' }
  | { status: 'submitting'; priority: EmergencyPriority }
  | { status: 'queued'; priority: EmergencyPriority; at?: number }
  | { status: 'accepted-by-relay'; priority: EmergencyPriority; at?: number }
  | { status: 'delivered'; priority: EmergencyPriority; at?: number }
  | { status: 'failed'; priority?: EmergencyPriority; message?: string };

export interface EmergencySendRequest {
  priority: EmergencyPriority;
  /** Texto ya recortado; queda ausente para un SOS sin descripción. */
  text?: string;
  /** Medición exacta mostrada al confirmar el envío, o ausente. */
  location?: EmergencyLocationFix;
}

/**
 * API controlada de `EmergencyScreen`.
 *
 * - `message`/`onMessageChange`: borrador administrado por el contenedor.
 * - `location`: estado real de permiso/adquisición o una medición lista.
 * - `transmission`: estado real del store/router/transporte.
 * - `onRequestLocation`: inicia permiso y captura; la pantalla no usa hooks mesh.
 * - `onSend`: recibe prioridad, texto y exactamente la medición visible.
 * - `onCopyCoordinates`: copia el texto indicado y permite informar errores.
 * - `onOpenLocationSettings`: opcional para bloqueos que requieren Ajustes.
 * - `staleAfterMs`: umbral opcional decidido por el integrador; si se omite,
 *   se informa la antigüedad sin clasificar la medición como vieja.
 */
export interface EmergencyScreenProps {
  message: string;
  onMessageChange: (message: string) => void;
  location: EmergencyLocationViewState;
  transmission: EmergencyTransmissionState;
  onRequestLocation: () => void | Promise<void>;
  onSend: (request: EmergencySendRequest) => void | Promise<void>;
  onCopyCoordinates: (
    coordinates: string,
    fix: EmergencyLocationFix,
  ) => void | Promise<void>;
  onOpenLocationSettings?: () => void | Promise<void>;
  maxMessageLength?: number;
  staleAfterMs?: number;
  disabled?: boolean;
  disabledReason?: string;
  /** Timestamp inyectable para mantener estable una captura o preview. */
  now?: number;
}

type LocalActionState =
  | { kind: 'idle' }
  | { kind: 'sending'; priority: EmergencyPriority }
  | { kind: 'copying' }
  | { kind: 'copied' }
  | { kind: 'error'; message: string };

export function EmergencyScreen({
  message,
  onMessageChange,
  location,
  transmission,
  onRequestLocation,
  onSend,
  onCopyCoordinates,
  onOpenLocationSettings,
  maxMessageLength,
  staleAfterMs,
  disabled = false,
  disabledReason,
  now: suppliedNow,
}: EmergencyScreenProps) {
  const now = useCurrentTime(suppliedNow);
  const [action, setAction] = useState<LocalActionState>({ kind: 'idle' });
  const fix = location.status === 'ready' ? location.fix : undefined;
  const trimmedMessage = message.trim();
  const transmissionBusy = transmission.status === 'submitting';
  const actionBusy = action.kind === 'sending' || action.kind === 'copying';
  const sendDisabled = disabled || transmissionBusy || actionBusy;
  const importantDisabled = sendDisabled || (!fix && trimmedMessage.length === 0);

  useEffect(() => {
    if (action.kind === 'copied') {
      const timeout = setTimeout(() => setAction({ kind: 'idle' }), 2_500);
      return () => clearTimeout(timeout);
    }
    return undefined;
  }, [action.kind]);

  const submit = async (priority: EmergencyPriority) => {
    if (sendDisabled || (priority === 'important' && importantDisabled)) return;
    setAction({ kind: 'sending', priority });
    try {
      await onSend({
        priority,
        text: trimmedMessage.length > 0 ? trimmedMessage : undefined,
        location: fix,
      });
      setAction({ kind: 'idle' });
    } catch {
      setAction({
        kind: 'error',
        message: 'No se pudo iniciar el envío. Revisá el diagnóstico e intentá otra vez.',
      });
    }
  };

  const copyCoordinates = async () => {
    if (!fix || actionBusy) return;
    setAction({ kind: 'copying' });
    try {
      await onCopyCoordinates(formatCoordinates(fix), fix);
      setAction({ kind: 'copied' });
    } catch {
      setAction({ kind: 'error', message: 'No se pudieron copiar las coordenadas.' });
    }
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.eyebrow}>Emergencia</Text>
      <Text style={styles.title}>Pedí ayuda por la malla</Text>
      <Text style={styles.intro}>
        El mensaje se entrega por los enlaces disponibles o queda guardado para
        retransmitirse cuando aparezca un camino. No necesita mapas ni Internet.
      </Text>
      <View style={styles.publicWarning} accessibilityRole="alert">
        <Text style={styles.publicWarningTitle}>SOS global y público</Text>
        <Text style={styles.publicWarningText}>
          Cualquier nodo de la malla puede leer el texto y las coordenadas
          adjuntas. No incluyas secretos que no sean necesarios para pedir ayuda.
        </Text>
      </View>

      <LocationCard
        state={location}
        now={now}
        staleAfterMs={staleAfterMs}
        action={action}
        onRequestLocation={onRequestLocation}
        onCopyCoordinates={copyCoordinates}
        onOpenLocationSettings={onOpenLocationSettings}
        disabled={disabled || actionBusy}
      />

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Mensaje</Text>
        <Text style={styles.sectionHelp}>
          Describí qué necesitás, cuántas personas hay o qué riesgo observás.
          Un SOS también puede enviarse sin texto.
        </Text>
        <TextInput
          accessibilityLabel="Descripción de la emergencia"
          style={styles.input}
          value={message}
          onChangeText={onMessageChange}
          placeholder="Ej.: dos personas heridas, acceso por calle norte"
          placeholderTextColor="#7f8b9d"
          multiline
          maxLength={maxMessageLength}
          editable={!disabled && !transmissionBusy}
          textAlignVertical="top"
        />
        {maxMessageLength !== undefined && (
          <Text style={styles.counter}>
            {message.length} / {maxMessageLength}
          </Text>
        )}
      </View>

      {!fix && (
        <View style={styles.warningBox} accessibilityRole="alert">
          <Text style={styles.warningTitle}>El envío no tiene ubicación</Text>
          <Text style={styles.warningText}>
            Podés enviar el SOS igualmente. La app no inventará coordenadas ni usará
            una posición que no esté visible en esta pantalla.
          </Text>
        </View>
      )}

      <TransmissionBanner state={transmission} />

      {disabledReason && disabled && (
        <Text style={styles.disabledReason} accessibilityRole="alert">
          {disabledReason}
        </Text>
      )}
      {action.kind === 'error' && (
        <Text style={styles.actionError} accessibilityRole="alert">
          {action.message}
        </Text>
      )}

      <View style={styles.actionStack}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Enviar mensaje importante"
          accessibilityHint="Prioriza el mensaje por encima de un mensaje normal"
          accessibilityState={{ disabled: importantDisabled, busy: action.kind === 'sending' }}
          disabled={importantDisabled}
          onPress={() => submit('important')}
          style={({ pressed }) => [
            styles.button,
            styles.importantButton,
            pressed && styles.buttonPressed,
            importantDisabled && styles.buttonDisabled,
          ]}
        >
          {action.kind === 'sending' && action.priority === 'important' ? (
            <ActivityIndicator color="#071018" />
          ) : (
            <Text style={styles.importantButtonText}>Enviar como importante</Text>
          )}
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Enviar SOS"
          accessibilityHint="Envía el mensaje con la máxima prioridad disponible"
          accessibilityState={{ disabled: sendDisabled, busy: action.kind === 'sending' }}
          disabled={sendDisabled}
          onPress={() => submit('sos')}
          style={({ pressed }) => [
            styles.button,
            styles.sosButton,
            pressed && styles.buttonPressed,
            sendDisabled && styles.buttonDisabled,
          ]}
        >
          {action.kind === 'sending' && action.priority === 'sos' ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.sosButtonText}>Enviar SOS</Text>
          )}
        </Pressable>
      </View>

      <Text style={styles.footer}>
        “Aceptado por un relevo” confirma sólo el próximo salto. La pantalla marca
        “entregado” únicamente cuando la integración informa una confirmación del
        destino.
      </Text>
    </ScrollView>
  );
}

function LocationCard({
  state,
  now,
  staleAfterMs,
  action,
  onRequestLocation,
  onCopyCoordinates,
  onOpenLocationSettings,
  disabled,
}: {
  state: EmergencyLocationViewState;
  now: number;
  staleAfterMs?: number;
  action: LocalActionState;
  onRequestLocation: () => void | Promise<void>;
  onCopyCoordinates: () => void | Promise<void>;
  onOpenLocationSettings?: () => void | Promise<void>;
  disabled: boolean;
}) {
  const locationBusy =
    state.status === 'requesting-permission' || state.status === 'locating';

  if (state.status === 'ready') {
    const ageMs = getLocationAgeMs(state.fix, now);
    const stale =
      staleAfterMs !== undefined && staleAfterMs >= 0 && ageMs >= staleAfterMs;
    return (
      <View style={styles.locationCard}>
        <View style={styles.cardHeadingRow}>
          <View style={styles.cardHeadingText}>
            <Text style={styles.sectionTitle}>Ubicación para adjuntar</Text>
            <Text
              style={[styles.readyLabel, stale && styles.staleLabel]}
              accessibilityLiveRegion="polite"
            >
              {stale ? 'Medición anterior' : 'Medición disponible'}
            </Text>
          </View>
          <View style={styles.readyDot} />
        </View>
        <Text style={styles.coordinate} selectable accessibilityLabel="Coordenadas">
          {formatCoordinates(state.fix)}
        </Text>
        <Text style={styles.locationMeta}>
          {formatAccuracy(state.fix.horizontalAccuracyMeters)}
        </Text>
        <Text style={styles.locationMeta}>
          Obtenida {formatAge(ageMs)} · {formatDateTime(state.fix.measuredAt)}
        </Text>
        {state.fix.mocked === true && (
          <Text style={styles.mockedWarning} accessibilityRole="alert">
            El sistema marcó esta medición como ubicación simulada.
          </Text>
        )}
        <View style={styles.inlineActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Actualizar ubicación"
            disabled={disabled}
            onPress={onRequestLocation}
            style={({ pressed }) => [
              styles.smallButton,
              pressed && styles.buttonPressed,
              disabled && styles.buttonDisabled,
            ]}
          >
            <Text style={styles.smallButtonText}>Actualizar</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copiar coordenadas"
            accessibilityState={{ busy: action.kind === 'copying' }}
            disabled={disabled}
            onPress={onCopyCoordinates}
            style={({ pressed }) => [
              styles.smallButton,
              pressed && styles.buttonPressed,
              disabled && styles.buttonDisabled,
            ]}
          >
            <Text style={styles.smallButtonText}>
              {action.kind === 'copying'
                ? 'Copiando…'
                : action.kind === 'copied'
                  ? 'Copiadas'
                  : 'Copiar coordenadas'}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const copy = locationStateCopy(state);
  const settingsUseful =
    onOpenLocationSettings !== undefined &&
    ((state.status === 'permission-denied' && !state.canAskAgain) ||
      state.status === 'services-disabled');
  return (
    <View style={styles.locationCard} accessibilityLiveRegion="polite">
      <Text style={styles.sectionTitle}>Ubicación para adjuntar</Text>
      <View style={styles.locationStatusRow}>
        {locationBusy && <ActivityIndicator color="#63d6ff" size="small" />}
        <Text style={styles.locationStatus}>{copy.title}</Text>
      </View>
      <Text style={styles.sectionHelp}>{copy.detail}</Text>
      <View style={styles.inlineActions}>
        {!locationBusy && (
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            onPress={onRequestLocation}
            style={({ pressed }) => [
              styles.smallButton,
              pressed && styles.buttonPressed,
              disabled && styles.buttonDisabled,
            ]}
          >
            <Text style={styles.smallButtonText}>{copy.action}</Text>
          </Pressable>
        )}
        {settingsUseful && (
          <Pressable
            accessibilityRole="button"
            onPress={onOpenLocationSettings}
            style={({ pressed }) => [styles.smallButton, pressed && styles.buttonPressed]}
          >
            <Text style={styles.smallButtonText}>Abrir Ajustes</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function TransmissionBanner({ state }: { state: EmergencyTransmissionState }) {
  if (state.status === 'idle') return null;
  const copy = transmissionStateCopy(state);
  const toneStyle =
    state.status === 'failed'
      ? styles.transmissionFailed
      : state.status === 'delivered'
        ? styles.transmissionDelivered
        : styles.transmissionPending;
  return (
    <View
      style={[styles.transmissionBanner, toneStyle]}
      accessibilityRole={state.status === 'failed' ? 'alert' : undefined}
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.transmissionTitle}>{copy.title}</Text>
      <Text style={styles.transmissionText}>{copy.detail}</Text>
    </View>
  );
}

function locationStateCopy(
  state: Exclude<EmergencyLocationViewState, { status: 'ready' }>,
): { title: string; detail: string; action: string } {
  switch (state.status) {
    case 'not-requested':
      return {
        title: 'Todavía no hay una medición',
        detail: 'Obtené coordenadas actuales del dispositivo antes de enviar.',
        action: 'Obtener ubicación',
      };
    case 'requesting-permission':
      return {
        title: 'Esperando permiso…',
        detail: 'Respondé al pedido del sistema para continuar.',
        action: 'Esperando…',
      };
    case 'permission-denied':
      return {
        title: 'Permiso de ubicación denegado',
        detail: state.canAskAgain
          ? 'Podés volver a solicitar el permiso.'
          : 'El permiso debe habilitarse desde los Ajustes del dispositivo.',
        action: state.canAskAgain ? 'Solicitar permiso' : 'Comprobar de nuevo',
      };
    case 'services-disabled':
      return {
        title: 'Ubicación del dispositivo apagada',
        detail: 'Encendela en Ajustes y volvé a intentar.',
        action: 'Comprobar de nuevo',
      };
    case 'locating':
      return {
        title: 'Buscando una medición actual…',
        detail: 'En interiores o con poca vista del cielo puede tardar.',
        action: 'Buscando…',
      };
    case 'error':
      return {
        title: 'No se pudo obtener la ubicación',
        detail: state.message ?? 'Volvé a intentarlo en un lugar con mejor recepción.',
        action: 'Reintentar',
      };
  }
}

function transmissionStateCopy(
  state: Exclude<EmergencyTransmissionState, { status: 'idle' }>,
): { title: string; detail: string } {
  const priority = state.priority === 'sos' ? 'SOS' : 'mensaje importante';
  switch (state.status) {
    case 'submitting':
      return {
        title: `Preparando ${priority}…`,
        detail: 'Todavía no hay confirmación de almacenamiento ni entrega.',
      };
    case 'queued':
      return {
        title: `${capitalize(priority)} guardado en este dispositivo`,
        detail: 'Quedó en cola y se intentará retransmitir cuando haya un camino.',
      };
    case 'accepted-by-relay':
      return {
        title: `${capitalize(priority)} aceptado por un relevo`,
        detail: 'El próximo nodo lo recibió; esto todavía no confirma la entrega final.',
      };
    case 'delivered':
      return {
        title: `${capitalize(priority)} entregado`,
        detail: 'La integración informó una confirmación del destino.',
      };
    case 'failed':
      return {
        title: 'No se pudo preparar el envío',
        detail: state.message ?? 'Revisá el diagnóstico e intentá nuevamente.',
      };
  }
}

function useCurrentTime(suppliedNow: number | undefined): number {
  const [liveNow, setLiveNow] = useState(() => Date.now());
  useEffect(() => {
    if (suppliedNow !== undefined) return undefined;
    const interval = setInterval(() => setLiveNow(Date.now()), 15_000);
    return () => clearInterval(interval);
  }, [suppliedNow]);
  return suppliedNow ?? liveNow;
}

function formatAccuracy(meters: number | null): string {
  if (meters === null) return 'Precisión horizontal no informada por el dispositivo';
  const value = Number.isInteger(meters) ? String(meters) : meters.toFixed(1);
  return `Precisión horizontal: ±${value} m`;
}

function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return 'con antigüedad no disponible';
  if (ageMs < -5_000) return 'con una hora informada en el futuro';
  const seconds = Math.max(0, Math.floor(ageMs / 1_000));
  if (seconds < 5) return 'recién';
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} día${days === 1 ? '' : 's'}`;
}

function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'hora no disponible';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  eyebrow: {
    color: palette.red,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  title: {
    color: palette.text,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
    marginTop: 6,
  },
  intro: {
    color: palette.textMuted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
    marginBottom: 20,
  },
  publicWarning: {
    borderWidth: 1,
    borderColor: '#7f1d1d',
    backgroundColor: '#2a1015',
    borderRadius: radius.medium,
    padding: 12,
    marginBottom: 18,
  },
  publicWarningTitle: {
    color: '#fecaca',
    fontSize: 12,
    fontWeight: '800',
  },
  publicWarningText: {
    color: '#fca5a5',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 3,
  },
  section: {
    marginTop: 20,
  },
  locationCard: {
    backgroundColor: palette.surface,
    borderColor: palette.border,
    borderWidth: 1,
    borderRadius: radius.large,
    padding: 16,
    ...shadow,
  },
  cardHeadingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  cardHeadingText: {
    flex: 1,
  },
  sectionTitle: {
    color: palette.text,
    fontSize: 17,
    fontWeight: '700',
  },
  sectionHelp: {
    color: palette.textMuted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
  },
  readyLabel: {
    color: palette.green,
    fontSize: 13,
    fontWeight: '700',
    marginTop: 4,
  },
  staleLabel: {
    color: '#ffd166',
  },
  readyDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: palette.green,
    marginLeft: 12,
    marginTop: 5,
  },
  coordinate: {
    color: palette.text,
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    marginTop: 16,
  },
  locationMeta: {
    color: palette.textMuted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 5,
  },
  mockedWarning: {
    color: '#ffd166',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '700',
    marginTop: 10,
  },
  locationStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginTop: 12,
  },
  locationStatus: {
    color: '#e8eef6',
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  inlineActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 16,
  },
  smallButton: {
    minHeight: 44,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: palette.borderStrong,
    borderRadius: radius.medium,
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: palette.cyanWash,
  },
  smallButtonText: {
    color: palette.cyanSoft,
    fontSize: 14,
    fontWeight: '700',
  },
  input: {
    minHeight: 112,
    marginTop: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#f8fafc',
    fontSize: 16,
    lineHeight: 22,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    borderRadius: radius.medium,
    backgroundColor: palette.surface,
  },
  counter: {
    color: '#98a6b8',
    fontSize: 12,
    textAlign: 'right',
    marginTop: 5,
  },
  warningBox: {
    backgroundColor: '#2a210d',
    borderColor: '#755c19',
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginTop: 18,
  },
  warningTitle: {
    color: '#ffe08a',
    fontSize: 14,
    fontWeight: '800',
  },
  warningText: {
    color: '#ead9a9',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  transmissionBanner: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginTop: 18,
  },
  transmissionPending: {
    backgroundColor: '#102433',
    borderColor: '#356986',
  },
  transmissionDelivered: {
    backgroundColor: '#10271d',
    borderColor: '#2c714d',
  },
  transmissionFailed: {
    backgroundColor: '#331519',
    borderColor: '#8f3740',
  },
  transmissionTitle: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '800',
  },
  transmissionText: {
    color: '#c4cfdb',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  disabledReason: {
    color: '#ffd166',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 16,
  },
  actionError: {
    color: '#ff9ca5',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 16,
  },
  actionStack: {
    gap: 12,
    marginTop: 20,
  },
  button: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingHorizontal: 18,
  },
  importantButton: {
    backgroundColor: palette.cyan,
  },
  importantButtonText: {
    color: palette.black,
    fontSize: 16,
    fontWeight: '800',
  },
  sosButton: {
    minHeight: 58,
    backgroundColor: palette.redStrong,
    borderWidth: 2,
    borderColor: '#FF8F96',
  },
  sosButtonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  buttonPressed: {
    opacity: 0.78,
  },
  buttonDisabled: {
    opacity: 0.42,
  },
  footer: {
    color: '#8f9daf',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 22,
  },
});
