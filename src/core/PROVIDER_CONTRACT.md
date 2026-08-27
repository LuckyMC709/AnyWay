# Contrato del proveedor de red

Este contrato es obligatorio en cada frontera de red. El store no posee claves
privadas y nunca inventa certificados ni considera que aceptar bytes en una
cola local equivale a custodia remota.

## Origen

1. Construir `relay` con `hopCount: 0`, `path: [originId]` y
   `attestations: []`. `hopLimit` queda fijado por la firma inmutable.
2. Firmar con `signEnvelope` y persistir antes de intentar transmitir.
3. Para varias copias cifradas de un grupo, usar `storeEnvelopesAtomically` y
   hacer visible el mensaje recién cuando el resultado sea `committed`.

## Envío de un candidato

`getForwardCandidates` entrega la copia durable previa al salto y un lease. El
proveedor debe llamar
`advanceEnvelopeForRelay(candidate.envelope, localNodeId, peerId, identity)`
inmediatamente antes de `send`. La copia avanzada es sólo de wire; no reemplaza
la custodia durable. Si no se envía, se libera el lease. Los resultados de un
lote pueden confirmarse con `recordForwardAttemptsAtomically` para un solo
commit.

## Recepción

1. Decodificar/validar el envelope.
2. Aplicar continuidad local de identidad y llamar `verifyRelayChain`. La
   función verifica la firma inmutable de origen, certificados autocontenidos,
   cada firma de salto, el digest anterior, el path resultante y el hop limit.
3. Comprobar que el penúltimo nodo del path coincide con el peer autenticado del
   transporte.
4. Persistir con `{ receivedFrom, relayChainVerified: true }` antes de entregar,
   responder o retransmitir. Nunca avanzar en el receptor un envelope hop-0: el
   emisor debe haber creado el primer salto firmado.

## Deduplicación y recibos

`immutableEnvelopeFingerprint(envelope)` identifica el contenido lógico y la
firma de origen, independientemente de su ruta. Reutilizar el mismo
`messageId/originId` con otro fingerprint debe tratarse como colisión, no como
duplicado.

Todo receipt incluye `receiptForFingerprint` con el fingerprint exacto del
mensaje referido. Un `FinalDeliveryAck` incluye el mismo valor. El provider
debe verificar firma/cadena/destino del receipt antes de pasar
`verified: true`; la sintaxis por sí sola no confirma entrega. Capability usa
como máximo 10 minutos de vida y receipt 2 horas.
