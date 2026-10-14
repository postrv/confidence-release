import http from 'node:http';
import { readValue } from './cache.mjs';
import { writeValue } from './mutation.mjs';
import { renderStatus } from './presentation.mjs';

const storeUrl = process.env.FIXTURE_STORE_URL;
const token = process.env.FIXTURE_DATA_TOKEN;
if (!storeUrl || !token) throw new Error('Job-scoped fixture data route required');
async function data(method, value) {
  const response = await fetch(storeUrl, {
    method, redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'PUT' ? JSON.stringify({ value }) : undefined,
  });
  if (!response.ok) throw new Error(`Backing store HTTP ${response.status}`);
  return (await response.json()).value;
}
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/health') { response.end('ready'); return; }
    if (url.pathname === '/value' && request.method === 'GET') {
      const value = await readValue(() => data('GET'));
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ value })); return;
    }
    if (url.pathname === '/value' && request.method === 'PUT') {
      let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 1024) throw new Error('Body too large'); }
      const value = JSON.parse(raw).value;
      if (!Number.isSafeInteger(value)) throw new Error('Integer value required');
      await writeValue(value, (next) => data('PUT', next));
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ value })); return;
    }
    if (url.pathname === '/' && request.method === 'GET') {
      const value = await readValue(() => data('GET'));
      response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(renderStatus(value)); return;
    }
    response.statusCode = 404; response.end('Not found');
  } catch (error) { response.statusCode = 500; response.end(String(error.message)); }
});
server.listen(Number(process.env.PORT || 0), process.env.BIND_HOST || '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ type: 'ready', port: server.address().port }) + '\n');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
