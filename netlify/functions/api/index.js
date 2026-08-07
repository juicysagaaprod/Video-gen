import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";

import {
  MODEL_IDS,
  estimateCostCents,
  actualCostCents,
  submitJob,
  getTask,
  cancelTask,
} from "../../../backend/lib/byteplus.js";
import {
  media,
  createUser,
  getUserByEmail,
  getUserById,
  reserveCredits,
  adjustCredits,
  createJob,
  getJobById,
  listJobs,
  updateJob,
  reconcileJobCredits,
} from "../../lib/blob-db.js";

const COOKIE_NAME = "seedance_session";
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function routePath(request) {
  return new URL(request.url).pathname.replace(/^\/api/, "") || "/";
}

function cookieValue(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function publicUser(user) {
  return { id: user.id, email: user.email, creditsCents: user.credits_cents };
}

async function requireUser(request) {
  const token = cookieValue(request, COOKIE_NAME);
  if (!token) throw Object.assign(new Error("Not signed in."), { status: 401 });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await getUserById(payload.sub);
    if (!user) throw new Error("Missing user");
    return user;
  } catch {
    throw Object.assign(new Error("Session expired or invalid."), { status: 401 });
  }
}

function parseInput(job) {
  try {
    return JSON.parse(job.input_json || "{}");
  } catch {
    return {};
  }
}

function serializeJob(job) {
  const input = parseInput(job);
  return {
    id: job.id,
    mode: job.mode,
    tier: job.tier,
    prompt: job.prompt,
    resolution: job.resolution,
    aspectRatio: job.aspect_ratio,
    duration: job.duration,
    state: job.state,
    videoUrl: job.video_key ? `/api/media/output/${job.id}` : job.provider_video_url || null,
    errorMessage: job.error_message || null,
    estCostCents: job.est_cost_cents,
    actualCostCents: job.actual_cost_cents,
    completionTokens: job.completion_tokens,
    provider: "byteplus",
    generateAudio: input.generate_audio !== false,
    hasReferenceAudio: Boolean(input.audio_urls?.length),
    voiceCharacterCount: Array.isArray(input.voice_characters) ? input.voice_characters.length : 0,
    cancellable: job.state === "queued",
    createdAt: job.created_at,
  };
}

async function parseJSON(request) {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("Invalid JSON request body."), { status: 400 });
  }
}

async function submitAndPersist(user, mode, tier, input) {
  const modelId = MODEL_IDS[mode]?.[tier];
  if (!modelId) throw Object.assign(new Error(`Unknown mode/tier combination: ${mode}/${tier}`), { status: 400 });
  if (!input.prompt) throw Object.assign(new Error("input.prompt is required"), { status: 400 });

  const duration = Number(input.duration) || 10;
  const estCostCents = estimateCostCents({
    tier,
    resolution: input.resolution || "720p",
    aspectRatio: input.aspect_ratio || "auto",
    durationSeconds: duration,
    hasVideoInput: Boolean(input.video_urls?.length),
  });

  if (!(await reserveCredits(user.id, estCostCents))) {
    const current = await getUserById(user.id);
    throw Object.assign(
      new Error(
        `Not enough credit. This clip reserves up to $${(estCostCents / 100).toFixed(2)}, you have $${(
          current.credits_cents / 100
        ).toFixed(2)}.`
      ),
      { status: 402 }
    );
  }

  let providerJob;
  try {
    providerJob = await submitJob(process.env.ARK_API_KEY, modelId, mode, input, `user-${user.id}`);
  } catch (error) {
    await adjustCredits(user.id, estCostCents);
    throw error;
  }

  try {
    return await createJob({
      user_id: user.id,
      request_id: providerJob.id,
      model_id: modelId,
      status_url: providerJob.statusUrl,
      mode,
      tier,
      prompt: input.original_prompt || input.prompt,
      resolution: input.resolution || "720p",
      aspect_ratio: input.aspect_ratio || "auto",
      duration,
      input_json: JSON.stringify(input),
      state: "queued",
      error_message: null,
      est_cost_cents: estCostCents,
      provider: "byteplus",
    });
  } catch (error) {
    await adjustCredits(user.id, estCostCents);
    cancelTask(process.env.ARK_API_KEY, providerJob.id).catch(() => {});
    throw error;
  }
}

async function storeProviderVideo(userId, jobId, videoUrl) {
  const response = await fetch(videoUrl);
  if (!response.ok) throw new Error(`Could not download completed video (HTTP ${response.status}).`);
  const blob = await response.blob();
  const key = `outputs/${userId}/${jobId}.mp4`;
  await media.set(key, blob, {
    metadata: { contentType: response.headers.get("content-type") || "video/mp4", size: blob.size, fileName: `${jobId}.mp4` },
  });
  return key;
}

async function handleAuth(request, path) {
  if (path === "/auth/register" && request.method === "POST") {
    const { email, password } = await parseJSON(request);
    if (typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email) || typeof password !== "string" || password.length < 8) {
      return json({ error: "Valid email and an 8+ character password are required." }, 400);
    }
    const hash = await bcrypt.hash(password, 12);
    const user = await createUser(email, hash);
    if (!user) return json({ error: "An account with that email already exists." }, 409);
    const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    return json(publicUser(user), 200, { "Set-Cookie": sessionCookie(token) });
  }

  if (path === "/auth/login" && request.method === "POST") {
    const { email, password } = await parseJSON(request);
    const user = await getUserByEmail(email || "");
    if (!user || !(await bcrypt.compare(password || "", user.password_hash))) {
      return json({ error: "Incorrect email or password." }, 401);
    }
    const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    return json(publicUser(user), 200, { "Set-Cookie": sessionCookie(token) });
  }

  if (path === "/auth/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
  }

  if (path === "/auth/me" && request.method === "GET") {
    return json(publicUser(await requireUser(request)));
  }

  return null;
}

async function handleMedia(request, path) {
  const outputMatch = path.match(/^\/media\/output\/([^/]+)$/);
  if (outputMatch && request.method === "GET") {
    const user = await requireUser(request);
    const job = await getJobById(outputMatch[1], user.id);
    if (!job?.video_key) return json({ error: "Video not found." }, 404);
    const entry = await media.getWithMetadata(job.video_key, { type: "stream", consistency: "strong" });
    if (!entry) return json({ error: "Video not found." }, 404);
    return new Response(entry.data, {
      headers: {
        "Content-Type": entry.metadata?.contentType || "video/mp4",
        "Content-Disposition": `inline; filename="${entry.metadata?.fileName || `${job.id}.mp4`}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  const uploadMatch = path.match(/^\/media\/upload\/([^/]+)$/);
  if (uploadMatch && request.method === "GET") {
    const key = `uploads/${uploadMatch[1]}`;
    const entry = await media.getWithMetadata(key, { type: "stream", consistency: "strong" });
    if (!entry) return json({ error: "Upload not found." }, 404);
    return new Response(entry.data, {
      headers: {
        "Content-Type": entry.metadata?.contentType || "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  return null;
}

async function handleUpload(request) {
  await requireUser(request);
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof Blob)) throw Object.assign(new Error("No file uploaded."), { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error("Netlify uploads are limited to 4 MB. Compress the file or use a public URL."), { status: 413 });
  }
  const type = file.type || "application/octet-stream";
  const name = typeof file.name === "string" ? file.name : "upload";
  if (type.startsWith("image/") || type.startsWith("audio/")) {
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    return json({ url: `data:${type};base64,${base64}`, name, mimeType: type });
  }
  if (type.startsWith("video/")) {
    const id = `${randomUUID()}-${encodeURIComponent(name)}`;
    await media.set(`uploads/${id}`, file, { metadata: { contentType: type, fileName: name, size: file.size } });
    const origin = new URL(request.url).origin;
    return json({ url: `${origin}/api/media/upload/${id}`, name, mimeType: type });
  }
  throw Object.assign(new Error("Only image, video, and audio uploads are supported."), { status: 400 });
}

async function routeRequest(request) {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not configured on Netlify.");
  const path = routePath(request);

  if (path === "/health" && request.method === "GET") {
    return json({ ok: true, provider: "byteplus", hasKey: Boolean(process.env.ARK_API_KEY), runtime: "netlify" });
  }

  const authResponse = await handleAuth(request, path);
  if (authResponse) return authResponse;
  const mediaResponse = await handleMedia(request, path);
  if (mediaResponse) return mediaResponse;
  if (path === "/upload" && request.method === "POST") return handleUpload(request);

  const user = await requireUser(request);
  if (path === "/generate" && request.method === "POST") {
    if (!process.env.ARK_API_KEY) throw new Error("ARK_API_KEY is not configured on Netlify.");
    const { mode = "text-to-video", tier = "standard", input = {} } = await parseJSON(request);
    return json(serializeJob(await submitAndPersist(user, mode, tier, input)));
  }

  if (path === "/jobs" && request.method === "GET") {
    return json((await listJobs(user.id)).map(serializeJob));
  }

  const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
  if (jobMatch && request.method === "GET") {
    let job = await getJobById(jobMatch[1], user.id);
    if (!job) return json({ error: "Job not found" }, 404);
    if (TERMINAL_STATES.has(job.state)) return json(serializeJob(job));

    const providerTask = await getTask(process.env.ARK_API_KEY, job.request_id);
    if (providerTask.status === "succeeded") {
      const videoUrl = providerTask?.content?.video_url;
      if (!videoUrl) throw new Error("BytePlus completed the task without returning a video URL.");
      const input = parseInput(job);
      const completionTokens = Number(providerTask?.usage?.completion_tokens) || 0;
      const costCents = completionTokens
        ? actualCostCents({ tier: job.tier, hasVideoInput: Boolean(input.video_urls?.length), completionTokens })
        : job.est_cost_cents;
      const videoKey = await storeProviderVideo(user.id, job.id, videoUrl);
      await updateJob(job.id, user.id, { state: "completed", video_key: videoKey, provider_video_url: videoUrl, error_message: null });
      await reconcileJobCredits(job.id, user.id, costCents, completionTokens || null);
    } else if (providerTask.status === "running") {
      await updateJob(job.id, user.id, { state: "in_progress" });
    } else if (["failed", "expired", "cancelled"].includes(providerTask.status)) {
      await reconcileJobCredits(job.id, user.id, 0);
      await updateJob(job.id, user.id, {
        state: providerTask.status === "cancelled" ? "cancelled" : "failed",
        error_message: providerTask?.error?.message || `BytePlus task ${providerTask.status}.`,
      });
    }
    job = await getJobById(job.id, user.id);
    return json(serializeJob(job));
  }

  const cancelMatch = path.match(/^\/jobs\/([^/]+)\/cancel$/);
  if (cancelMatch && request.method === "POST") {
    const job = await getJobById(cancelMatch[1], user.id);
    if (!job) return json({ error: "Job not found" }, 404);
    if (job.state !== "queued") return json({ error: "BytePlus can only cancel a task while it is queued." }, 409);
    await cancelTask(process.env.ARK_API_KEY, job.request_id);
    await reconcileJobCredits(job.id, user.id, 0);
    return json(serializeJob(await updateJob(job.id, user.id, { state: "cancelled" })));
  }

  const retryMatch = path.match(/^\/jobs\/([^/]+)\/retry$/);
  if (retryMatch && request.method === "POST") {
    const job = await getJobById(retryMatch[1], user.id);
    if (!job) return json({ error: "Job not found" }, 404);
    if (!["failed", "cancelled"].includes(job.state)) return json({ error: "Only failed or cancelled jobs can be retried." }, 400);
    return json(serializeJob(await submitAndPersist(user, job.mode, job.tier, parseInput(job))));
  }

  return json({ error: "Not found" }, 404);
}

export default async (request) => {
  try {
    return await routeRequest(request);
  } catch (error) {
    console.error(error);
    return json({ error: error.message || "Unexpected server error" }, error.status || 500);
  }
};

export const config = {
  path: "/api/*",
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ["ip"] },
};
