// Minimal static server for local development (no dependencies).
//   node tools/serve.mjs [port]
// Then open http://localhost:8000 in Chrome or Edge.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 8000;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // Development only: save a JSON file into data/ (e.g. a transcript for evaluation).
    // POST /__save/<name>.json  — only a plain file name, only .json, only inside data/.
    if (req.method === 'POST' && urlPath.startsWith('/__save/')) {
      const name = urlPath.slice('/__save/'.length);
      if (!/^[^\\/:*?"<>|]+\.json$/.test(name) || name.includes('..')) {
        res.writeHead(400).end('bad name');
        return;
      }
      const dir = path.join(root, 'data');
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 200e6) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFile(path.join(dir, name), Buffer.concat(chunks), (err) => {
          res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/plain' }).end(err ? String(err) : 'saved');
        });
      });
      return;
    }
    let file = path.join(root, urlPath);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`Voice Arranger: http://localhost:${port}/  (Ctrl+C to stop)`));
