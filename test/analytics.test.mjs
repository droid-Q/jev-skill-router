import assert from 'node:assert/strict';
import { request } from 'node:http';
import { appendFile, mkdtemp, readFile, rm, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendSelection, readSelections, selectionRecord, summarize } from '../src/records.mjs';
import { startDashboard } from '../src/dashboard.mjs';

const directory = await mkdtemp(join(tmpdir(), 'jev-analytics-test-'));
const now = new Date('2026-09-19T12:00:00.000Z');
const dataDir = join(directory, 'history');
const base = { version: 1, id: 'selected-1', timestamp: now.toISOString(), cwd: '/workspace/app', sessionId: 'test-session',
  model: 'jev-latest', threshold: 0.8, maxSkills: 3, candidateCount: 10, durationMs: 1000, status: 'selected', errorCode: null,
  selected: [{ name: 'review', path: '/skills/review/SKILL.md', probability: 0.9 }, { name: 'testing', path: '/skills/testing/SKILL.md', probability: 0.8 }] };
let server;
try {
  await appendSelection(dataDir, { ...base, prompt: 'DO_NOT_STORE_PROMPT', apiKey: 'DO_NOT_STORE_KEY' });
  await appendSelection(dataDir, { ...base, id: 'selected-2', timestamp: '2026-09-18T12:00:00.000Z', selected: [{ ...base.selected[0], probability: 1 }] });
  await appendSelection(dataDir, { ...base, id: 'none', status: 'none', selected: [] });
  await appendSelection(dataDir, { ...base, id: 'no-candidates', status: 'no_candidates', candidateCount: 0, selected: [] });
  await appendSelection(dataDir, { ...base, id: 'fallback', status: 'error', errorCode: 'JEV_HTTP_429', selected: [] });
  await appendSelection(dataDir, { ...base, id: 'other-project', cwd: '/workspace/other', selected: [] , status: 'none' });
  await appendSelection(dataDir, { ...base, id: 'outside-window', timestamp: '2026-08-01T12:00:00.000Z' });
  const file = join(dataDir, '2026-09-19.jsonl');
  await appendFile(file, '{broken\n' + JSON.stringify({ ...base, selected: [{ ...base.selected[0], probability: '0.9' }] }) + '\n');
  const history = await readSelections(dataDir, 7, now);
  assert.equal(history.events.length, 6);
  assert.equal(history.skipped, 2);
  const report = summarize(history, { days: 7, project: '/workspace/app' });
  assert.deepEqual(report.summary, { routes: 5, evaluated: 3, withSkills: 2, noMatch: 1, noCandidates: 1, errors: 1,
    selections: 3, uniqueSkills: 2, avgDurationMs: 1000, selectionRate: 2 / 3 });
  assert.equal(report.skills[0].name, 'review');
  assert.equal(report.skills[0].selectionRate, 2 / 3);
  assert.equal(report.skills[0].averageProbability, 0.95);
  assert.equal(report.trend.length, 7);
  assert.equal(report.trend.at(-1).error, 1);
  const filtered = summarize(history, { days: 7, project: '/workspace/app', search: 'testing', status: 'selected', page: 999 });
  assert.deepEqual(filtered.summary, report.summary, 'search/status must not change the rate denominator');
  assert.equal(filtered.totalEvents, 1);
  assert.equal(filtered.skills.length, 1);
  assert.equal(filtered.page, 1);
  assert.equal((await readSelections(join(directory, 'missing'), 7, now)).events.length, 0);
  assert.equal((await readSelections(dataDir, 1, now)).events.length, 5);
  assert.equal(selectionRecord({ ...base, selected: [...base.selected, base.selected[0]] }), null);
  assert.equal(selectionRecord({ ...base, selected: [] }), null);
  assert.equal(selectionRecord({ ...base, status: 'error', selected: [], errorCode: 'PRIVATE ERROR' }), null);
  const bytes = await readFile(file, 'utf8');
  assert(!bytes.includes('DO_NOT_STORE'));
  if (process.platform !== 'win32') {
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  const concurrentDir = join(directory, 'concurrent');
  await Promise.all(Array.from({ length: 40 }, (_, index) => appendSelection(concurrentDir, { ...base, id: 'concurrent-' + index })));
  const concurrent = await readSelections(concurrentDir, 1, now);
  assert.equal(concurrent.events.length, 40);
  assert.equal(concurrent.skipped, 0);
  assert.equal(summarize(concurrent, { days: 1, page: 2 }).events.length, 15);

  // Real HTTP checks: no Jev connection, external assets, state-changing endpoints or cross-origin access.
  const liveDir = join(directory, 'http');
  await appendSelection(liveDir, { ...base, timestamp: new Date().toISOString(), selected: [{ ...base.selected[0], name: '<img src=x onerror=alert(1)>' }] });
  server = await startDashboard({ dataDir: liveDir, port: 0 });
  const origin = 'http://127.0.0.1:' + server.address().port;
  await assert.rejects(startDashboard({ dataDir: liveDir, port: server.address().port }), { code: 'JEV_DASHBOARD_PORT_IN_USE' });
  const response = await fetch(origin + '/api/analytics');
  assert.equal(response.status, 200);
  const api = await response.json();
  assert.equal(api.summary.routes, 1);
  assert.equal(api.events[0].selected[0].name, '<img src=x onerror=alert(1)>');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const home = await fetch(origin);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(home.headers.get('content-security-policy'), /script-src 'sha256-/);
  const html = await home.text();
  assert(!html.includes('<img src=x'));
  assert(!html.includes('innerHTML'));
  assert(html.includes('textContent'));
  for (const [path, options, expected] of [
    ['/api/analytics?days=999', {}, 400], ['/api/analytics?status=made-up', {}, 400],
    ['/api/analytics?page=0', {}, 400], ['/api/analytics', { method: 'POST' }, 405],
    ['/api/analytics', { headers: { Origin: 'https://example.com' } }, 403],
    ['/api/analytics', { headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403], ['/config.json', {}, 404],
  ]) assert.equal((await fetch(origin + path, options)).status, expected);
  await new Promise((resolveCheck, reject) => {
    const req = request(origin + '/api/analytics', { headers: { Host: 'attacker.example' } }, res => {
      res.resume();
      try { assert.equal(res.statusCode, 403); resolveCheck(); } catch (error) { reject(error); }
    });
    req.on('error', reject); req.end();
  });
  await truncate(join(liveDir, new Date().toISOString().slice(0, 10) + '.jsonl'), 64 * 1024 * 1024 + 1);
  assert.equal((await fetch(origin + '/api/analytics')).status, 413, 'Oversized history must not silently truncate statistics');
  console.log('Analytics check passed: private/concurrent journaling, malformed records, date/project filters, denominator, pagination, bundled UI and loopback HTTP boundaries.');
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
  await rm(directory, { recursive: true, force: true });
}
