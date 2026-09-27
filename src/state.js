import fs from 'node:fs';
import path from 'node:path';

export class StateStore {
  constructor(file) {
    this.file = file;
    this.data = { positions: {}, rebalanceHistory: [], cursors: {}, settings: {} };
    this.load();
  }
  load() {
    if (!fs.existsSync(this.file)) return;
    this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  getPosition(id) {
    return this.data.positions[id.toLowerCase()] || { outOfRangeConfirmations: 0, cooldownUntil: 0 };
  }
  setPosition(id, patch) {
    const key = id.toLowerCase();
    this.data.positions[key] = { ...this.getPosition(id), ...patch };
    this.save();
  }
  getCursor(key, fallback = 0) {
    return Number(this.data.cursors[key] ?? fallback);
  }
  setCursor(key, value) {
    this.data.cursors[key] = Number(value);
    this.save();
  }
  getSetting(key, fallback = null) {
    return this.data.settings[key] ?? fallback;
  }
  setSetting(key, value) {
    this.data.settings[key] = value;
    this.save();
  }
  recordRebalance(entry) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.data.rebalanceHistory = this.data.rebalanceHistory.filter((x) => x.ts >= cutoff);
    this.data.rebalanceHistory.push(entry);
    this.save();
  }
  recentRebalances(windowMs = 60 * 60 * 1000) {
    const cutoff = Date.now() - windowMs;
    return this.data.rebalanceHistory.filter((x) => x.ts >= cutoff);
  }
}
