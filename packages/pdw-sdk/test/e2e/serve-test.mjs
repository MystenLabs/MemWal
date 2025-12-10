/**
 * Simple static server for Playwright E2E tests
 * Serves dist/ and test/e2e/ files
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const PORT = 3456;

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.ts': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function resolveFile(urlPath) {
  // Map URL paths to file system
  if (urlPath === '/' || urlPath === '/index.html') {
    return path.join(ROOT_DIR, 'test/e2e/test-page.html');
  }

  if (urlPath.startsWith('/test-page.html')) {
    return path.join(ROOT_DIR, 'test/e2e/test-page.html');
  }

  if (urlPath.startsWith('/dist-browser/')) {
    return path.join(ROOT_DIR, urlPath);
  }

  if (urlPath.startsWith('/dist/')) {
    return path.join(ROOT_DIR, urlPath);
  }

  if (urlPath.startsWith('/node_modules/')) {
    return path.join(ROOT_DIR, urlPath);
  }

  // Default: try to serve from e2e folder
  return path.join(ROOT_DIR, 'test/e2e', urlPath);
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const filePath = resolveFile(urlPath);

  console.log(`[${new Date().toISOString()}] ${req.method} ${urlPath} -> ${filePath}`);

  // Add CORS headers for esm.sh imports
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      console.error(`  Error: ${err.message}`);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Not found: ${urlPath}`);
      return;
    }

    const mimeType = getMimeType(filePath);
    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`
=========================================
  E2E Test Server Running
  URL: http://localhost:${PORT}
  Root: ${ROOT_DIR}
=========================================

  Test page: http://localhost:${PORT}/test-page.html

  Press Ctrl+C to stop
`);
});
