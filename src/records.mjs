import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

const DAY = 86400000;
const statuses = ['selected', 'none', 'no_candidates', 'error'];
const text = (value, limit) => typeof value === 'string' && value.length <= limit;

// Project only known fields: log readers must never expose added prompt/key fields.
export function selectionRecord(value) {
  if (!value || value.version !== 1 || !text(value.id, 100) || !value.id ||
      !text(value.timestamp, 30) || !Number.isFinite(Date.parse(value.timestamp)) ||
      new Date(value.timestamp).toISOString() !== value.timestamp ||
      !text(value.cwd, 8192) || !isAbsolute(value.cwd) ||
      !(value.sessionId === null || text(value.sessionId, 200)) ||
      !text(value.model, 100) || !/^jev-[\w.-]+$/u.test(value.model) ||
      !Number.isFinite(value.threshold) || value.threshold <= 0.5 || value.threshold > 1 ||
      !Number.isInteger(value.maxSkills) || value.maxSkills < 1 || value.maxSkills > 20 ||
      !(value.candidateCount === null || (Number.isInteger(value.candidateCount) && value.candidateCount >= 0)) ||
      !Number.isFinite(value.durationMs) || value.durationMs < 0 ||
      !statuses.includes(value.status) || !Array.isArray(value.selected) || value.selected.length > value.maxSkills ||
      (value.status === 'error' ? !/^JEV_[A-Z0-9_]{1,80}$/u.test(value.errorCode) : value.errorCode !== null)) return null;
  const selected = [];
  const paths = new Set();
  for (const skill of value.selected) {
    if (!skill || !text(skill.name, 512) || !skill.name || !text(skill.path, 8192) || !isAbsolute(skill.path) ||
        !Number.isFinite(skill.probability) || skill.probability < value.threshold || skill.probability > 1 || paths.has(skill.path)) return null;
    paths.add(skill.path);
    selected.push({ name: skill.name, path: skill.path, probability: skill.probability });
  }
  if ((value.status === 'selected') !== (selected.length > 0) ||
      (['selected', 'none'].includes(value.status) && !(value.candidateCount > 0)) ||
      (value.status === 'no_candidates' && value.candidateCount !== 0) ||
      (selected.length && selected.length > value.candidateCount)) return null;
  return Object.fromEntries(['version', 'id', 'timestamp', 'cwd', 'sessionId', 'model', 'threshold',
    'maxSkills', 'candidateCount', 'durationMs', 'status', 'errorCode'].map(key => [key, value[key]]).concat([['selected', selected]]));
}

export async function appendSelection(dataDir, event) {
  const record = selectionRecord(event);
  if (!record) throw new Error('JEV_RECORD_INVALID');
  const line = Buffer.from(JSON.stringify(record) + '\n');
  if (line.length > 128 * 1024) throw new Error('JEV_RECORD_TOO_LARGE');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await appendFile(join(dataDir, record.timestamp.slice(0, 10) + '.jsonl'), line, { mode: 0o600 });
}

export async function readSelections(dataDir, days, now = new Date()) {
  const end = new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime() + DAY;
  const start = end - days * DAY;
  const first = new Date(start).toISOString().slice(0, 10);
  const last = new Date(end - 1).toISOString().slice(0, 10);
  let files;
  try { files = await readdir(dataDir); } catch (error) {
    if (error.code === 'ENOENT') return { events: [], skipped: 0, first, last };
    throw error;
  }
  const events = [];
  let bytes = 0;
  let skipped = 0;
  // ponytail: scan at most 64 MiB per request; use SQLite if local history outgrows this ceiling.
  for (const name of files.filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name) && name.slice(0, 10) >= first && name.slice(0, 10) <= last).sort()) {
    const path = join(dataDir, name);
    bytes += (await stat(path)).size;
    if (bytes > 64 * 1024 * 1024) throw Object.assign(new Error('JEV_HISTORY_TOO_LARGE'), { code: 'JEV_HISTORY_TOO_LARGE' });
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = selectionRecord(JSON.parse(line)); } catch { /* A concurrent or interrupted append may leave an incomplete line. */ }
      if (!record) { skipped++; continue; }
      if (Date.parse(record.timestamp) >= start && Date.parse(record.timestamp) < end) events.push(record);
    }
  }
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id));
  return { events, skipped, first, last };
}

export function summarize(history, { days, project = '', search = '', status = '', page = 1 }) {
  const events = history.events.filter(event => !project || event.cwd === project);
  const summary = { routes: events.length, evaluated: 0, withSkills: 0, noMatch: 0, noCandidates: 0,
    errors: 0, selections: 0, uniqueSkills: 0, avgDurationMs: null, selectionRate: null };
  const skills = new Map();
  const trend = Array.from({ length: days }, (_, index) => ({
    date: new Date(Date.parse(history.first) + index * DAY).toISOString().slice(0, 10),
    selected: 0, none: 0, no_candidates: 0, error: 0,
  }));
  for (const event of events) {
    const day = trend.find(day => day.date === event.timestamp.slice(0, 10));
    if (day) day[event.status]++;
    if (['selected', 'none'].includes(event.status)) summary.evaluated++;
    summary[{ selected: 'withSkills', none: 'noMatch', no_candidates: 'noCandidates', error: 'errors' }[event.status]]++;
    for (const skill of event.selected) {
      summary.selections++;
      const row = skills.get(skill.path) ?? { name: skill.name, path: skill.path, count: 0, probabilitySum: 0, lastSelected: event.timestamp };
      row.count++;
      row.probabilitySum += skill.probability;
      skills.set(skill.path, row);
    }
  }
  summary.uniqueSkills = skills.size;
  if (events.length) summary.avgDurationMs = Math.round(events.reduce((sum, event) => sum + event.durationMs, 0) / events.length);
  if (summary.evaluated) summary.selectionRate = summary.withSkills / summary.evaluated;
  const needle = search.toLocaleLowerCase();
  const matches = skill => (skill.name + '\n' + skill.path).toLocaleLowerCase().includes(needle);
  const ranking = [...skills.values()].filter(matches).map(({ probabilitySum, ...skill }) => ({
    ...skill, averageProbability: probabilitySum / skill.count, selectionRate: skill.count / summary.evaluated,
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const matchingEvents = events.filter(event => (!status || event.status === status) && (!needle || event.selected.some(matches)));
  const pageSize = 25;
  const currentPage = Math.min(page, Math.max(1, Math.ceil(matchingEvents.length / pageSize)));
  return { summary, trend, skills: ranking, projects: [...new Set(history.events.map(event => event.cwd))].sort(),
    events: matchingEvents.slice((currentPage - 1) * pageSize, currentPage * pageSize), page: currentPage, pageSize,
    totalEvents: matchingEvents.length, skipped: history.skipped, first: history.first, last: history.last };
}
