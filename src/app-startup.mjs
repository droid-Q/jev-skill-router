import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ensureDashboard } from './dashboard.mjs';

const run = promisify(execFile);
const label = 'io.github.droid-q.jev-skill-router';
const fail = code => Object.assign(new Error(code), { code });

export function appStartupPaths(baseDirectory = homedir()) {
  return {
    plist: join(baseDirectory, 'Library', 'LaunchAgents', label + '.plist'),
    script: join(baseDirectory, 'Library', 'Application Support', 'Jev Skill Router', 'router.mjs'),
  };
}

export function appStartupPlist(script, configFile, env = process.env) {
  const xml = value => String(value).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
  const variables = configFile ? { JEV_SKILL_ROUTER_CONFIG: resolve(configFile) } : {};
  for (const key of ['JEV_SKILL_ROUTER_DATA_DIR', 'JEV_SKILL_ROUTER_DISABLED']) {
    if (env[key] !== undefined) variables[key] = env[key];
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(script)}</string><string>--app-startup-check</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(variables).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>5</integer>
<key>ThrottleInterval</key><integer>5</integer>
</dict></plist>\n`;
}

export async function codexAppIsRunning() {
  if (process.platform !== 'darwin') throw fail('JEV_APP_STARTUP_MACOS_ONLY');
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
      'ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.openai.codex").count > 0;'],
    { timeout: 3000, maxBuffer: 1024 });
    if (!['true', 'false'].includes(stdout.trim())) throw fail('JEV_APP_STATE_UNAVAILABLE');
    return stdout.trim() === 'true';
  } catch { throw fail('JEV_APP_STATE_UNAVAILABLE'); }
}

export async function startDashboardForApp(config, entry, { isRunning = codexAppIsRunning, ensure = ensureDashboard } = {}) {
  if (config.dashboardAutoStart && await isRunning()) await ensure(config, entry);
}

async function unload() {
  try { await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { timeout: 5000 }); }
  catch (error) { if (![3, 113].includes(error.code)) throw fail('JEV_APP_STARTUP_UNAVAILABLE'); }
}

export async function installAppStartup(entry, env = process.env) {
  if (process.platform !== 'darwin') throw fail('JEV_APP_STARTUP_MACOS_ONLY');
  const paths = appStartupPaths();
  const configFile = env.JEV_SKILL_ROUTER_CONFIG ? resolve(env.JEV_SKILL_ROUTER_CONFIG) : undefined;
  // Keep a standalone copy: Codex may remove versioned plugin caches on upgrade.
  // ponytail: launchd checks every five seconds; use workspace notifications if polling becomes costly.
  for (const [file, contents] of [
    [paths.script, await readFile(entry)],
    [paths.plist, appStartupPlist(paths.script, configFile, env)],
  ]) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + '.' + process.pid + '.tmp';
    try {
      await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }
  await unload();
  try { await run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, paths.plist], { timeout: 5000 }); }
  catch { throw fail('JEV_APP_STARTUP_UNAVAILABLE'); }
  return paths.plist;
}

export async function removeAppStartup() {
  if (process.platform !== 'darwin') throw fail('JEV_APP_STARTUP_MACOS_ONLY');
  await unload();
  for (const path of Object.values(appStartupPaths())) await rm(path, { force: true });
}
