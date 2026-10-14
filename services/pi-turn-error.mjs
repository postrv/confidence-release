// A provider failure is represented by Pi as an empty assistant turn. Preserve
// its bounded status/code while keeping provider messages out of child logs.
const platformCodes = new Set([
  'INFRASTRUCTURE_UNAVAILABLE', 'MODEL_PROVIDER_UNAVAILABLE', 'MODEL_RESERVATION_DENIED',
  'MODEL_ROUTE_UNCONFIGURED', 'MODEL_POLICY_DENIED', 'MODEL_RESPONSE_INVALID',
  'MODEL_MESSAGES_DENIED', 'MODEL_TEXT_ONLY', 'MODEL_TOKEN_FIELDS_AMBIGUOUS',
  'MODEL_RESPONSE_IDENTITY_MISMATCH', 'MODEL_USAGE_INVALID', 'BROKER_FENCED',
  'BROKER_GENERATION_FENCED', 'OBJECT_STORE_DEADLINE_EXCEEDED',
]);

export function assistantTurnFailure(message) {
  if (message?.role !== 'assistant' || message.stopReason !== 'error') return null;
  const raw = typeof message.errorMessage === 'string' ? message.errorMessage : '';
  const match = /^\s*([45][0-9]{2}):\s*(\{.*\})\s*$/s.exec(raw);
  let code = null;
  if (match) {
    try {
      const body = JSON.parse(match[2]);
      // Production Workers use { error: { code, message } }; some compatible
      // endpoints return { code }. Keep only a finite known code from either.
      const candidate = body?.error && typeof body.error === 'object' && !Array.isArray(body.error) ? body.error.code : body?.code;
      if (typeof candidate === 'string' && platformCodes.has(candidate)) code = candidate;
    } catch { /* Keep only the status when the provider body is malformed. */ }
  }
  return ['MODEL_TURN_FAILED', match?.[1], code].filter(Boolean).join('_');
}
