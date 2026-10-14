// SPDX-License-Identifier: Apache-2.0
import { readAvailability } from './cache.js';
import { ReservationConflict, type InventoryStore } from './domain.js';
import { renderAvailability } from './presentation.js';
import { reserveSeats } from './reservations.js';
import { parseReservation } from './validation.js';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function createApp(store: InventoryStore): (request: Request) => Promise<Response> {
  return async request => {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return new Response('ready');
    if (path === '/availability' && request.method === 'GET') return json(await readAvailability(store));
    if (path === '/' && request.method === 'GET') return new Response(renderAvailability(await readAvailability(store)), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (path === '/reservations' && request.method === 'POST') {
      let input: { requestId: string; seats: number };
      try { input = parseReservation(await request.json()); }
      catch { return json({ error: 'INVALID_RESERVATION' }, 400); }
      try {
        const reservation = await reserveSeats(store, input.requestId, input.seats);
        return json(reservation, reservation.replayed ? 200 : 201);
      } catch (error) {
        if (error instanceof ReservationConflict) return json({ error: 'RESERVATION_CONFLICT' }, 409);
        throw error;
      }
    }
    return json({ error: 'NOT_FOUND' }, 404);
  };
}
