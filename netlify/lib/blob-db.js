import { getStore } from "@netlify/blobs";
import { createHash, randomUUID } from "node:crypto";

const users = getStore({ name: "seedance-users", consistency: "strong" });
const jobs = getStore({ name: "seedance-jobs", consistency: "strong" });
export const media = getStore({ name: "seedance-media", consistency: "strong" });

function emailKey(email) {
  return `email/${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;
}

function userKey(id) {
  return `user/${id}`;
}

function jobKey(userId, id) {
  return `${userId}/${id}`;
}

async function readEntry(store, key) {
  return store.getWithMetadata(key, { type: "json", consistency: "strong" });
}

async function mutateJSON(store, key, mutator, retries = 8) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const entry = await readEntry(store, key);
    if (!entry) return null;
    const next = await mutator(structuredClone(entry.data));
    if (next == null) return entry.data;
    const result = await store.setJSON(key, next, { onlyIfMatch: entry.etag });
    if (result.modified) return next;
  }
  throw Object.assign(new Error("Concurrent update conflict. Please retry."), { status: 409 });
}

export async function createUser(email, passwordHash) {
  const normalized = email.trim().toLowerCase();
  const mappingKey = emailKey(normalized);
  const existing = await users.get(mappingKey, { type: "json", consistency: "strong" });
  if (existing) return null;

  const id = randomUUID();
  const mapping = await users.setJSON(mappingKey, { id }, { onlyIfNew: true });
  if (!mapping.modified) return null;

  const user = {
    id,
    email: normalized,
    password_hash: passwordHash,
    credits_cents: 500,
    applied_reconciliations: [],
    created_at: new Date().toISOString(),
  };
  await users.setJSON(userKey(id), user, { onlyIfNew: true });
  return user;
}

export async function getUserByEmail(email) {
  const mapping = await users.get(emailKey(email || ""), { type: "json", consistency: "strong" });
  return mapping?.id ? getUserById(mapping.id) : null;
}

export async function getUserById(id) {
  return users.get(userKey(id), { type: "json", consistency: "strong" });
}

export async function reserveCredits(userId, amountCents) {
  let insufficient = false;
  const user = await mutateJSON(users, userKey(userId), (current) => {
    if (current.credits_cents < amountCents) {
      insufficient = true;
      return null;
    }
    current.credits_cents -= amountCents;
    return current;
  });
  return insufficient ? null : user;
}

export async function adjustCredits(userId, deltaCents, reconciliationToken = null) {
  return mutateJSON(users, userKey(userId), (current) => {
    current.applied_reconciliations ||= [];
    if (reconciliationToken && current.applied_reconciliations.includes(reconciliationToken)) return null;
    current.credits_cents += deltaCents;
    if (reconciliationToken) {
      current.applied_reconciliations.push(reconciliationToken);
      current.applied_reconciliations = current.applied_reconciliations.slice(-250);
    }
    return current;
  });
}

export async function createJob(job) {
  const now = new Date().toISOString();
  const stored = {
    ...job,
    id: job.id || randomUUID(),
    actual_cost_cents: null,
    completion_tokens: null,
    credits_reconciled: false,
    reconciliation_token: null,
    video_key: null,
    created_at: now,
    updated_at: now,
  };
  const result = await jobs.setJSON(jobKey(stored.user_id, stored.id), stored, { onlyIfNew: true });
  if (!result.modified) throw new Error("Could not persist the new generation job.");
  return stored;
}

export async function getJobById(id, userId) {
  return jobs.get(jobKey(userId, id), { type: "json", consistency: "strong" });
}

export async function listJobs(userId) {
  const listing = await jobs.list({ prefix: `${userId}/` });
  const rows = await Promise.all(
    listing.blobs.slice(-100).map((blob) => jobs.get(blob.key, { type: "json", consistency: "strong" }))
  );
  return rows.filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function updateJob(id, userId, patch) {
  return mutateJSON(jobs, jobKey(userId, id), (current) => ({
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  }));
}

export async function reconcileJobCredits(jobId, userId, actualCostCents, completionTokens = null) {
  let job = await getJobById(jobId, userId);
  if (!job || job.credits_reconciled) return job;

  const token = job.reconciliation_token || `job-${jobId}-${randomUUID()}`;
  if (!job.reconciliation_token) {
    job = await updateJob(jobId, userId, { reconciliation_token: token });
  }

  const actual = Math.max(0, Number(actualCostCents) || 0);
  await adjustCredits(userId, job.est_cost_cents - actual, token);
  return updateJob(jobId, userId, {
    actual_cost_cents: actual,
    completion_tokens: completionTokens,
    credits_reconciled: true,
  });
}
