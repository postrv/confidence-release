// SPDX-License-Identifier: Apache-2.0
import { invalidateAvailability } from './cache.js';
import type { InventoryStore, Reservation } from './domain.js';

export async function reserveSeats(store: InventoryStore, requestId: string, seats: number): Promise<Reservation> {
  const reservation = await store.reserve(requestId, seats);
  invalidateAvailability();
  return reservation;
}
