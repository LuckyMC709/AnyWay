import * as Location from 'expo-location';

/** Estado de permiso simplificado para no filtrar tipos del SDK a la UI. */
export type ForegroundLocationPermissionStatus =
  | 'granted'
  | 'denied'
  | 'undetermined';

export type LocationAccuracyAuthorization =
  | { platform: 'android'; value: 'fine' | 'coarse' | 'none' }
  | { platform: 'ios'; value: 'full' | 'reduced' }
  | null;

export interface ForegroundLocationPermission {
  status: ForegroundLocationPermissionStatus;
  granted: boolean;
  canAskAgain: boolean;
  expires: 'never' | number;
  accuracyAuthorization: LocationAccuracyAuthorization;
  checkedAt: number;
}

/**
 * Medición de ubicación obtenida directamente del proveedor del sistema.
 *
 * `measuredAt` es el timestamp informado por el sistema operativo;
 * `requestedAt` y `receivedAt` permiten auditar cuánto tardó la adquisición.
 * Los campos que el dispositivo no informe permanecen en `null`: nunca se
 * reemplazan con valores estimados.
 */
export interface EmergencyLocationFix {
  latitude: number;
  longitude: number;
  horizontalAccuracyMeters: number | null;
  altitudeMeters: number | null;
  altitudeAccuracyMeters: number | null;
  headingDegrees: number | null;
  speedMetersPerSecond: number | null;
  measuredAt: number;
  requestedAt: number;
  receivedAt: number;
  mocked: boolean | null;
}

export type LocationCaptureFailureCode =
  | 'permission-check-failed'
  | 'permission-required'
  | 'permission-denied'
  | 'services-disabled'
  | 'location-unavailable'
  | 'invalid-fix';

export type LocationCaptureResult =
  | {
      ok: true;
      permission: ForegroundLocationPermission;
      fix: EmergencyLocationFix;
    }
  | {
      ok: false;
      code: LocationCaptureFailureCode;
      permission?: ForegroundLocationPermission;
      message: string;
      /** Error original para diagnóstico local; no debe mostrarse sin filtrar. */
      cause?: unknown;
    };

export interface CaptureCurrentLocationOptions {
  /**
   * Si es `true` (valor por defecto), solicita permiso cuando todavía puede
   * preguntarse al usuario. Si es `false`, sólo consulta el permiso actual.
   */
  requestPermission?: boolean;
  /** Precisión pedida al proveedor. Por defecto usa `Location.Accuracy.High`. */
  accuracy?: Location.LocationAccuracy;
  /**
   * Controla el diálogo de Android para mejorar la precisión. Es `false` por
   * defecto: Anyway no habilita ni requiere servicios de red para obtener las
   * coordenadas. Puede cambiarse explícitamente al integrar esta función.
   */
  mayShowUserSettingsDialog?: boolean;
  /** Límite de espera de la UI. La consulta nativa no siempre es cancelable. */
  timeoutMs?: number;
}

function accuracyAuthorization(
  response: Location.LocationPermissionResponse,
): LocationAccuracyAuthorization {
  if (response.android) {
    return { platform: 'android', value: response.android.accuracy };
  }
  if (response.ios) {
    return { platform: 'ios', value: response.ios.accuracy };
  }
  return null;
}

function normalizePermission(
  response: Location.LocationPermissionResponse,
  checkedAt = Date.now(),
): ForegroundLocationPermission {
  return {
    status: response.status,
    granted: response.granted,
    canAskAgain: response.canAskAgain,
    expires: response.expires,
    accuracyAuthorization: accuracyAuthorization(response),
    checkedAt,
  };
}

/** Consulta el permiso de ubicación en primer plano sin abrir ningún diálogo. */
export async function getForegroundLocationPermission(): Promise<ForegroundLocationPermission> {
  const response = await Location.getForegroundPermissionsAsync();
  return normalizePermission(response);
}

/** Solicita únicamente el permiso de ubicación en primer plano. */
export async function requestForegroundLocationPermission(): Promise<ForegroundLocationPermission> {
  const response = await Location.requestForegroundPermissionsAsync();
  return normalizePermission(response);
}

/**
 * Obtiene una medición actual sin mapas, geocodificación ni llamadas HTTP.
 * El proveedor concreto (GNSS, red o fusión del sistema) lo decide el sistema
 * operativo; esta función no lo adivina ni lo etiqueta como GPS.
 */
export async function captureCurrentLocation(
  options: CaptureCurrentLocationOptions = {},
): Promise<LocationCaptureResult> {
  const requestedAt = Date.now();
  let rawPermission: Location.LocationPermissionResponse;

  try {
    rawPermission = await Location.getForegroundPermissionsAsync();
  } catch (cause) {
    return {
      ok: false,
      code: 'permission-check-failed',
      message: 'No se pudo consultar el permiso de ubicación.',
      cause,
    };
  }

  if (
    !rawPermission.granted &&
    options.requestPermission !== false &&
    rawPermission.canAskAgain
  ) {
    try {
      rawPermission = await Location.requestForegroundPermissionsAsync();
    } catch (cause) {
      return {
        ok: false,
        code: 'permission-check-failed',
        permission: normalizePermission(rawPermission),
        message: 'No se pudo solicitar el permiso de ubicación.',
        cause,
      };
    }
  }

  const permission = normalizePermission(rawPermission);
  if (!permission.granted) {
    const permissionWasDecided = permission.status === 'denied';
    return {
      ok: false,
      code: permissionWasDecided ? 'permission-denied' : 'permission-required',
      permission,
      message: permissionWasDecided
        ? 'El permiso de ubicación está denegado.'
        : 'Hace falta permiso de ubicación para obtener coordenadas.',
    };
  }

  try {
    const servicesEnabled = await Location.hasServicesEnabledAsync();
    if (!servicesEnabled) {
      return {
        ok: false,
        code: 'services-disabled',
        permission,
        message: 'Los servicios de ubicación del dispositivo están apagados.',
      };
    }
  } catch (cause) {
    return {
      ok: false,
      code: 'location-unavailable',
      permission,
      message: 'No se pudo consultar el estado de los servicios de ubicación.',
      cause,
    };
  }

  try {
    const timeoutMs = Math.max(5_000, Math.min(options.timeoutMs ?? 30_000, 120_000));
    const location = await withTimeout(
      Location.getCurrentPositionAsync({
        accuracy: options.accuracy ?? Location.Accuracy.High,
        mayShowUserSettingsDialog: options.mayShowUserSettingsDialog ?? false,
      }),
      timeoutMs,
    );
    const receivedAt = Date.now();

    if (
      !Number.isFinite(location.coords.latitude) ||
      location.coords.latitude < -90 ||
      location.coords.latitude > 90 ||
      !Number.isFinite(location.coords.longitude) ||
      location.coords.longitude < -180 ||
      location.coords.longitude > 180 ||
      !Number.isFinite(location.timestamp)
    ) {
      return {
        ok: false,
        code: 'invalid-fix',
        permission,
        message: 'El proveedor devolvió una ubicación inválida.',
      };
    }

    return {
      ok: true,
      permission,
      fix: {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        horizontalAccuracyMeters: nonNegativeOrNull(location.coords.accuracy),
        altitudeMeters: finiteOrNull(location.coords.altitude),
        altitudeAccuracyMeters: nonNegativeOrNull(location.coords.altitudeAccuracy),
        // Android/iOS providers may use negative sentinel values when these
        // measurements are unavailable. Keep them unknown instead of letting
        // a syntactically finite but physically invalid value reach the wire.
        headingDegrees: headingOrNull(location.coords.heading),
        speedMetersPerSecond: nonNegativeOrNull(location.coords.speed),
        measuredAt: location.timestamp,
        requestedAt,
        receivedAt,
        mocked: location.mocked ?? null,
      },
    };
  } catch (cause) {
    return {
      ok: false,
      code: 'location-unavailable',
      permission,
      message: 'No se pudo obtener una ubicación actual.',
      cause,
    };
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Location acquisition exceeded ${timeoutMs} ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Coordenadas en texto plano, aptas para copiar o transportar sin mapas. */
export function formatCoordinates(fix: EmergencyLocationFix): string {
  return `${formatCoordinate(fix.latitude)}, ${formatCoordinate(fix.longitude)}`;
}

/**
 * Texto autocontenido para un mensaje de emergencia. No agrega direcciones,
 * nombres de lugares ni información que requiera Internet.
 */
export function formatLocationDetails(fix: EmergencyLocationFix): string {
  const lines = [
    `Latitud: ${formatCoordinate(fix.latitude)}`,
    `Longitud: ${formatCoordinate(fix.longitude)}`,
    `Precisión horizontal: ${
      fix.horizontalAccuracyMeters === null
        ? 'no informada'
        : `±${formatMeters(fix.horizontalAccuracyMeters)} m`
    }`,
    `Obtenida: ${new Date(fix.measuredAt).toISOString()}`,
  ];
  if (fix.altitudeMeters !== null) {
    lines.push(`Altitud: ${formatMeters(fix.altitudeMeters)} m`);
  }
  return lines.join('\n');
}

/** Antigüedad de la medición; un reloj adelantado produce un valor negativo. */
export function getLocationAgeMs(fix: EmergencyLocationFix, now = Date.now()): number {
  return now - fix.measuredAt;
}

function formatCoordinate(value: number): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  return normalized.toFixed(6);
}

function formatMeters(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function finiteOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeOrNull(value: number | null): number | null {
  const finite = finiteOrNull(value);
  return finite !== null && finite >= 0 ? finite : null;
}

function headingOrNull(value: number | null): number | null {
  const finite = finiteOrNull(value);
  return finite !== null && finite >= 0 && finite <= 360 ? finite : null;
}
