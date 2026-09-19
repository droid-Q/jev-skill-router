import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureDashboard, startDashboard } from '../src/dashboard.mjs';

const directory = await mkdtemp(join(tmpdir(), 'jev-autostart-test-'));
const dataDir = join(directory, 'history');
const configFile = join(directory, 'config.json');
const bundle = resolve('plugins/jev-skill-router/scripts/router.mjs');
const children = new Set();
let server;
let port;
const configure = settings => writeFile(configFile, JSON.stringify({ dataDir, dashboardPort: port, ...settings }));
const hook = (input, env = {}) => new Promise((resolveCheck, reject) => {
  const child = spawn(process.execPath, [bundle], {
    env: { ...process.env, TYPESAFE_API_KEY: '', JEV_SKILL_ROUTER_CONFIG: configFile,
      JEV_SKILL_ROUTER_DATA_DIR: dataDir, JEV_SKILL_ROUTER_DISABLED: '0', ...env },
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 6000,
  });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.once('error', reject);
  child.once('close', code => {
    try {
      assert.equal(code, 0);
      assert.equal(errors, '');
      resolveCheck(JSON.parse(output)); // Startup must not contaminate the single hook JSON response.
    } catch (error) { reject(error); }
  });
  child.stdin.end(JSON.stringify(input));
});
const session = { hook_event_name: 'SessionStart', source: 'startup', cwd: directory };
const health = async () => (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })).json();
const close = async () => {
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
  server = undefined;
};
const stopChild = async pid => {
  process.kill(pid, 'SIGTERM');
  children.delete(pid);
  for (let i = 0; i < 30; i++) {
    try { await health(); } catch { return; }
    await delay(25);
  }
  assert.fail('Owned dashboard did not stop');
};

try {
  server = await startDashboard({ dataDir, port: 0 });
  port = server.address().port;
  await close();
  await configure({ dashboardAutoStart: false });
  assert.deepEqual(await hook(session), {});
  await assert.rejects(health());
  await configure({});
  assert.deepEqual(await hook(session, { JEV_SKILL_ROUTER_DISABLED: '1' }), {});
  assert.deepEqual(await hook({ hook_event_name: 'Stop', cwd: directory }), {});
  assert.match((await hook({ hook_event_name: 'UserPromptSubmit', cwd: directory })).systemMessage, /JEV_INPUT_INVALID/);
  await assert.rejects(health());

  const concurrent = await Promise.all(Array.from({ length: 6 }, () => hook(session)));
  const first = await health();
  assert.equal(first.service, 'jev-skill-router');
  assert.equal(first.dataDir, dataDir);
  assert.equal(first.demo, false);
  assert.notEqual(first.pid, process.pid);
  children.add(first.pid);
  concurrent.forEach(output => assert.deepEqual(output, {}));
  await assert.rejects(access(dataDir), { code: 'ENOENT' }, 'SessionStart must not write a selection or need a Jev key');
  assert.deepEqual(await hook(session), {});
  assert.equal((await health()).pid, first.pid, 'Later hooks reuse the detached server');
  await stopChild(first.pid);

  const input = { hook_event_name: 'UserPromptSubmit', cwd: directory, prompt: 'A test without an API key.' };
  assert.match((await hook(input)).systemMessage, /JEV_NO_API_KEY/);
  const restarted = await health();
  children.add(restarted.pid);
  assert.notEqual(restarted.pid, first.pid, 'A submitted message restarts a stopped dashboard');
  await stopChild(restarted.pid);

  server = createServer((_request, response) => response.end('Unrelated service'));
  await new Promise(resolveListen => server.listen(port, '127.0.0.1', resolveListen));
  assert.match((await hook(session)).systemMessage, /JEV_DASHBOARD_PORT_IN_USE/);
  const fallback = await hook(input);
  assert.match(fallback.systemMessage, /JEV_NO_API_KEY/);
  assert.match(fallback.systemMessage, /JEV_DASHBOARD_PORT_IN_USE/);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'Unrelated service');
  await close();

  server = await startDashboard({ dataDir: join(directory, 'other'), port });
  assert.match((await hook(session)).systemMessage, /JEV_DASHBOARD_PORT_IN_USE/, 'Do not reuse another history directory');
  await close();
  server = await startDashboard({ dataDir, port, demo: true });
  assert.match((await hook(session)).systemMessage, /JEV_DASHBOARD_PORT_IN_USE/, 'Do not reuse a demo server');
  await close();
  server = await startDashboard({ dataDir, port, idleTimeoutMs: 100 });
  await new Promise(resolveClose => server.once('close', resolveClose));
  server = undefined;
  await assert.rejects(health());
  await assert.rejects(ensureDashboard({ dashboardAutoStart: true, dashboardPort: port, dataDir }, join(directory, 'missing.mjs')),
    { code: 'JEV_DASHBOARD_UNAVAILABLE' }, 'A failed child must finish within the startup deadline');
  console.log('Autostart check passed: detached/concurrent hooks, reuse, prompt recovery, opt-out, idle exit, clean JSON and safe port conflicts.');
} finally {
  if (server) await close();
  const remaining = await health().catch(() => null);
  if (remaining?.service === 'jev-skill-router' && remaining.dataDir === dataDir && remaining.pid !== process.pid) children.add(remaining.pid);
  // Every PID was obtained from a server launched by this test with its temporary history directory.
  for (const pid of children) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await rm(directory, { recursive: true, force: true });
}
