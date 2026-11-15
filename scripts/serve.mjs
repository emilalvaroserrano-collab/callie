import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/*
 * Tiny static server that mirrors the deployed clean-URL behaviour:
 *   /        -> public/index.html
 *   /auth    -> public/auth.html
 * /index.html and /auth.html redirect to their clean URLs, exactly like Vercel.
 */
const rootDir = new URL('../public/', import.meta.url);
const port = Number(process.env.PORT || 4173);

const CLEAN_URLS = new Map([
  ['/auth.html', '/auth'],
  ['/index.html', '/'],
]);

const CLEAN_FILES = new Map([
  ['/', 'index.html'],
  ['/auth', 'auth.html'],
]);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (CLEAN_URLS.has(pathname)) {
    res.writeHead(308, { Location: CLEAN_URLS.get(pathname) }).end();
    return;
  }

  const relative = CLEAN_FILES.get(pathname) || pathname.replace(/^\/+/, '');
  const filePath = path.join(rootDir.pathname, relative);

  if (!filePath.startsWith(rootDir.pathname)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    }).end(data);
  });
});

server.listen(port, () => {
  console.log(`CSR Studio running at http://localhost:${port}`);
  console.log(`  App:  http://localhost:${port}/`);
  console.log(`  Auth: http://localhost:${port}/auth`);
});
