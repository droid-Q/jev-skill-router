import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendSelection } from '../src/records.mjs';
import { startDashboard } from '../src/dashboard.mjs';

// Documentation-only sample data. No configuration, Codex catalog, or Jev API is read.
const port = Number(process.argv[2] ?? 4319);
if (process.argv.length > 3 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Usage: npm run dashboard:demo -- [port]');
const dataDir = await mkdtemp(join(tmpdir(), 'jev-router-demo-'));
const names = ['web-design-engineer', 'requesting-code-review', 'ecc:frontend-patterns', 'ecc:e2e-testing', 'plugin-creator', 'ecc:java-coding-standards'];
const weights = [0, 1, 0, 2, 1, 3, 0, 4, 1, 2, 0, 5];
const projects = ['atlas-web', 'jev-skill-router', 'api-service'];
const now = Date.now();
let sequence = 0;
try {
  for (let day = 29; day >= 0; day--) {
    const count = 4 + ((29 - day) * 7 % 12);
    for (let index = 0; index < count; index++) {
      const id = sequence++;
      const status = id % 29 === 0 ? 'error' : id % 53 === 0 ? 'no_candidates' : id % 5 === 0 ? 'none' : 'selected';
      const selected = [];
      if (status === 'selected') {
        const skillIndexes = new Set([weights[id % weights.length], ...(id % 3 === 0 ? [weights[(id + 5) % weights.length]] : [])]);
        for (const skillIndex of skillIndexes) selected.push({ name: names[skillIndex], path: '/demo/skills/' + names[skillIndex].replace(':', '/') + '/SKILL.md', probability: (84 + (id + skillIndex) % 16) / 100 });
      }
      await appendSelection(dataDir, { version: 1, id: 'demo-' + String(id).padStart(5, '0'),
        timestamp: new Date(now - day * 86400000 - (count - index) * 240000).toISOString(),
        cwd: '/demo/projects/' + projects[id % projects.length], sessionId: 'demo-session-' + Math.floor(id / 5),
        model: 'jev-latest', threshold: 0.8, maxSkills: 3, candidateCount: status === 'no_candidates' ? 0 : 829,
        durationMs: status === 'error' ? 12000 : 950 + (id * 137 % 2800), status,
        errorCode: status === 'error' ? 'JEV_TIMEOUT' : null, selected });
    }
  }
  const server = await startDashboard({ dataDir, port, demo: true });
  console.log('Demo dashboard (synthetic data): http://127.0.0.1:' + server.address().port);
  const stop = async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  await rm(dataDir, { recursive: true, force: true });
  throw error;
}
