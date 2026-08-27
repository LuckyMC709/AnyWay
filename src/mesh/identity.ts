import * as Crypto from 'expo-crypto';

import { getOrCreateIdentity } from '../security';

/** A short, persistent, random id for this install — never a phone number,
 *  account, or hardware identifier. Regenerating the app data resets it. */
export async function getOrCreateNodeId(): Promise<string> {
  return (await getOrCreateIdentity()).nodeId;
}

export function generateMessageId(): string {
  return Crypto.randomUUID();
}
