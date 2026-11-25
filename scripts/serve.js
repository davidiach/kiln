// Serve dist/ on http://localhost:8000 (no dependencies).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const port = Number(process.env.PORT ?? 8000);

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = resolve(dist, '.' + (path.endsWith('/') ? path + 'index.html' : path));
  if (!file.startsWith(dist)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`Kiln playground: http://localhost:${port}/`));
