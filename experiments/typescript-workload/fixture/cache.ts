// SPDX-License-Identifier: Apache-2.0
import type { Availability, InventoryStore } from './domain.js';

// The baseline reads every time. Assignment A enables a bounded cache.
export const availabilityTtlMs = 0;
let cached: { value: Availability; expiresAt: number } | undefined;

export async function readAvailability(store: InventoryStore): Promise<Availability> {
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  const value = await store.read();
  if (availabilityTtlMs > 0) cached = { value, expiresAt: Date.now() + availabilityTtlMs };
  return value;
}

export function invalidateAvailability(): void { cached = undefined; }
