// SPDX-License-Identifier: Apache-2.0
// Fixed local experiment checker. Candidate code runs only in this disposable
// child process; this is not a hostile-code security boundary.
import { pathToFileURL } from 'node:url';

const checks = [];
const record = (name, passed, observed) => checks.push({ name, outcome: passed ? 'PASS' : 'FAIL', observed });

// Parse a small static HTML subset as data. No browser, script evaluation or
// candidate-supplied selector is involved in this accessibility assertion.
function staticStatus(html) {
  const missing = { hasMain: false, hasLabelledStatus: false, containsLatestValue: false };
  if (Buffer.byteLength(html) > 16 * 1024) return missing;
  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root], voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  let nodes = 0, position = 0;
  const attrsOf = source => {
    const attrs = {};
    let at = 0;
    while (at < source.length) {
      while (/\s/.test(source[at] || '')) at++;
      if (at === source.length) break;
      const name = /^[a-z_:][a-z0-9_:.-]*/i.exec(source.slice(at));
      if (!name) return null;
      at += name[0].length;
      while (/\s/.test(source[at] || '')) at++;
      let value = '';
      if (source[at] === '=') {
        at++;
        while (/\s/.test(source[at] || '')) at++;
        const quote = source[at] === '"' || source[at] === "'" ? source[at++] : '';
        const start = at;
        if (quote) { while (at < source.length && source[at] !== quote) at++; if (at === source.length) return null; value = source.slice(start, at++); }
        else { while (at < source.length && !/[\s>]/.test(source[at])) at++; if (at === start) return null; value = source.slice(start, at); }
      }
      const key = name[0].toLowerCase();
      if (Object.hasOwn(attrs, key)) return null;
      attrs[key] = value;
    }
    return attrs;
  };
  while (position < html.length) {
    if (html.startsWith('<!--', position)) { const end = html.indexOf('-->', position + 4); if (end < 0) return missing; position = end + 3; continue; }
    if (html[position] !== '<') { const next = html.indexOf('<', position); const end = next < 0 ? html.length : next; stack.at(-1).text += html.slice(position, end); position = end; continue; }
    let end = position + 1, quote = '';
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === html.length) return missing;
    const raw = html.slice(position + 1, end).trim(); position = end + 1;
    if (/^!doctype\s+html$/i.test(raw)) continue;
    const closing = /^\/\s*([a-z][a-z0-9-]*)\s*$/i.exec(raw);
    if (closing) { if (stack.length === 1 || stack.at(-1).tag !== closing[1].toLowerCase()) return missing; stack.pop(); continue; }
    const opening = /^([a-z][a-z0-9-]*)([\s\S]*)$/i.exec(raw);
    if (!opening || ++nodes > 256 || stack.length > 32) return missing;
    const tag = opening[1].toLowerCase(), selfClosing = /\/\s*$/.test(opening[2]);
    const attrs = attrsOf(selfClosing ? opening[2].replace(/\/\s*$/, '') : opening[2]);
    if (!attrs) return missing;
    const node = { tag, attrs, children: [], text: '' };
    stack.at(-1).children.push(node);
    if (!selfClosing && !voidTags.has(tag)) stack.push(node);
    if (tag === 'script' || tag === 'style') {
      const close = html.toLowerCase().indexOf(`</${tag}`, position);
      if (close < 0) return missing;
      position = close;
    }
  }
  if (stack.length !== 1) return missing;
  const decode = value => value.replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, entity => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity.toLowerCase()] || entity);
  const normalize = value => decode(value).replace(/\s+/g, ' ').trim();
  const textOf = (node, visibleOnly = false) => {
    if (node.tag === 'script' || node.tag === 'style' || node.tag === 'template') return '';
    if (visibleOnly && (Object.hasOwn(node.attrs, 'hidden') || node.attrs['aria-hidden'] === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.attrs.style || ''))) return '';
    return node.text + node.children.map(child => textOf(child, visibleOnly)).join('');
  };
  const all = [];
  const walk = (node, inMain = false, hidden = false) => {
    const inside = inMain || node.tag === 'main';
    const concealed = hidden || Object.hasOwn(node.attrs, 'hidden') || node.attrs['aria-hidden'] === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.attrs.style || '');
    all.push({ node, inMain: inside, hidden: concealed });
    for (const child of node.children) walk(child, inside, concealed);
  };
  walk(root);
  const ids = new Map(all.filter(row => row.node.attrs.id).map(row => [row.node.attrs.id, row.node]));
  const hasMain = all.some(row => row.node.tag === 'main' && !row.hidden);
  let hasLabelledStatus = false;
  for (const { node, inMain, hidden } of all) {
    if (!inMain || hidden) continue;
    const statusRole = node.attrs.role?.trim().split(/\s+/)[0] === 'status' || (!node.attrs.role && node.tag === 'output');
    const live = node.attrs['aria-live'];
    if (!((statusRole && (live === undefined || live === 'polite')) || live === 'polite')) continue;
    const labelledBy = node.attrs['aria-labelledby']?.split(/\s+/).map(id => ids.get(id)).filter(Boolean).map(labelNode => textOf(labelNode)).join(' ') || '';
    const label = normalize(node.attrs['aria-label'] || labelledBy);
    const content = normalize(textOf(node, true));
    if (!/(?:seats?\s+(?:remaining|available)|(?:remaining|available)\s+seats?)/i.test(label)) continue;
    hasLabelledStatus = true;
    if (/(?:^|\D)9(?:\D|$)/.test(content)) return { hasMain, hasLabelledStatus: true, containsLatestValue: true };
  }
  return { hasMain, hasLabelledStatus, containsLatestValue: false };
}

class OwnedInventoryStore {
  capacity = 12;
  remaining = 12;
  revision = 0;
  reads = 0;
  writes = 0;
  reservations = new Map();

  async read() {
    this.reads++;
    return Object.freeze({ capacity: this.capacity, remaining: this.remaining, revision: this.revision });
  }

  async reserve(requestId, seats) {
    const previous = this.reservations.get(requestId);
    if (previous) {
      if (previous.seats !== seats) throw new ReservationConflict('Idempotency key used with different seat count');
      return { ...previous, replayed: true };
    }
    if (seats > this.remaining) throw new ReservationConflict('Insufficient seats');
    this.remaining -= seats;
    this.revision++;
    this.writes++;
    const reservation = { requestId, seats, remaining: this.remaining, revision: this.revision, replayed: false };
    this.reservations.set(requestId, reservation);
    return { ...reservation };
  }
}

let ReservationConflict;
try {
  const appModule = await import(pathToFileURL(process.argv[2]).href);
  const domainModule = await import(pathToFileURL(process.argv[3]).href);
  ReservationConflict = domainModule.ReservationConflict;
  if (typeof appModule.createApp !== 'function' || typeof ReservationConflict !== 'function') throw new Error('Candidate API unavailable');
  const store = new OwnedInventoryStore();
  const app = appModule.createApp(store);
  if (typeof app !== 'function') throw new Error('Candidate handler unavailable');
  const call = async (method, path, body) => {
    const response = await app(new Request(`http://owned.example${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: response.status, body: await response.text() };
  };
  const parsed = row => { try { return JSON.parse(row.body); } catch { return null; } };
  const first = await call('GET', '/availability');
  const second = await call('GET', '/availability');
  record('typed-availability-api', first.status === 200 && second.status === 200 && parsed(first)?.remaining === 12 && parsed(second)?.capacity === 12, { first: parsed(first), second: parsed(second) });
  record('unchanged-read-benefit', store.reads === 1, { storeReads: store.reads });

  const created = await call('POST', '/reservations', { requestId: 'request-0001', seats: 3 });
  const afterWrite = await call('GET', '/availability');
  record('acknowledged-reservation-freshness', created.status === 201 && parsed(created)?.remaining === 9 && parsed(afterWrite)?.remaining === 9 && parsed(afterWrite)?.revision === 1, { created: parsed(created), afterWrite: parsed(afterWrite), status: created.status });
  const readsAfterWrite = store.reads;
  const repeatedAfterWrite = await call('GET', '/availability');
  record('post-write-unchanged-read-benefit', repeatedAfterWrite.status === 200 && parsed(repeatedAfterWrite)?.remaining === 9 && parsed(repeatedAfterWrite)?.revision === 1 && store.reads === readsAfterWrite, { response: parsed(repeatedAfterWrite), firstReadStoreCount: readsAfterWrite, repeatedReadStoreCount: store.reads });

  const replay = await call('POST', '/reservations', { requestId: 'request-0001', seats: 3 });
  const mismatchedReplay = await call('POST', '/reservations', { requestId: 'request-0001', seats: 2 });
  record('idempotent-reservation', replay.status === 200 && parsed(replay)?.replayed === true && store.writes === 1 && store.remaining === 9, { status: replay.status, replay: parsed(replay), storeWrites: store.writes });
  record('conflicting-idempotency-key', mismatchedReplay.status === 409 && store.writes === 1 && store.remaining === 9, { status: mismatchedReplay.status, storeWrites: store.writes });

  const invalid = await call('POST', '/reservations', { requestId: 'bad', seats: 99 });
  const overbook = await call('POST', '/reservations', { requestId: 'request-0002', seats: 10 });
  record('bounded-input-and-capacity', invalid.status === 400 && overbook.status === 409 && store.remaining === 9, { invalidStatus: invalid.status, overbookStatus: overbook.status, remaining: store.remaining });

  const page = await call('GET', '/');
  const status = staticStatus(page.body);
  record('accessible-live-status', page.status === 200 && status.hasMain && status.hasLabelledStatus && status.containsLatestValue, { status: page.status, ...status });
  const health = await call('GET', '/health');
  record('health-route', health.status === 200 && health.body === 'ready', { status: health.status, body: health.body });
  process.stdout.write(JSON.stringify({ schemaVersion: 1, status: checks.every(check => check.outcome === 'PASS') ? 'PASS' : 'FAIL', checks }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, status: 'ERROR', checks, error: error instanceof Error ? error.message.slice(0, 256) : 'UNKNOWN' }) + '\n');
}
