import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
const page = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your application</title><style>body{font:18px system-ui;background:#101827;color:#eef2ff;max-width:48rem;margin:15vh auto;padding:2rem}p{color:#b8c3d9;line-height:1.7}</style><main><h1>Your application is ready.</h1><p>Start building. Choose what to build next. Manage your optional database in environment settings.</p></main></html>';
export const createApplication = () => createServer((request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (request.url === '/health/ready') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"status":"ready"}'); return; }
  if (request.url !== '/') { response.writeHead(404); response.end('Not found'); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(page);
});
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApplication();
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
