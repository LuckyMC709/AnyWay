# Anyway

Anyway es una aplicación Android de comunicación oportunista para emergencias.
No depende de cuentas, servidores, Internet, datos móviles ni un router: crea
mensajes dirigidos a una identidad lógica y trata de acercarlos a su destino
mediante los links disponibles, nodos intermedios y almacenamiento persistente.

> Estado: implementación y compilación no equivalen a validación funcional.
> BLE, segundo plano, full mesh, alcance, Wi-Fi y store-and-forward entre
> teléfonos reales deben ser comprobados físicamente por Juan.

## Proyecto independiente

- Nombre visible: `Anyway`
- Package/applicationId: `com.juanpelliza.anyway`
- Protocolo: Anyway Core v1
- Android mínimo: API 24 (Android 7)
- Almacenamiento y UUID BLE propios

El proyecto fuente `Fake Ble chat`/BLEChat no se modifica. Las dos aplicaciones
pueden instalarse en el mismo teléfono y sus anuncios BLE no deben mezclarse.

## Arquitectura

```text
UI de chats / Emergencia / Demo / Diagnóstico
                    │
        Motor de mensajería Anyway
          ┌─────────┴─────────┐
     Mesh Router       Persistent Store
          └─────────┬─────────┘
              Link Manager
          ┌─────────┼──────────────┐
         BLE    Wi-Fi Aware    Wi-Fi Direct
       activo    capability      capability
```

El dominio separa `Node`, `Transport`, `Link` y `Route`. Una dirección BLE,
IP o `PeerHandle` es un endpoint temporal; la identidad estable es un
`AnywayNodeId` derivado de la clave pública Ed25519 del nodo.

### Mensajería y DTN

- Envelopes versionados, firmados, con `messageId`, origen, destino, prioridad,
  expiración absoluta, hop limit y path sin loops. Cada relay agrega una firma
  acumulativa; los hops posteriores usan una identidad compacta para no repetir
  certificados completos sin perder verificabilidad.
- Repositorio SQLite acotado a 512 entradas, 5 MiB y 96 entradas por origen.
- Retención máxima: normal 24 h, importante 3 días, SOS 7 días; nunca se renueva
  al pasar por otro custodio.
- Persist-before-send: el envelope y su lease de salida se confirman en disco
  antes de entregarlos al transporte.
- Un relay guarda y reenvía mensajes privados como ciphertext opaco.
- “Encolado”, “aceptado por un relevo” y “entregado al destino” son estados
  distintos. Sólo un receipt final firmado puede marcar entrega.
- SOS admite una política de cola más agresiva y selección multipath cuando
  existan links/rutas realmente observados.

### Seguridad

- Firma Ed25519 e identidad persistente en Android Keystore mediante
  `expo-secure-store`.
- Cifrado extremo a extremo `NaCl box` para mensajes directos.
- Los grupos se transportan como copias individuales cifradas para cada miembro;
  esta versión admite hasta ocho miembros y conserva los IDs de cada copia para
  no anunciar entrega hasta recibir todas las confirmaciones finales.
- El historial visible, las conversaciones y los contactos se cifran con
  `NaCl secretbox`; la clave queda en SecureStore. Los broadcasts son públicos
  por diseño.
- El backup de Android está deshabilitado y los diagnósticos se exportan
  redactados/pseudonimizados por defecto.

Esto protege confidencialidad e integridad frente a relays honestos pero
curiosos. No implementa certificación humana de identidades, recuperación de
claves, revocación distribuida ni protección absoluta de un teléfono
comprometido.

## Transportes

BLE es el transporte automático base para API 24+: advertising, scanning,
servidor/cliente GATT, fragmentación según MTU confirmado, colas seriales y un
gestor de candidatos con presupuesto de links, timeout y backoff con jitter.
Para una malla pequeña se intenta conservar conectividad directa; el hardware
OEM sigue imponiendo el límite real.

El framing usa índices de 16 bits y hasta 512 fragmentos; el presupuesto baseline
de un envelope es 7.168 bytes aun con el MTU mínimo. El tamaño real disponible
para texto es menor porque incluye cifrado, firmas y la cadena de relays.

El servicio foreground mantiene la búsqueda y los enlaces BLE en el runtime
nativo del proceso mientras Android permita conservarlo. No ejecuta en modo
headless duradero el router, el cifrado ni el store-and-forward de JavaScript.
La cola nativa de eventos es acotada y volátil: una muerte completa del proceso,
un force-stop, un reinicio o apagar Bluetooth pueden interrumpir la entrega y
exigir volver a abrir/reanudar Anyway. La notificación sólo informa que se están
buscando enlaces cercanos.

Android 10–11 requieren un permiso de ubicación en segundo plano separado para
recibir descubrimientos BLE cuando Anyway no está visible. La app lo solicita
únicamente desde la acción explícita de Ajustes; no lo mezcla con el arranque
normal de la malla.

Wi-Fi Aware y Wi-Fi Direct tienen detección dinámica de capacidad y modelos de
transporte preparados, pero no se seleccionan automáticamente en esta entrega.
Aware requiere API 26 y soporte de hardware. Wi-Fi Direct forma un grupo con un
Group Owner: no es una malla nativa transparente. Activarlos sin pruebas OEM
reales daría una promesa de confiabilidad que todavía no existe.

## Ubicación y diagnóstico

La pantalla Emergencia puede capturar una medición del proveedor de ubicación
del sistema y adjuntar latitud, longitud, precisión informada y las horas de
medición/envío/recepción. Las coordenadas se muestran y copian sin mapas.

Diagnóstico distingue datos medidos, estimados y desconocidos; muestra
capacidades, candidatos/links, eventos de conexión, store y routing. Se puede
copiar JSON o NDJSON redactado para analizar una prueba física fallida.

## Compilación Android

Esta app usa un módulo Expo nativo y no funciona dentro de Expo Go. Requiere un
development build o APK nativo.

```bash
npm install
npx tsc --noEmit
cd android
./gradlew assembleRelease
```

No se deben interpretar esos comandos como prueba de radios ni de malla. El APK
release de desarrollo usa la firma local configurada en Gradle; antes de una
distribución pública se debe crear y custodiar una clave de publicación propia.
