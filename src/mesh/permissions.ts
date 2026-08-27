import { PermissionsAndroid, Platform, type Permission } from 'react-native';
import * as Location from 'expo-location';

export type BackgroundDiscoveryPermission =
  | 'not-required'
  | 'granted'
  | 'not-granted'
  | 'blocked';

/** Requests the Android runtime permissions BLE scanning/advertising needs.
 *  Android 12+ (API 31+) uses the dedicated Bluetooth runtime permissions;
 *  older versions require fine location because scan results could
 *  otherwise be used to infer physical location. */
export async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;

  if (Platform.Version >= 31) {
    const granted = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(granted).every(
      (status) => status === PermissionsAndroid.RESULTS.GRANTED
    );
  }

  const granted = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
  );
  return granted === PermissionsAndroid.RESULTS.GRANTED;
}

/** Wi-Fi Aware is optional and must never gate the independent BLE mesh. */
export async function requestWifiAwarePermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Platform.Version < 26) return false;
  const permission =
    Platform.Version >= 33
      ? NEARBY_WIFI_DEVICES
      : PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
  try {
    if (await PermissionsAndroid.check(permission)) return true;
    return (
      (await PermissionsAndroid.request(permission)) ===
      PermissionsAndroid.RESULTS.GRANTED
    );
  } catch {
    return false;
  }
}

export type PermissionKey = 'bluetooth' | 'location' | 'notifications' | 'nearbyWifi';
export type PermissionOutcome = 'granted' | 'denied' | 'blocked' | 'not-required';
export type StartupPermissions = Record<PermissionKey, PermissionOutcome>;

const NEARBY_WIFI_DEVICES = 'android.permission.NEARBY_WIFI_DEVICES' as Permission;

/**
 * Everything Anyway needs that Android can grant in a single prompt.
 *
 * Background location is deliberately absent: Android rejects it outright when
 * it is bundled with a foreground request, so it has to be asked for separately
 * and only after the foreground grant exists. It stays in Settings.
 */
function startupPermissionPlan(): { key: PermissionKey; permission: Permission }[] {
  if (Platform.OS !== 'android') return [];
  const plan: { key: PermissionKey; permission: Permission }[] = [];

  if (Platform.Version >= 31) {
    plan.push(
      { key: 'bluetooth', permission: PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN },
      { key: 'bluetooth', permission: PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE },
      { key: 'bluetooth', permission: PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT },
    );
  }

  // Needed on every version: the emergency screen attaches GNSS coordinates.
  // Below API 31 it is also what makes BLE scanning legal, and below API 33 it
  // is what Wi-Fi Aware discovery requires.
  plan.push({
    key: 'location',
    permission: PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  });

  if (Platform.Version >= 33) {
    plan.push(
      { key: 'notifications', permission: PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS },
      // Wi-Fi Aware discovery is silently impossible without this, which is why
      // the capability probe could report "supported" and still find nothing.
      { key: 'nearbyWifi', permission: NEARBY_WIFI_DEVICES },
    );
  }

  return plan;
}

function emptyOutcomes(): StartupPermissions {
  return {
    bluetooth: 'not-required',
    location: 'not-required',
    notifications: 'not-required',
    nearbyWifi: 'not-required',
  };
}

/** Reads current grants without prompting, so startup can skip an unnecessary dialog. */
export async function getStartupPermissions(): Promise<StartupPermissions> {
  const outcomes = emptyOutcomes();
  if (Platform.OS !== 'android') return outcomes;
  for (const { key, permission } of startupPermissionPlan()) {
    if (outcomes[key] === 'denied') continue;
    try {
      const granted = await PermissionsAndroid.check(permission);
      outcomes[key] = granted ? 'granted' : 'denied';
    } catch {
      outcomes[key] = 'denied';
    }
  }
  return outcomes;
}

/** Asks for every grantable permission in one system prompt sequence. */
export async function requestStartupPermissions(): Promise<StartupPermissions> {
  const outcomes = emptyOutcomes();
  const plan = startupPermissionPlan();
  if (Platform.OS !== 'android' || plan.length === 0) return outcomes;

  let results: Record<string, string> = {};
  try {
    results = await PermissionsAndroid.requestMultiple(plan.map((item) => item.permission));
  } catch {
    // Fall through: every entry stays unresolved and is reported as denied.
  }

  for (const { key, permission } of plan) {
    const status = results[permission];
    const outcome: PermissionOutcome =
      status === PermissionsAndroid.RESULTS.GRANTED
        ? 'granted'
        : status === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
          ? 'blocked'
          : 'denied';
    // A key backed by several permissions is only granted if all of them are.
    if (outcomes[key] === 'granted' || outcomes[key] === 'not-required') {
      outcomes[key] = outcome;
    } else if (outcome === 'blocked') {
      outcomes[key] = 'blocked';
    }
  }
  return outcomes;
}

/**
 * Whether the mesh itself depends on location.
 *
 * Only up to Android 11: there, BLE scan results could reveal position, so
 * Android gated scanning behind location. From Android 12 the dedicated
 * BLUETOOTH_SCAN permission (declared neverForLocation) covers it, and location
 * only powers SOS coordinates — refusing it must not block the app.
 */
export function locationGatesRadios(): boolean {
  return Platform.OS === 'android' && Platform.Version < 31;
}

/** True when the radios can actually run; the rest only reduce what the app offers. */
export function hasEssentialPermissions(outcomes: StartupPermissions): boolean {
  const granted = (value: PermissionOutcome) =>
    value === 'granted' || value === 'not-required';
  if (Platform.OS !== 'android') return false;
  // Independence means permission for either usable radio is enough to enter
  // the app. Hardware probing then decides whether that path actually exists.
  if (Platform.Version >= 33) {
    return granted(outcomes.bluetooth) || granted(outcomes.nearbyWifi);
  }
  if (Platform.Version >= 31) {
    return granted(outcomes.bluetooth) || granted(outcomes.location);
  }
  return granted(outcomes.location);
}

/** Android 13+ (API 33+) requires this for the foreground-service
 * notification to appear in the notification drawer. The service must still
 * post a notification, and may still launch without this grant; Android then
 * exposes it through Task Manager instead. Requested best-effort. */
export async function requestNotificationPermission(): Promise<void> {
  if (Platform.OS !== 'android' || Platform.Version < 33) return;
  try {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  } catch {
    // best-effort
  }
}

/**
 * Android 10–11 require background location for BLE scan results while the app
 * is not visible. Older Android versions use the foreground location grant;
 * Android 12+ uses Nearby/Bluetooth permissions instead. This is deliberately
 * separate from startup because Android expects an explanatory, user-triggered
 * flow for the background grant.
 */
export async function getBackgroundDiscoveryPermission(): Promise<BackgroundDiscoveryPermission> {
  if (Platform.OS !== 'android' || Platform.Version < 29 || Platform.Version > 30) {
    return 'not-required';
  }
  const response = await Location.getBackgroundPermissionsAsync();
  if (response.granted) return 'granted';
  return response.canAskAgain ? 'not-granted' : 'blocked';
}

export async function requestBackgroundDiscoveryPermission(): Promise<BackgroundDiscoveryPermission> {
  if (Platform.OS !== 'android' || Platform.Version < 29 || Platform.Version > 30) {
    return 'not-required';
  }
  const foreground = await Location.getForegroundPermissionsAsync();
  if (!foreground.granted) return 'not-granted';
  const response = await Location.requestBackgroundPermissionsAsync();
  if (response.granted) return 'granted';
  return response.canAskAgain ? 'not-granted' : 'blocked';
}
