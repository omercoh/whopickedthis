// Tiny local server: serves public/ and runs the API against an in-memory store.
// Usage: ADMIN_CODE=secret node test/dev-server.mjs   (default port 8888)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { handle } from '../netlify/functions/lib/game.mjs';
import { memoryStore } from './memory-store.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const store = memoryStore();
const port = Number(process.env.PORT || 8888);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { status, data } = await handle({
      method: req.method,
      path: url.pathname,
      body: raw ? JSON.parse(raw) : null,
      adminCode: req.headers['x-admin-code'],
      adminSecret: process.env.ADMIN_CODE || 'test',
    }, store);
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(data));
  }
  try {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await readFile(path.join(root, 'index.html')));
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, () => console.log(`http://localhost:${port}`));
