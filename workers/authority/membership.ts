// SPDX-License-Identifier: Apache-2.0
import { requireValue } from '../shared/errors';

export const MEMBERSHIP_ROLES = ['admin', 'export', 'reader', 'reviewer', 'sponsor'] as const;
export type MembershipRole = typeof MEMBERSHIP_ROLES[number];
export interface MembershipState { roles: MembershipRole[]; active: boolean }
export interface MembershipChange extends MembershipState { subject: string }

export function membershipChange(body: Record<string, unknown>): MembershipChange {
  requireValue(Object.keys(body).sort().join(',') === 'active,roles,subject', 'SCHEMA_ERROR');
  requireValue(typeof body.active === 'boolean', 'SCHEMA_ERROR');
  const subject = body.subject;
  requireValue(typeof subject === 'string' && subject.length > 0 && subject.length <= 160
    && subject.trim() === subject && !/[\u0000-\u001f\u007f-\u009f]/.test(subject), 'MEMBERSHIP_SUBJECT_INVALID');
  requireValue(Array.isArray(body.roles) && body.roles.length <= MEMBERSHIP_ROLES.length, 'SCHEMA_ERROR');
  const roles = Array.from(body.roles);
  requireValue(roles.every(role => typeof role === 'string' && MEMBERSHIP_ROLES.includes(role as MembershipRole)), 'UNSUPPORTED_ROLE');
  requireValue(roles.every((role, index) => index === 0 || roles[index - 1]! < role), 'UNSORTED_SCOPE_SET');
  return { subject, active: body.active, roles: roles as MembershipRole[] };
}

export function membershipAllows(member: MembershipState | null, role: MembershipRole): boolean {
  return Boolean(member?.active && (member.roles.includes('admin') || member.roles.includes(role)));
}

export function requireRemainingAdmin(before: MembershipState | null, after: MembershipState, activeAdmins: number): void {
  requireValue(!membershipAllows(before, 'admin') || membershipAllows(after, 'admin') || activeAdmins > 1,
    'LAST_ADMIN_REQUIRED', 409);
}

export function invalidateMembershipApprovals(before: MembershipState | null, after: MembershipState): boolean {
  // A later reactivation must require a new approval, including for legacy rows.
  return !after.active || membershipAllows(before, 'reviewer') !== membershipAllows(after, 'reviewer');
}
