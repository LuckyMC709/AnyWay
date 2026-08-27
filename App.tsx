import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { ModeDock } from './src/components/ModeDock';
import { AmbientBackground, BrandMark } from './src/components/VisualFoundation';
import { buildDeviceReport, copyDeviceReport } from './src/diagnostics/deviceReport';
import type { HydrationFailure } from './src/mesh/AnywayMeshProvider';
import { MeshProvider, useMesh } from './src/mesh/MeshProvider';
import {
  StartupPermissions,
  getStartupPermissions,
  hasEssentialPermissions,
} from './src/mesh/permissions';
import { MeshTarget } from './src/mesh/protocol';
import { PermissionsScreen } from './src/screens/PermissionsScreen';
import { APP_BUILD, APP_VERSION } from './src/version';
import { ChatListScreen } from './src/screens/ChatListScreen';
import { ConversationScreen } from './src/screens/ConversationScreen';
import { DemoScreen } from './src/screens/DemoScreen';
import { DiagnosticsContainer } from './src/screens/DiagnosticsContainer';
import { EmergencyContainer } from './src/screens/EmergencyContainer';
import { MeshGraphScreen } from './src/screens/MeshGraphScreen';
import { NewChatScreen } from './src/screens/NewChatScreen';
import { NewGroupScreen } from './src/screens/NewGroupScreen';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { PeersScreen } from './src/screens/PeersScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { palette, radius, shadow } from './src/ui/theme';

type MainTab = 'chats' | 'peers' | 'emergency' | 'demo' | 'settings';
type SettingsSubScreen = 'main' | 'diagnostics';

type ChatSubScreen =
  | { name: 'list' }
  | { name: 'conversation'; conversationId: string; target: MeshTarget; title: string }
  | { name: 'newChat' }
  | { name: 'newGroup' }
  | { name: 'meshGraph' };

export default function App() {
  return (
    <SafeAreaProvider>
      <MeshProvider>
        <Root />
      </MeshProvider>
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}

function Root() {
  const {
    hydrated,
    hydrationFailure,
    nickname,
    status,
    meshEnabled,
    nearbyDevices,
    requestStart,
  } = useMesh();
  const [tab, setTab] = useState<MainTab>('chats');
  const [chatSub, setChatSub] = useState<ChatSubScreen>({ name: 'list' });
  const [settingsSub, setSettingsSub] = useState<SettingsSubScreen>('main');
  const [startupDiagnostics, setStartupDiagnostics] = useState(false);
  const [permissionGate, setPermissionGate] = useState<'checking' | 'needed' | 'done'>(
    'checking',
  );
  const [startupPermissions, setStartupPermissions] = useState<StartupPermissions | null>(null);

  useEffect(() => {
    let active = true;
    void getStartupPermissions()
      .then((outcomes) => {
        if (!active) return;
        setStartupPermissions(outcomes);
        setPermissionGate(hasEssentialPermissions(outcomes) ? 'done' : 'needed');
      })
      .catch(() => {
        if (active) setPermissionGate('done');
      });
    return () => {
      active = false;
    };
  }, []);

  if (!hydrated) {
    if (hydrationFailure) {
      // Diagnostics must stay reachable here: before this screen existed the
      // real error went only to an in-memory buffer behind the tab bar, which
      // never renders on a startup failure — leaving no way to see the cause.
      if (startupDiagnostics) {
        return (
          <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <DiagnosticsContainer onBack={() => setStartupDiagnostics(false)} />
          </SafeAreaView>
        );
      }
      return (
        <StartupErrorScreen
          failure={hydrationFailure}
          onOpenDiagnostics={() => setStartupDiagnostics(true)}
        />
      );
    }
    return (
      <View style={styles.loading}>
        <AmbientBackground />
        <BrandMark size={76} />
        <Text style={styles.loadingTitle}>Preparando Anyway…</Text>
        <Text style={styles.loadingDetail}>
          Cargando identidad segura y mensajes pendientes.
        </Text>
      </View>
    );
  }

  if (!nickname) {
    return <OnboardingScreen />;
  }

  // Asked once, up front, so the radios are never blocked mid-use by a dialog.
  // Skipped entirely when the essential grants already exist, and dismissable so
  // a permanent denial can't trap someone on this screen every launch.
  if (permissionGate === 'checking') {
    return (
      <View style={styles.loading}>
        <AmbientBackground />
        <Text style={styles.loadingTitle}>Revisando permisos…</Text>
      </View>
    );
  }
  if (permissionGate === 'needed' && startupPermissions) {
    return (
      <PermissionsScreen
        initial={startupPermissions}
        onDone={() => setPermissionGate('done')}
      />
    );
  }

  const connectedCount = nearbyDevices.filter((d) => d.connected).length;
  // Conversation/newChat/newGroup have their own back button and a text
  // input near the bottom — hiding the tab bar there gives the keyboard
  // more room and matches how most chat apps treat a pushed screen.
  const showTabBar = !(tab === 'chats' && chatSub.name !== 'list');

  const openConversation = (conversationId: string, target: MeshTarget, title: string) => {
    setChatSub({ name: 'conversation', conversationId, target, title });
  };

  const renderChatsTab = () => {
    switch (chatSub.name) {
      case 'list':
        return (
          <ChatListScreen
            onOpenConversation={openConversation}
            onNewChat={() => setChatSub({ name: 'newChat' })}
            onNewGroup={() => setChatSub({ name: 'newGroup' })}
          />
        );
      case 'conversation':
        return (
          <ConversationScreen
            conversationId={chatSub.conversationId}
            target={chatSub.target}
            title={chatSub.title}
            onBack={() => setChatSub({ name: 'list' })}
            onOpenMeshGraph={() => setChatSub({ name: 'meshGraph' })}
          />
        );
      case 'meshGraph':
        return <MeshGraphScreen onBack={() => setChatSub({ name: 'list' })} />;
      case 'newChat':
        return (
          <NewChatScreen
            onBack={() => setChatSub({ name: 'list' })}
            onPick={(conversationId, peerNodeId, peerNickname) =>
              openConversation(conversationId, { kind: 'direct', nodeId: peerNodeId }, peerNickname)
            }
          />
        );
      case 'newGroup':
        return (
          <NewGroupScreen
            onBack={() => setChatSub({ name: 'list' })}
            onCreated={(conversationId, groupName) => {
              const groupId = conversationId.replace(/^group:/, '');
              openConversation(conversationId, { kind: 'group', groupId }, groupName);
            }}
          />
        );
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <AmbientBackground />
      {status !== 'running' && (
        <StatusBanner status={status} meshEnabled={meshEnabled} onRetry={requestStart} />
      )}
      <View style={styles.body}>
        {tab === 'chats' && renderChatsTab()}
        {tab === 'peers' && <PeersScreen />}
        {tab === 'emergency' && <EmergencyContainer />}
        {tab === 'demo' && <DemoScreen />}
        {tab === 'settings' &&
          (settingsSub === 'diagnostics' ? (
            <DiagnosticsContainer onBack={() => setSettingsSub('main')} />
          ) : (
            <SettingsScreen onOpenDiagnostics={() => setSettingsSub('diagnostics')} />
          ))}
      </View>
      {showTabBar && (
        <ModeDock
          active={tab}
          onSelect={(next) => {
            if (next === 'settings') setSettingsSub('main');
            setTab(next);
          }}
          modes={[
            { key: 'chats', label: 'Chats' },
            { key: 'peers', label: 'Cerca', badge: connectedCount },
            { key: 'emergency', label: 'Emergencia', tone: 'sos' },
            { key: 'demo', label: 'Demo' },
            { key: 'settings', label: 'Ajustes' },
          ]}
        />
      )}
    </SafeAreaView>
  );
}

const STAGE_LABELS: Record<HydrationFailure['stage'], string> = {
  identity: 'Identidad segura (SecureStore)',
  preferences: 'Preferencias guardadas',
  'legacy-purge': 'Limpieza de datos anteriores',
  'store-open': 'Base de datos de mensajes (SQLite)',
  reconcile: 'Reconciliación de mensajes pendientes',
};

const STAGE_HINTS: Record<HydrationFailure['stage'], string> = {
  identity:
    'Falló crear o leer la clave criptográfica del dispositivo. Suele deberse al almacén seguro de Android.',
  preferences: 'Falló leer los datos guardados de la app.',
  'legacy-purge': 'Falló limpiar datos de una versión anterior.',
  'store-open':
    'Falló abrir la base de datos local de mensajes. Desinstalar y reinstalar la app suele resolverlo.',
  reconcile: 'Falló procesar los mensajes y recibos que habían quedado pendientes.',
};

function StartupErrorScreen({
  failure,
  onOpenDiagnostics,
}: {
  failure: HydrationFailure;
  onOpenDiagnostics: () => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      const report = buildDeviceReport({
        app: {
          name: 'Anyway',
          version: APP_VERSION,
          build: APP_BUILD,
          startupFailed: true,
          failedStage: failure.stage,
          errorMessage: failure.message,
        },
        device: {
          platform: Platform.OS,
          platformVersion: Platform.Version,
          manufacturer: platformConstant('Manufacturer'),
          model: platformConstant('Model'),
        },
        extra: {
          reportScope: 'fallo de arranque; la app no llegó a inicializarse',
        },
      });
      await copyDeviceReport(report, { format: 'json', pretty: true });
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <SafeAreaView style={styles.errorScreen} edges={['top', 'bottom']}>
      <AmbientBackground />
      <ScrollView contentContainerStyle={styles.errorContent}>
        <Text style={styles.errorTitle}>No se pudo iniciar Anyway</Text>
        <Text style={styles.errorSubtitle}>
          La aplicación falló durante el arranque. Reiniciar no lo soluciona: el detalle de abajo
          indica en qué paso se cortó.
        </Text>

        <View style={styles.errorCard}>
          <Text style={styles.errorCardLabel}>Paso que falló</Text>
          <Text style={styles.errorCardValue}>{STAGE_LABELS[failure.stage]}</Text>
          <Text style={styles.errorCardHint}>{STAGE_HINTS[failure.stage]}</Text>
        </View>

        <View style={styles.errorCard}>
          <Text style={styles.errorCardLabel}>Error exacto</Text>
          <Text style={styles.errorCardMono}>{failure.message}</Text>
        </View>

        <Pressable style={styles.errorButton} onPress={copy}>
          <Text style={styles.errorButtonText}>
            {copyState === 'copied'
              ? 'Diagnóstico copiado ✓'
              : copyState === 'failed'
                ? 'No se pudo copiar — anotá el error de arriba'
                : 'Copiar diagnóstico'}
          </Text>
        </Pressable>

        <Pressable style={styles.errorButtonSecondary} onPress={onOpenDiagnostics}>
          <Text style={styles.errorButtonSecondaryText}>Ver diagnóstico completo</Text>
        </Pressable>

        <Text style={styles.errorFooter}>
          Versión {APP_VERSION} (build {APP_BUILD})
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function platformConstant(key: string): unknown {
  return (Platform.constants as unknown as Record<string, unknown>)[key];
}

function StatusBanner({
  status,
  meshEnabled,
  onRetry,
}: {
  status: string;
  meshEnabled: boolean;
  onRetry: () => void;
}) {
  const message =
    !meshEnabled
      ? 'Malla pausada. Tocá para reanudar.'
      : status === 'starting'
      ? 'Iniciando Bluetooth…'
      : status === 'missing-permissions'
      ? 'Faltan permisos de Bluetooth. Tocá para reintentar.'
      : status === 'bluetooth-off'
      ? 'Encendé el Bluetooth para conectarte a la mesh.'
      : status === 'unsupported'
      ? 'Este dispositivo no soporta esta función.'
      : 'Bluetooth inactivo. Tocá para reintentar.';

  return (
    <Pressable
      onPress={onRetry}
      style={({ pressed }) => [styles.banner, pressed && styles.bannerPressed]}
      accessibilityRole="button"
      accessibilityLabel={message}
    >
      <View style={styles.bannerStatusDot} />
      <Text style={styles.bannerText}>{message}</Text>
      <Text style={styles.bannerAction}>{status === 'starting' ? '•••' : 'Revisar'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: palette.background,
  },
  body: {
    flex: 1,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: palette.background,
  },
  loadingTitle: {
    color: palette.text,
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
    marginTop: 18,
  },
  loadingDetail: {
    color: palette.textMuted,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 10,
    textAlign: 'center',
  },
  errorScreen: {
    flex: 1,
    backgroundColor: palette.background,
  },
  errorContent: {
    padding: 24,
    paddingTop: 32,
  },
  errorTitle: {
    color: palette.text,
    fontSize: 27,
    fontWeight: '800',
  },
  errorSubtitle: {
    color: palette.textMuted,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 10,
  },
  errorCard: {
    backgroundColor: palette.surface,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: palette.border,
    padding: 14,
    marginTop: 18,
  },
  errorCardLabel: {
    color: palette.textDim,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  errorCardValue: {
    color: palette.text,
    fontSize: 16,
    fontWeight: '600',
    marginTop: 6,
  },
  errorCardHint: {
    color: palette.textMuted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
  },
  errorCardMono: {
    color: '#fca5a5',
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Menlo',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
  },
  errorButton: {
    backgroundColor: palette.cyan,
    borderRadius: radius.medium,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 22,
  },
  errorButtonText: {
    color: palette.black,
    fontSize: 15,
    fontWeight: '700',
  },
  errorButtonSecondary: {
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 10,
  },
  errorButtonSecondaryText: {
    color: palette.cyanSoft,
    fontSize: 15,
    fontWeight: '600',
  },
  errorFooter: {
    color: palette.textDim,
    fontSize: 12,
    marginTop: 22,
    textAlign: 'center',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 10,
    marginTop: 8,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: 'rgba(255, 179, 26, 0.32)',
    backgroundColor: '#211A0D',
    paddingVertical: 10,
    paddingHorizontal: 12,
    ...shadow,
  },
  bannerPressed: { opacity: 0.72 },
  bannerStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: palette.amber,
    marginRight: 9,
  },
  bannerText: {
    flex: 1,
    color: palette.amberSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  bannerAction: { color: palette.amber, fontSize: 11, fontWeight: '800', marginLeft: 8 },
});
