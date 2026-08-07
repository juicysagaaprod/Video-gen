import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const MEDIA_DIR = path.join(DATA_DIR, "media");
fs.mkdirSync(MEDIA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "app.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    credits_cents INTEGER NOT NULL DEFAULT 500,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    request_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    status_url TEXT NOT NULL,
    response_url TEXT NOT NULL,
    mode TEXT NOT NULL,
    tier TEXT NOT NULL,
    prompt TEXT NOT NULL,
    resolution TEXT NOT NULL,
    aspect_ratio TEXT NOT NULL,
    duration INTEGER NOT NULL,
    input_json TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'queued',
    video_path TEXT,
    error_message TEXT,
    est_cost_cents INTEGER NOT NULL,
    actual_cost_cents INTEGER,
    completion_tokens INTEGER,
    credits_reconciled INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL DEFAULT 'byteplus',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);
`);

// Add fields introduced after the original provider schema without
// discarding existing users or generation history.
const jobColumns = new Set(db.pragma("table_info(jobs)").map((column) => column.name));
for (const [name, definition] of [
  ["actual_cost_cents", "INTEGER"],
  ["completion_tokens", "INTEGER"],
  ["credits_reconciled", "INTEGER NOT NULL DEFAULT 0"],
  ["provider", "TEXT NOT NULL DEFAULT 'byteplus'"],
]) {
  if (!jobColumns.has(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
}

export { MEDIA_DIR };

export function createUser(email, passwordHash) {
  const stmt = db.prepare(
    "INSERT INTO users (email, password_hash) VALUES (?, ?)"
  );
  const info = stmt.run(email, passwordHash);
  return getUserById(info.lastInsertRowid);
}

export function getUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email);
}

export function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

export function adjustCredits(userId, deltaCents) {
  db.prepare("UPDATE users SET credits_cents = credits_cents + ? WHERE id = ?").run(
    deltaCents,
    userId
  );
  return getUserById(userId);
}

export function reserveCredits(userId, amountCents) {
  const info = db
    .prepare("UPDATE users SET credits_cents = credits_cents - ? WHERE id = ? AND credits_cents >= ?")
    .run(amountCents, userId, amountCents);
  return info.changes === 1 ? getUserById(userId) : null;
}

export const reconcileJobCredits = db.transaction(
  (jobId, userId, actualCostCents, completionTokens = null) => {
    const job = db
      .prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?")
      .get(jobId, userId);
    if (!job || job.credits_reconciled) return job;

    const actual = Math.max(0, Number(actualCostCents) || 0);
    const creditDelta = job.est_cost_cents - actual;
    db.prepare("UPDATE users SET credits_cents = credits_cents + ? WHERE id = ?").run(
      creditDelta,
      userId
    );
    db.prepare(
      `UPDATE jobs
       SET actual_cost_cents = ?, completion_tokens = ?, credits_reconciled = 1,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(actual, completionTokens, jobId);
    return db.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").get(jobId, userId);
  }
);

export function createJob(job) {
  const stmt = db.prepare(`
    INSERT INTO jobs (
      user_id, request_id, model_id, status_url, response_url,
      mode, tier, prompt, resolution, aspect_ratio, duration, input_json,
      state, est_cost_cents, provider
    ) VALUES (@user_id, @request_id, @model_id, @status_url, @response_url,
      @mode, @tier, @prompt, @resolution, @aspect_ratio, @duration, @input_json,
      @state, @est_cost_cents, @provider)
  `);
  const info = stmt.run(job);
  return getJobById(info.lastInsertRowid, job.user_id);
}

export function getJobById(id, userId) {
  return db
    .prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?")
    .get(id, userId);
}

export function listJobs(userId) {
  return db
    .prepare("SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100")
    .all(userId);
}

export function updateJob(id, patch) {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  const setClause = fields.map((f) => `${f} = @${f}`).join(", ");
  db.prepare(`UPDATE jobs SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({
    ...patch,
    id,
  });
}
