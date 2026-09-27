import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sanitize } from './logger.js';

export class LedgerStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.eventsFile = path.join(dataDir, 'events.jsonl');
    this.snapshotFile = path.join(dataDir, 'latest-snapshot.json');
    this.baselineFile = path.join(dataDir, 'portfolio-baseline.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.seenKeys = new Set();
    for (const event of this.all()) if (event.eventKey) this.seenKeys.add(event.eventKey);
  }
  append(type, data = {}, ts = Date.now()) {
    const event = sanitize({ id: crypto.randomUUID(), ts, iso: new Date(ts).toISOString(), type, ...data });
    fs.appendFileSync(this.eventsFile, `${JSON.stringify(event)}\n`);
    if (event.eventKey) this.seenKeys.add(event.eventKey);
    return event;
  }
  appendUnique(eventKey, type, data = {}, ts = Date.now()) {
    if (this.seenKeys.has(eventKey)) return null;
    return this.append(type, { eventKey, ...data }, ts);
  }
  list({ limit = 250, type = null } = {}) {
    if (!fs.existsSync(this.eventsFile)) return [];
    const text = fs.readFileSync(this.eventsFile, 'utf8').trim();
    if (!text) return [];
    const lines = text.split(/\r?\n/).filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      try {
        const event = JSON.parse(lines[i]);
        if (!type || event.type === type) out.push(event);
      } catch {}
    }
    return out;
  }
  all() { return this.list({ limit: 100000 }).reverse(); }
  writeSnapshot(snapshot) { atomicWrite(this.snapshotFile, JSON.stringify(sanitize(snapshot), null, 2)); }
  readSnapshot() { return readJson(this.snapshotFile, null); }
  readBaseline() { return readJson(this.baselineFile, null); }
  writeBaseline(baseline) { atomicWrite(this.baselineFile, JSON.stringify(sanitize(baseline), null, 2)); }
  sum(field, type = null) {
    return this.all().reduce((sum, event) => {
      if (type && event.type !== type) return sum;
      const value = Number(event[field]);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
  }
}

function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
}
function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
