import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { eligibleSkills, evaluate, fallback, loadConfig, makeBatches, readCatalog, route } from '../src/router.mjs';
import { route as bundledRoute } from '../plugins/jev-skill-router/scripts/router.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'jev-router-test-'));
const cwd = await realpath(temporary);
try {
  const configFile = join(cwd, 'config.json');
  await writeFile(configFile, JSON.stringify({ apiKey: 'fixture-key', threshold: 0.8, maxSkills: 2, dataDir: join(cwd, 'history') }));
  const config = await loadConfig({ JEV_SKILL_ROUTER_CONFIG: configFile });
  assert.equal((await loadConfig({ JEV_SKILL_ROUTER_CONFIG: configFile, TYPESAFE_API_KEY: 'override' })).apiKey, 'override');
  assert.equal(config.recordSelections, true);
  for (const settings of [{ threshold: 0.5 }, { maxSkills: 0 }, { timeoutMs: 30000 }, { unexpected: true }, { apiKey: 'bad\nkey' }, { recordSelections: 'true' }, { dataDir: 'relative' }]) {
    await writeFile(configFile, JSON.stringify(settings));
    await assert.rejects(loadConfig({ JEV_SKILL_ROUTER_CONFIG: configFile }), /JEV_CONFIG_INVALID/);
  }
  await writeFile(configFile, '{broken');
  await assert.rejects(loadConfig({ JEV_SKILL_ROUTER_CONFIG: configFile }), /JEV_CONFIG_INVALID/);
  await writeFile(configFile, '{}');

  const raw = [];
  for (const [name, metadata, enabled] of [
    ['review', 'policy: {allow_implicit_invocation: true}', true],
    ['testing', null, true],
    ['manual', 'defaults: &manual\n  allow_implicit_invocation: false\npolicy: *manual', true],
    ['disabled', null, false],
    ['bad-yaml', 'policy: [broken', true],
  ]) {
    const root = join(cwd, name);
    await mkdir(join(root, 'agents'), { recursive: true });
    await writeFile(join(root, 'SKILL.md'), 'Private skill body must not be sent to Jev.');
    if (metadata) await writeFile(join(root, 'agents', 'openai.yaml'), metadata);
    raw.push({ name, description: `Help with ${name}.`, path: join(root, 'SKILL.md'), enabled, pluginId: name === 'review' ? 'tools@local' : null });
  }
  await symlink(raw[0].path, join(cwd, 'alias.md'));
  raw.push({ ...raw[0], path: join(cwd, 'alias.md') });
  raw.push({ ...raw[0], path: join(cwd, 'missing', 'SKILL.md') });
  const catalog = { cwd, skills: raw, errors: [] };
  const skills = await eligibleSkills(catalog);
  assert.deepEqual(skills.map(skill => skill.name), ['tools:review', 'testing']);

  // Exercise the real subprocess/JSON-RPC path without starting a model or contacting Jev.
  const codexBin = join(cwd, 'fake-codex');
  await writeFile(codexBin, `#!/usr/bin/env node
const { createInterface } = require('node:readline');
let initialized = false;
createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialized') { initialized = true; return; }
  if (message.id === 1) process.stdout.write(JSON.stringify({id:1,result:{}}) + '\\n');
  if (message.id === 2) {
    if (!initialized || message.method !== 'skills/list' || !message.params.forceReload) process.exit(2);
    process.stdout.write(JSON.stringify({id:2,result:{data:[${JSON.stringify(catalog)}]}}) + '\\n');
  }
});
`, { mode: 0o700 });
  const discovered = await readCatalog(cwd, { codexBin, signal: AbortSignal.timeout(2000) });
  assert.deepEqual(discovered, catalog);
  await assert.rejects(readCatalog(cwd, { codexBin: join(cwd, 'missing-bin'), signal: AbortSignal.timeout(1000) }), /JEV_CODEX_UNAVAILABLE/);

  const input = { hook_event_name: 'UserPromptSubmit', cwd, prompt: '请审查这段代码并验证测试。' };
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    assert.equal(options.redirect, 'error');
    const request = JSON.parse(options.body);
    assert.deepEqual(request.state, { user_request: input.prompt });
    assert.equal(request.model, 'jev-latest');
    assert(!options.body.includes(cwd));
    assert(!options.body.includes('Private skill body'));
    assert(!options.body.includes('fixture-key'));
    return Response.json({ model: 'jev-latest', answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) =>
      [id, { type: 'noul', noul: q.instructions.skill.name === 'tools:review' ? 0.98 : 0.9 }])) });
  };
  const dependencies = { discover: async () => catalog, fetchImpl };
  const result = await route(input, config, dependencies);
  assert.equal(result.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const context = result.hookSpecificOutput.additionalContext;
  assert(context.includes('tools:review') && context.includes('testing'));
  assert(context.includes('Explicit user-requested skills') && context.includes('Already-active skills'));
  assert(!context.includes('manual') && !context.includes('disabled'));
  const recordingFailure = await route(input, config, { ...dependencies, record: async () => { throw new Error('secret disk path'); } });
  assert.deepEqual(recordingFailure.hookSpecificOutput, result.hookSpecificOutput);
  assert.match(recordingFailure.systemMessage, /JEV_RECORD_UNAVAILABLE/);
  assert(!recordingFailure.systemMessage.includes('secret disk path'));
  await route(input, { ...config, recordSelections: false }, { ...dependencies, record: async () => assert.fail('Recording is disabled') });
  assert.deepEqual(await bundledRoute(input, config, dependencies), result);
  const limited = await route(input, { ...config, maxSkills: 1 }, dependencies);
  assert(!limited.hookSpecificOutput.additionalContext.includes('"testing"'));
  const none = await route(input, { ...config, threshold: 1 }, dependencies);
  assert(none.hookSpecificOutput.additionalContext.includes('No optional skill met'));
  assert.equal(calls, 6);
  assert.deepEqual(await route({ hook_event_name: 'Stop' }, config), {});
  await assert.rejects(route(input, { ...config, apiKey: '' }, dependencies), /JEV_NO_API_KEY/);
  await assert.rejects(route({ ...input, cwd: 'relative' }, config), /JEV_INPUT_INVALID/);
  assert.deepEqual(await route(input, config, { ...dependencies, discover: async () => ({ skills: [] }) }), {});

  for (const invalid of [
    { answers: {} },
    { answers: { s0: { type: 'noul', noul: 0.99 }, s1: { type: 'noul', noul: '0.9' } } },
    { answers: { s0: { type: 'noul', noul: 2 }, s1: { type: 'noul', noul: 0.9 } } },
    { answers: { s0: { type: 'noul', noul: 0.99 }, unknown: { type: 'noul', noul: 0.9 } } },
  ]) {
    await assert.rejects(route(input, config, { ...dependencies, fetchImpl: async () => Response.json(invalid) }), /JEV_RESPONSE_INVALID/);
  }
  for (const status of [401, 429, 529]) {
    await assert.rejects(route(input, config, { ...dependencies, fetchImpl: async () => new Response('DO_NOT_LOG_SERVER_BODY', { status }) }), new RegExp(`JEV_HTTP_${status}`));
  }
  await assert.rejects(route(input, { ...config, timeoutMs: 100 }, {
    ...dependencies,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      const socketTimer = setTimeout(() => reject(new Error('missed deadline')), 1000);
      signal.addEventListener('abort', () => { clearTimeout(socketTimer); reject(signal.reason); }, { once: true });
    }),
  }), /JEV_TIMEOUT/);
  assert(!JSON.stringify(fallback(new Error('DO_NOT_LOG_SECRET'))).includes('DO_NOT_LOG_SECRET'));
  assert.match(fallback({ code: 'JEV_HTTP_401' }).systemMessage, /JEV_HTTP_401/);
  assert.throws(() => makeBatches('汉'.repeat(9000), skills, config.model), /JEV_PROMPT_TOO_LARGE/);

  const many = Array.from({ length: 400 }, (_, index) => ({ name: `skill-${index}`, description: 'x'.repeat(600) }));
  const batches = makeBatches('Review a change.', many, config.model);
  assert(batches.length > 3);
  assert.equal(batches.reduce((sum, batch) => sum + Object.keys(batch.questions).length, 0), 400);
  assert(batches.every(batch => Buffer.byteLength(JSON.stringify(batch)) <= 60000));
  let concurrent = 0;
  let peak = 0;
  const scores = await evaluate(batches, config, AbortSignal.timeout(2000), async (_url, options) => {
    peak = Math.max(peak, ++concurrent);
    await new Promise(resolveWait => setTimeout(resolveWait, 2));
    concurrent--;
    return Response.json({ answers: Object.fromEntries(Object.keys(JSON.parse(options.body).questions).map(id => [id, { type: 'noul', noul: 0.95 }])) });
  });
  assert.equal(scores.size, 400);
  assert(peak <= 3 && peak > 1);

  const bundle = join(cwd, 'standalone-router.mjs');
  await writeFile(bundle, await readFile(resolve('plugins/jev-skill-router/scripts/router.mjs')));
  const isolatedEnv = { ...process.env, TYPESAFE_API_KEY: '', JEV_SKILL_ROUTER_CONFIG: configFile, JEV_CODEX_BIN: codexBin, JEV_SKILL_ROUTER_DISABLED: '0', JEV_SKILL_ROUTER_DATA_DIR: config.dataDir };
  const listed = await promisify(execFile)(process.execPath, [bundle, '--list'], {
    cwd, env: isolatedEnv,
  });
  const list = JSON.parse(listed.stdout);
  assert.equal(list.apiKeyConfigured, false);
  assert.equal(list.candidateCount, 2);
  await new Promise((resolveCheck, reject) => {
    const child = spawn(process.execPath, [bundle], { cwd, env: isolatedEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code => {
      try {
        assert.equal(code, 0);
        assert.match(JSON.parse(output).systemMessage, /JEV_NO_API_KEY/);
        resolveCheck();
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
  const hooks = JSON.parse(await readFile('plugins/jev-skill-router/hooks/hooks.json', 'utf8'));
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, 'node "${PLUGIN_ROOT}/scripts/router.mjs"');
  assert.equal(JSON.parse(await readFile('.agents/plugins/marketplace.json', 'utf8')).plugins[0].source.path, './plugins/jev-skill-router');
  const history = await readFile(join(config.dataDir, new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8');
  assert(!history.includes(input.prompt) && !history.includes('fixture-key') && !history.includes('Private skill body'));
  const records = history.trim().split('\n').map(line => JSON.parse(line));
  assert(records.some(record => record.status === 'selected' && record.selected[0].probability === 0.98));
  assert(records.some(record => record.status === 'none'));
  assert(records.some(record => record.status === 'no_candidates'));
  assert(records.some(record => record.status === 'error' && record.errorCode === 'JEV_NO_API_KEY'));
  assert(records.some(record => record.status === 'error' && record.errorCode === 'JEV_TIMEOUT'));
  console.log('Self-check passed: catalog RPC, enabled/implicit policies, alias deduplication, bundled CLI, Jev request/response, multi-skill selection, batching, timeout and safe fallback.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
