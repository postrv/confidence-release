// SPDX-License-Identifier: Apache-2.0
/** Bounded strict JSON for archives larger than the signed protocol's 8 MiB ceiling. */
export function parseProjectJson(text: string): unknown {
  let at = 0, nodes = 0;
  const fail = (): never => { throw new Error('INVALID_PROJECT_JSON'); };
  const space = () => { while (at < text.length && /[\x20\t\r\n]/.test(text[at]!)) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const character = text[at++]!;
      if (character === '"') { try { return JSON.parse(text.slice(start, at)) as string; } catch { fail(); } }
      if (character === '\\') at++;
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (++nodes > 150000 || depth > 64) fail();
    space(); const character = text[at];
    if (character === '"') return string();
    if (character === '{') {
      at++; space(); const result: Record<string, unknown> = {}; const keys = new Set<string>();
      if (text[at] === '}') { at++; return result; }
      for (;;) {
        space(); if (text[at] !== '"') fail(); const key = string();
        if (keys.has(key)) fail(); keys.add(key); space(); if (text[at++] !== ':') fail();
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true }); space(); const end = text[at++];
        if (end === '}') return result; if (end !== ',') fail();
      }
    }
    if (character === '[') {
      at++; space(); const result: unknown[] = []; if (text[at] === ']') { at++; return result; }
      for (;;) { result.push(value(depth + 1)); space(); const end = text[at++]; if (end === ']') return result; if (end !== ',') fail(); }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const)
      if (text.startsWith(literal, at)) { at += literal.length; return result; }
    const start = at;
    while (at < text.length && /[0-9eE+.\-]/.test(text[at]!)) at++;
    const token = text.slice(start, at);
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(token)) fail();
    const number = Number(token); if (!Number.isFinite(number) || !Number.isSafeInteger(number)) fail(); return number;
  };
  const result = value(0); space(); if (at !== text.length) fail(); return result;
}

export function canonicalProjectJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalProjectJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalProjectJson((value as Record<string, unknown>)[key])).join(',') + '}';
  throw new Error('INVALID_PROJECT_JSON');
}
