import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readSelections, summarize } from './records.mjs';
import page from './dashboard-page.mjs';

const hashes = [...page.matchAll(/<(?:script|style)>([\s\S]*?)<\/(?:script|style)>/gu)]
  .map(match => "'sha256-" + createHash('sha256').update(match[1]).digest('base64') + "'");

export function startDashboard({ dataDir, recordingEnabled = true, routingEnabled = true, port = 4318, demo = false }) {
  const server = createServer(async (request, response) => {
    const authority = `127.0.0.1:${server.address().port}`;
    const host = request.headers.host;
    const origin = request.headers.origin;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src ${hashes.join(' ')}; style-src ${hashes.join(' ')}; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type });
      response.end(typeof value === 'string' ? value : JSON.stringify(value));
    };
    if (![authority, `localhost:${server.address().port}`].includes(host) ||
        (origin && origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') {
      return send(403, { error: 'Local access only.' });
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      return send(405, { error: 'Read-only dashboard.' });
    }
    const url = new URL(request.url, `http://${authority}`);
    if (url.pathname === '/') return send(200, page, 'text/html; charset=utf-8');
    if (url.pathname === '/favicon.ico') return send(204, '');
    if (url.pathname !== '/api/analytics') return send(404, { error: 'Not found.' });
    const query = url.searchParams;
    const days = Number(query.get('days') ?? 30);
    const pageNumber = Number(query.get('page') ?? 1);
    const project = query.get('project') ?? '';
    const search = query.get('search') ?? '';
    const status = query.get('status') ?? '';
    if (![1, 7, 30, 90].includes(days) || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 1000000 ||
        project.length > 8192 || search.length > 512 || !['', 'selected', 'none', 'no_candidates', 'error'].includes(status)) {
      return send(400, { error: 'Invalid filters.' });
    }
    try {
      const history = await readSelections(dataDir, days);
      send(200, { ...summarize(history, { days, project, search, status, page: pageNumber }),
        generatedAt: new Date().toISOString(), dataDir, recordingEnabled, routingEnabled, demo });
    } catch (error) {
      send(error.code === 'JEV_HISTORY_TOO_LARGE' ? 413 : 500, {
        error: error.code === 'JEV_HISTORY_TOO_LARGE' ? 'History exceeds 64 MiB. Choose a shorter period or archive older daily files.' : 'Cannot read local history. Check the data directory permissions.',
      });
    }
  });
  server.requestTimeout = 10000;
  return new Promise((resolve, reject) => {
    const onError = error => reject(Object.assign(new Error('Dashboard could not start'), {
      code: error.code === 'EADDRINUSE' ? 'JEV_DASHBOARD_PORT_IN_USE' : 'JEV_DASHBOARD_UNAVAILABLE',
    }));
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', onError); resolve(server); });
  });
}
