import http from 'node:http';
import httpProxy from 'http-proxy';
import next from 'next';

const development = process.argv[2] === 'dev';
const hostname = process.env.ATS_FRONTEND_HOST || '0.0.0.0';
const port = Number(process.env.PORT || 2137);
const backend = new URL(process.env.ATS_BACKEND_URL || 'http://127.0.0.1:420');
const app = next({ dev: development, hostname, port });
const handleNext = app.getRequestHandler();
const socketProxy = httpProxy.createProxyServer({ target: backend.origin, ws: true, changeOrigin: true });
const themeApiProxy = httpProxy.createProxyServer({ target: backend.origin, changeOrigin: true });

socketProxy.on('error', (error, _request, response) => {
  console.error('Socket.IO proxy error:', error.message);
  if (!response) return;
  if ('writeHead' in response) {
    if (!response.headersSent) response.writeHead(502);
    response.end('Socket.IO backend unavailable');
  } else {
    response.destroy();
  }
});

themeApiProxy.on('error', (error, _request, response) => {
  console.error('Theme API proxy error:', error.message);
  if (!response) return;
  if ('writeHead' in response) {
    if (!response.headersSent) response.writeHead(502);
    response.end('Theme backend unavailable');
  } else {
    response.destroy();
  }
});

await app.prepare();

const isSocketIoPath = (pathname) => pathname === '/socket.io' || pathname.startsWith('/socket.io/');
const isThemeApiPath = (pathname) => /^\/api\/admin\/themes(?:\/[^/]+)?\/?$/.test(pathname);

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (isSocketIoPath(pathname)) {
    socketProxy.web(request, response);
    return;
  }
  if (isThemeApiPath(pathname)) {
    request.url = (request.url || '/').replace(/^\/api(?=\/)/, '');
    themeApiProxy.web(request, response);
    return;
  }
  void handleNext(request, response);
});

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (!isSocketIoPath(pathname)) {
    socket.destroy();
    return;
  }
  socketProxy.ws(request, socket, head);
});

server.listen(port, hostname, () => {
  console.log(`Next.js listening on http://${hostname}:${port}`);
});