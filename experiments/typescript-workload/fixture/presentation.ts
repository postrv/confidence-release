// SPDX-License-Identifier: Apache-2.0
import type { Availability } from './domain.js';

// Assignment C makes this saved, server-rendered status accessible.
export function renderAvailability(snapshot: Availability): string {
  return `<!doctype html><html lang="en"><head><title>Seat inventory</title></head><body><main><h1>Seat inventory</h1><p>Seats remaining: ${snapshot.remaining}</p></main></body></html>`;
}
