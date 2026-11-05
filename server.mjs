import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const root = new URL('./', import.meta.url);
const files = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/style.css', 'style.css'],
  ['/app.js', 'app.js'],
  ['/engine.mjs', 'engine.mjs'],
  ['/samples.mjs', 'samples.mjs'],
  ['/favicon.svg', 'favicon.svg']
]);
const types = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml'
};

export function createApp() {
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8'});
      res.end('只接受读取页面');
      return;
    }
    const name = files.get(req.url.split('?')[0]);
    if (!name) {
      const body = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>没有这个页面 · Kiln</title><body><p>窑里没有这一页。</p><p><a href="/">回窑</a></p></body></html>';
      res.writeHead(404, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': Buffer.byteLength(body)});
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    try {
      const body = await readFile(new URL(name, root));
      res.writeHead(200, {
        'Content-Type': types[name.split('.').at(-1)],
        'Content-Length': body.length,
        'Cache-Control': 'no-cache'
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'});
      res.end('页面没有读出来');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4329);
  const host = process.env.HOST ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT 要是 1 到 65535 的整数');
    process.exit(1);
  }
  createApp().listen(port, host, () => {
    console.log(`Kiln: http://${host}:${port}/`);
  });
}
