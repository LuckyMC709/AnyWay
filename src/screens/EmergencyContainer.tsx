import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useMemo, useState } from 'react';
import { Linking, Platform } from 'react-native';

import type { GeoLocation, MessageDeliveryState } from '../core';
import {
  captureCurrentLocation,
  getForegroundLocationPermission,
} from '../emergency/location';
import type { EmergencyLocationFix } from '../emergency/location';
import { useMesh } from '../mesh/MeshProvider';
import {
  EmergencyScreen,
  type EmergencyLocationViewState,
  type EmergencyPriority,
  type EmergencySendRequest,
  type EmergencyTransmissionState,
} from './EmergencyScreen';

const MAX_EMERGENCY_MESSAGE_LENGTH = 2_048;
const LOCATION_STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * Connects the controlled emergency UI to the real location and mesh APIs.
 * The screen never upgrades a persisted message to delivered by itself: it
 * follows the message state exposed by the provider.
 */
export function EmergencyContainer() {
  const mesh = useMesh();
  const [message, setMessage] = useState('');
  const [location, setLocation] = useState<EmergencyLocationViewState>({
    status: 'not-requested',
  });
  const [transmission, setTransmission] = useState<EmergencyTransmissionState>({
    status: 'idle',
  });
  const [sentMarker, setSentMarker] = useState<{
    at: number;
    priority: EmergencyPriority;
  } | null>(null);

  const publicMessages = mesh.getMessages('broadcast');
  const observedEmergency = useMemo(() => {
    if (!sentMarker || !mesh.nodeId) return undefined;
    return [...publicMessages]
      .reverse()
      .find(
        (item) =>
          item.senderId === mesh.nodeId &&
          item.priority === sentMarker.priority &&
          item.createdAt >= sentMarker.at - 1_000,
      );
  }, [mesh.nodeId, publicMessages, sentMarker]);

  useEffect(() => {
    if (!sentMarker || !observedEmergency) return;
    setTransmission(
      transmissionFromMessageState(observedEmergency.state, sentMarker.priority),
    );
  }, [observedEmergency?.state, sentMarker]);

  const requestLocation = async () => {
    try {
      const permission = await getForegroundLocationPermission();
      setLocation(
        permission.granted
          ? { status: 'locating' }
          : { status: 'requesting-permission' },
      );
    } catch {
      setLocation({ status: 'requesting-permission' });
    }

    const result = await captureCurrentLocation({
      requestPermission: true,
      mayShowUserSettingsDialog: false,
    });
    if (result.ok) {
      setLocation({ status: 'ready', fix: result.fix });
      return;
    }

    switch (result.code) {
      case 'permission-required':
      case 'permission-denied':
        setLocation({
          status: 'permission-denied',
          canAskAgain: result.permission?.canAskAgain ?? false,
        });
        return;
      case 'services-disabled':
        setLocation({ status: 'services-disabled' });
        return;
      default:
        setLocation({ status: 'error', message: result.message });
    }
  };

  const send = async (request: EmergencySendRequest) => {
    const at = Date.now();
    setTransmission({ status: 'submitting', priority: request.priority });
    try {
      await mesh.sendEmergency({
        target: { kind: 'broadcast' },
        priority: request.priority,
        text: request.text,
        location: request.location ? toGeoLocation(request.location) : undefined,
      });
      setSentMarker({ at, priority: request.priority });
      setTransmission({ status: 'queued', priority: request.priority, at: Date.now() });
      setMessage('');
    } catch (error) {
      setTransmission({
        status: 'failed',
        priority: request.priority,
        message: safeErrorMessage(error),
      });
      throw error;
    }
  };

  const openLocationSettings = async () => {
    if (Platform.OS === 'android' && location.status === 'services-disabled') {
      try {
        await Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS');
        return;
      } catch {
        // Some Android variants do not expose this intent; app settings is a
        // safe fallback where Juan can at least review the permission.
      }
    }
    await Linking.openSettings();
  };

  return (
    <EmergencyScreen
      message={message}
      onMessageChange={setMessage}
      location={location}
      transmission={transmission}
      onRequestLocation={requestLocation}
      onSend={send}
      onCopyCoordinates={async (coordinates) => {
        await Clipboard.setStringAsync(coordinates);
      }}
      onOpenLocationSettings={openLocationSettings}
      maxMessageLength={MAX_EMERGENCY_MESSAGE_LENGTH}
      staleAfterMs={LOCATION_STALE_AFTER_MS}
    />
  );
}

function toGeoLocation(fix: EmergencyLocationFix): GeoLocation {
  return {
    latitude: fix.latitude,
    longitude: fix.longitude,
    accuracyMeters: fix.horizontalAccuracyMeters ?? undefined,
    acquiredAt: fix.measuredAt,
    altitudeMeters: fix.altitudeMeters ?? undefined,
    altitudeAccuracyMeters: fix.altitudeAccuracyMeters ?? undefined,
    headingDegrees: fix.headingDegrees ?? undefined,
    speedMetersPerSecond: fix.speedMetersPerSecond ?? undefined,
    provider: 'unknown',
  };
}

function transmissionFromMessageState(
  state: MessageDeliveryState,
  priority: EmergencyPriority,
): EmergencyTransmissionState {
  switch (state) {
    case 'created':
      return { status: 'submitting', priority };
    case 'stored':
    case 'pending':
      return { status: 'queued', priority };
    case 'forwarded':
      return { status: 'accepted-by-relay', priority };
    case 'received':
      return { status: 'queued', priority };
    case 'delivered':
      return { status: 'delivered', priority };
    case 'expired':
      return {
        status: 'failed',
        priority,
        message: 'El mensaje venció sin una confirmación final.',
      };
    case 'failed':
      return {
        status: 'failed',
        priority,
        message: 'El almacenamiento o el reenvío informó un error.',
      };
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.slice(0, 180);
  }
  return 'No se pudo guardar el mensaje para su reenvío.';
}
