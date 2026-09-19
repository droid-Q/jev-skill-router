import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { appStartupPaths, appStartupPlist, startDashboardForApp } from '../src/app-startup.mjs';
import { loadConfig } from '../src/router.mjs';

const directory = await mkdtemp(join(tmpdir(), 'jev-app-startup-test-'));
try {
  const configFile = join(directory, 'config & settings.json');
  const entry = resolve('plugins/jev-skill-router/scripts/router.mjs');
  await writeFile(configFile, JSON.stringify({ dashboardPort: 4327 }));
  const config = await loadConfig({ JEV_SKILL_ROUTER_CONFIG: configFile });
  let running = false;
  const calls = [];
  const dependencies = { isRunning: async () => running, ensure: async (...args) => { calls.push(args); } };
  await startDashboardForApp(config, entry, dependencies);
  assert.equal(calls.length, 0, 'Closed Codex must not start a dashboard');
  running = true;
  await startDashboardForApp(config, entry, dependencies);
  assert.equal(calls.length, 1, 'Opening Codex starts the dashboard without a task or prompt');
  assert.equal(calls[0][0].dashboardPort, 4327);
  assert.equal(calls[0][1], entry);
  await writeFile(configFile, JSON.stringify({ dashboardPort: 4328 }));
  await startDashboardForApp(await loadConfig({ JEV_SKILL_ROUTER_CONFIG: configFile }), entry, dependencies);
  assert.equal(calls[1][0].dashboardPort, 4328, 'The next check uses the current Jev config');
  await startDashboardForApp({ ...config, dashboardAutoStart: false }, entry, {
    isRunning: async () => assert.fail('Disabled startup must not query macOS'), ensure: dependencies.ensure,
  });
  assert.equal(calls.length, 2);
  await assert.rejects(startDashboardForApp(config, entry, { ...dependencies, ensure: async () => { throw new Error('Occupied port'); } }), /Occupied port/);

  const paths = appStartupPaths(directory);
  assert(paths.script.includes('Application Support/Jev Skill Router/router.mjs'));
  const plist = appStartupPlist(paths.script, configFile, { TYPESAFE_API_KEY: 'DO_NOT_PERSIST_KEY', JEV_SKILL_ROUTER_DATA_DIR: join(directory, 'history') });
  assert(plist.includes('config &amp; settings.json'));
  assert(!plist.includes('DO_NOT_PERSIST_KEY'));
  assert(!plist.includes('4327') && !plist.includes('4328') && !plist.includes('4318'), 'No port belongs in the launch agent');
  assert(!appStartupPlist(paths.script, undefined, {}).includes('JEV_SKILL_ROUTER_CONFIG'), 'An optional missing default config stays optional');
  const plistFile = join(directory, 'agent.plist');
  await writeFile(plistFile, plist);
  if (process.platform === 'darwin') {
    await promisify(execFile)('/usr/bin/plutil', ['-lint', plistFile]);
    const { stdout } = await promisify(execFile)('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistFile]);
    const value = JSON.parse(stdout);
    assert.equal(value.StartInterval, 5);
    assert.equal(value.RunAtLoad, true);
    assert.equal(value.EnvironmentVariables.JEV_SKILL_ROUTER_CONFIG, configFile);
    assert.deepEqual(value.ProgramArguments, [process.execPath, paths.script, '--app-startup-check']);
  }
  const disabledConfig = join(directory, 'disabled.json');
  await writeFile(disabledConfig, '{"dashboardAutoStart":false}');
  const result = await promisify(execFile)(process.execPath, [entry, '--app-startup-check'], {
    env: { ...process.env, TYPESAFE_API_KEY: '', JEV_SKILL_ROUTER_CONFIG: disabledConfig },
  });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(await readFile(disabledConfig, 'utf8')).dashboardAutoStart, false);
  console.log('App startup check passed: closed/open app, config port reload, opt-out, safe launch agent, bundled check and no API key persistence.');
} finally { await rm(directory, { recursive: true, force: true }); }
