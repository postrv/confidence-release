// SPDX-License-Identifier: Apache-2.0
import { PlatformError, requireValue } from '../shared/errors';

// Version-one Rust verifier profile. These limits must be checked before a
// publication consumes approval; increasing them requires verifier conformance.
export const PORTABLE_BUNDLE_BYTES = 8 * 1024 * 1024;
export const PORTABLE_HISTORY_LIMIT = 128;
export const PORTABLE_ENDORSEMENT_LIMIT = 128;
export const PORTABLE_ENDORSEMENT_BYTES = 1024 * 1024;
export const PORTABLE_ISSUED_ENVELOPE_BYTES = 64 * 1024;
export const portableBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/** Reserve both not-yet-issued envelopes and the complete endorsement budget. */
export function assertPortableAdmission(baseBytes: number, predecessors: number): void {
  requireValue(Number.isSafeInteger(predecessors) && predecessors >= 0 && predecessors <= PORTABLE_HISTORY_LIMIT, 'PORTABLE_HISTORY_CAPACITY', 409);
  requireValue(Number.isSafeInteger(baseBytes) && baseBytes >= 0 && baseBytes + 2 * PORTABLE_ISSUED_ENVELOPE_BYTES + PORTABLE_ENDORSEMENT_BYTES <= PORTABLE_BUNDLE_BYTES, 'PORTABLE_BUNDLE_CAPACITY', 413);
}
export function assertPortableEndorsements(envelopes: unknown[]): void {
  requireValue(envelopes.length <= PORTABLE_ENDORSEMENT_LIMIT && portableBytes(envelopes) <= PORTABLE_ENDORSEMENT_BYTES, 'PORTABLE_ENDORSEMENT_CAPACITY', 413);
}
export function assertPortableIssued(envelope: unknown): void {
  if (portableBytes(envelope) > PORTABLE_ISSUED_ENVELOPE_BYTES) throw new PlatformError('PORTABLE_ISSUED_ENVELOPE_LIMIT', 413);
}
