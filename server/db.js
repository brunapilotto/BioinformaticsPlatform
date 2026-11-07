import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_BRAND, DEFAULT_CONNECTIONS, SEED_ANALYSES } from './seeds.js';

const TABLES = `
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS analyses (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    seq INTEGER NOT NULL,
    label TEXT NOT NULL,
    state TEXT NOT NULL,
    pid INTEGER,
    dir TEXT,
    url TEXT,
    message TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER,
    finished_at INTEGER,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
  CREATE INDEX IF NOT EXISTS jobs_run ON jobs(run_id, seq);
`;

const JOB_COLUMNS = new Set(['state', 'pid', 'dir', 'url', 'message', 'cancel_requested', 'started_at', 'finished_at', 'command', 'attempts']);

export const ACTIVE_STATES = ['queued', 'downloading', 'running'];

const toJob = (row) => row && {
  id: row.id,
  runId: row.run_id,
  seq: row.seq,
  label: row.label,
  state: row.state,
  pid: row.pid,
  dir: row.dir,
  url: row.url,
  message: row.message,
  cancelRequested: !!row.cancel_requested,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  command: row.command,
  attempts: JSON.parse(row.attempts),
  payload: JSON.parse(row.payload),
};

export class Store {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const file = join(dataDir, 'plataforma.db');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(TABLES);
    this.migrate();
    this.seed();
  }

  // CREATE TABLE IF NOT EXISTS não altera bancos já existentes: colunas novas entram aqui.
  migrate() {
    const columns = this.db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
    if (!columns.includes('command')) this.db.exec('ALTER TABLE jobs ADD COLUMN command TEXT');
    if (!columns.includes('attempts')) this.db.exec("ALTER TABLE jobs ADD COLUMN attempts TEXT NOT NULL DEFAULT '[]'");
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  seed() {
    if (this.getSetting('seeded')) return;
    this.transaction(() => {
      SEED_ANALYSES.forEach((a) => this.saveAnalysis(null, a));
      this.setSetting('seeded', true);
    });
  }

  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  getBrand() {
    return { ...DEFAULT_BRAND, ...this.getSetting('brand', {}) };
  }

  setBrand(brand) {
    this.setSetting('brand', brand);
  }

  getConnections() {
    return { ...DEFAULT_CONNECTIONS, ...this.getSetting('connections', {}) };
  }

  setConnections(conn) {
    this.setSetting('connections', conn);
  }

  listAnalyses() {
    return this.db.prepare('SELECT data FROM analyses ORDER BY position').all().map((r) => JSON.parse(r.data));
  }

  getAnalysis(id) {
    const row = this.db.prepare('SELECT data FROM analyses WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  }

  saveAnalysis(origId, analysis) {
    const data = JSON.stringify(analysis);
    if (origId) {
      this.db.prepare('UPDATE analyses SET id = ?, data = ? WHERE id = ?').run(analysis.id, data, origId);
      return;
    }
    const { next } = this.db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM analyses').get();
    this.db.prepare('INSERT INTO analyses (id, position, data) VALUES (?, ?, ?)').run(analysis.id, next, data);
  }

  deleteAnalysis(id) {
    this.db.prepare('DELETE FROM analyses WHERE id = ?').run(id);
  }

  insertRun(run, jobs) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO runs (id, created_at, data) VALUES (?, ?, ?)').run(run.id, run.createdAt, JSON.stringify(run));
      const insert = this.db.prepare('INSERT INTO jobs (id, run_id, seq, label, state, payload) VALUES (?, ?, ?, ?, ?, ?)');
      jobs.forEach((j) => insert.run(j.id, run.id, j.seq, j.label, 'queued', JSON.stringify(j.payload)));
    });
  }

  deleteRun(id) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM jobs WHERE run_id = ?').run(id);
      this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
    });
  }

  getRun(id) {
    const row = this.db.prepare('SELECT data FROM runs WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  }

  listRuns(limit = 50) {
    return this.db.prepare('SELECT data FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit).map((r) => JSON.parse(r.data));
  }

  jobsForRun(runId) {
    return this.db.prepare('SELECT * FROM jobs WHERE run_id = ? ORDER BY seq').all(runId).map(toJob);
  }

  getJob(id) {
    return toJob(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  }

  jobsInState(...states) {
    const marks = states.map(() => '?').join(',');
    return this.db.prepare(`SELECT jobs.* FROM jobs JOIN runs ON runs.id = jobs.run_id
      WHERE state IN (${marks}) ORDER BY runs.created_at, runs.rowid, jobs.seq`).all(...states).map(toJob);
  }

  updateJob(id, patch) {
    const keys = Object.keys(patch);
    if (keys.some((k) => !JOB_COLUMNS.has(k))) throw new Error('Coluna inválida em updateJob');
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.db.prepare(`UPDATE jobs SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k]), id);
  }

  recentLocalPaths(limit = 5) {
    const seen = new Set();
    for (const run of this.listRuns(100)) {
      if (run.source?.type === 'local' && run.source.path) seen.add(run.source.path);
      if (seen.size >= limit) break;
    }
    return [...seen];
  }
}
