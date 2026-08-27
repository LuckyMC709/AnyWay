const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

/**
 * Keeps Anyway's generated Android manifest aligned with its offline nearby
 * transports. Every radio remains optional at install time: capability
 * discovery decides what a particular phone can actually use.
 */
const withAnywayPermissions = (config) =>
  withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    manifest['uses-permission'] ??= [];
    manifest['uses-feature'] ??= [];

    const permissions = manifest['uses-permission'];
    // Development manifests copied from earlier Expo builds requested overlay
    // and shared-storage access. Anyway neither draws over other apps nor
    // reads/writes public storage, so keep those capabilities out of every
    // regenerated production manifest.
    const forbiddenPermissions = new Set([
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
    ]);
    manifest['uses-permission'] = permissions.filter(
      (item) => !forbiddenPermissions.has(item.$?.['android:name']),
    );
    // A library manifest may declare these again during Gradle merge. Keep an
    // explicit removal marker in the app manifest so the final APK—not only
    // the prebuild source—stays free of them.
    for (const name of forbiddenPermissions) {
      manifest['uses-permission'].push({
        $: { 'android:name': name, 'tools:node': 'remove' },
      });
    }
    const filteredPermissions = manifest['uses-permission'];
    const addPermission = (name, extraAttrs = {}) => {
      const existing = filteredPermissions.find(
        (item) => item.$?.['android:name'] === name,
      );
      if (existing) {
        existing.$ = { ...existing.$, ...extraAttrs };
        return;
      }
      filteredPermissions.push({ $: { 'android:name': name, ...extraAttrs } });
    };

    // BLE on Android 12+.
    addPermission('android.permission.BLUETOOTH_SCAN', {
      'android:usesPermissionFlags': 'neverForLocation',
    });
    addPermission('android.permission.BLUETOOTH_ADVERTISE');
    addPermission('android.permission.BLUETOOTH_CONNECT');

    // BLE legacy and Wi-Fi peer discovery on Android 7–11.
    addPermission('android.permission.BLUETOOTH', { 'android:maxSdkVersion': '30' });
    addPermission('android.permission.BLUETOOTH_ADMIN', { 'android:maxSdkVersion': '30' });

    // GNSS/SOS uses this on every supported Android version. Wi-Fi peer
    // discovery also needs it through Android 12L.
    addPermission('android.permission.ACCESS_FINE_LOCATION');
    addPermission('android.permission.ACCESS_COARSE_LOCATION');

    // Wi-Fi Aware and Wi-Fi Direct. INTERNET only authorizes local sockets;
    // the transport does not need or contact an Internet service.
    addPermission('android.permission.ACCESS_WIFI_STATE');
    addPermission('android.permission.CHANGE_WIFI_STATE');
    addPermission('android.permission.ACCESS_NETWORK_STATE');
    addPermission('android.permission.CHANGE_NETWORK_STATE');
    addPermission('android.permission.NEARBY_WIFI_DEVICES', {
      'android:usesPermissionFlags': 'neverForLocation',
    });
    addPermission('android.permission.INTERNET');
    // Android 10–11 require a separate grant for sustained discovery while
    // the app is not visible. Anyway requests it only from its explicit
    // emergency/background setup flow.
    addPermission('android.permission.ACCESS_BACKGROUND_LOCATION', {
      'android:maxSdkVersion': '30',
    });

    addPermission('android.permission.FOREGROUND_SERVICE');
    addPermission('android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE');
    addPermission('android.permission.POST_NOTIFICATIONS');
    addPermission('android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS');

    const features = manifest['uses-feature'];
    const addOptionalFeature = (name) => {
      const existing = features.find((item) => item.$?.['android:name'] === name);
      if (existing) {
        existing.$['android:required'] = 'false';
        return;
      }
      features.push({ $: { 'android:name': name, 'android:required': 'false' } });
    };
    addOptionalFeature('android.hardware.bluetooth_le');
    addOptionalFeature('android.hardware.wifi.direct');
    addOptionalFeature('android.hardware.wifi.aware');
    addOptionalFeature('android.hardware.location.gps');

    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    application.$['android:allowBackup'] = 'false';
    application.$['android:fullBackupContent'] = 'false';
    application.$['android:usesCleartextTraffic'] = 'false';
    application.service ??= [];
    const serviceName = 'expo.modules.blemesh.AnywayForegroundService';
    const foregroundService = application.service.find(
      (service) => service.$?.['android:name'] === serviceName,
    );
    if (foregroundService) {
      foregroundService.$ = {
        ...foregroundService.$,
        'android:foregroundServiceType': 'connectedDevice',
        'android:exported': 'false',
      };
    } else {
      application.service.push({
        $: {
          'android:name': serviceName,
          'android:foregroundServiceType': 'connectedDevice',
          'android:exported': 'false',
        },
      });
    }

    return config;
  });

module.exports = withAnywayPermissions;
