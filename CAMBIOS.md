# Anyway — cambios 1.0.0

Anyway nace como un proyecto paralelo a BLEChat v5/v8/v9, con package,
almacenamiento, identidad criptográfica, icono y UUID BLE propios.

## Base incorporada

- Modelo desacoplado `Node / Transport / Link / Route`.
- Protocolo v1 versionado y firmado.
- Cadena Ed25519 acumulativa por salto, con identidad completa en el primer hop
  de contenido e identidad compacta en hops posteriores.
- Store-and-forward persistente, acotado y con expiración absoluta.
- Cifrado extremo a extremo para directos y copias cifradas por miembro para
  grupos de hasta ocho integrantes, con ACK final durable por cada copia.
- Historial, conversaciones y contactos cifrados localmente con migración
  unidireccional desde los registros plaintext heredados.
- Router dinámico y rutas alternativas/multipath para prioridad SOS.
- Gestor BLE multi-peer con serialización de `connectGatt`, presupuesto de links,
  timeout, backoff con jitter y limpieza de reassembly.
- Framing BLE de 16 bits, 512 fragmentos y envelope baseline de 7.168 bytes.
- Watchdog tokenizado para cada write GATT cliente: un callback perdido invalida
  ese enlace antes de reintentar, sin liberar una operación posterior por error.
- Notificaciones GATT servidor en round-robin por peer, con fallback de dirección
  y MTU independiente para write cliente y notify servidor.
- Capability discovery para BLE, Wi-Fi Aware y Wi-Fi Direct.
- Pantallas de emergencia, coordenadas offline y diagnóstico exportable.
- Flujo separado y explícito para ubicación en segundo plano en Android 10–11.
- Servicio foreground para sostener la búsqueda y los links del runtime BLE
  nativo de proceso; no promete un motor de mensajería JS headless duradero.

## Decisiones deliberadas

- BLE es el transporte automático compatible con Galaxy S8+ de fábrica.
- Wi-Fi Aware/Direct se reportan pero quedan desactivados como transporte
  automático hasta completar pruebas físicas en los modelos reales.
- No se presenta RSSI como distancia exacta ni se inventan métricas ausentes.
- Ninguna compilación o análisis estático se considera validación funcional.

## Referencias históricas

- BLEChat v8 sigue siendo la referencia física conocida.
- BLEChat v9 aportó defensas de lifecycle/GATT, pero no se considera estable sin
  prueba física.
- BLEChat permanece intacto como respaldo.
