// SPDX-License-Identifier: Apache-2.0
export interface Availability {
  capacity: number;
  remaining: number;
  revision: number;
}

export interface Reservation {
  requestId: string;
  seats: number;
  remaining: number;
  revision: number;
  replayed: boolean;
}

export interface InventoryStore {
  read(): Promise<Availability>;
  reserve(requestId: string, seats: number): Promise<Reservation>;
}

export class ReservationConflict extends Error {
  constructor(message: string) { super(message); this.name = 'ReservationConflict'; }
}
