import dotenv from "dotenv";
// The project-local .env is the explicit source of truth for this service.
dotenv.config({ override: true });

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import multer from "multer";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

import { requireJwtSecret, authMiddleware, registerAuthRoutes } from "./auth.js";
import {
  MEDIA_DIR,
  createJob,
  listJobs,
  getJobById,
  getUserById,
  updateJob,
  adjustCredits,
  reserveCredits,
  reconcileJobCredits,
} from "./db.js";
import {
  MODEL_IDS,
  estimateCostCents,
  actualCostCents,
  submitJob,
  getTask,
  cancelTask,
} from "./lib/byteplus.js";

requireJwtSecret();

const ARK_API_KEY = process.env.ARK_API_KEY;
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:5173";
const PORT = process.env.PORT || 8787;

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(express.json({ limit: "64mb" }));
app.use(cookieParser());
app.use("/media", express.static(MEDIA_DIR, { maxAge: "7d" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again in a few minutes." },
});

const generateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user.id}` : req.ip),
  message: { error: "Generation rate limit reached. Wait a few minutes and try again." },
});

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user.id}` : req.ip),
  message: { error: "Upload rate limit reached. Wait a few minutes and try again." },
});

app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
registerAuthRoutes(app);

app.get("/api/health", (req, res) => {
  res.json({ ok: true, provider: "byteplus", hasKey: Boolean(ARK_API_KEY) });
});

// ---------- File inputs ----------

const INLINE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/gif",
  "image/heic",
  "image/heif",
]);
const INLINE_AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"]);

app.post("/api/upload", authMiddleware, uploadLimiter, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided (field name 'file')." });

    const contentType = req.file.mimetype || "application/octet-stream";
    const fileName = req.file.originalname || "upload";

    if (INLINE_IMAGE_TYPES.has(contentType) || INLINE_AUDIO_TYPES.has(contentType)) {
      const isImage = INLINE_IMAGE_TYPES.has(contentType);
      const maxBytes = isImage ? 20 * 1024 * 1024 : 15 * 1024 * 1024;
      if (req.file.size > maxBytes) {
        return res.status(413).json({
          error: `This ${isImage ? "image" : "audio file"} is too large for inline BytePlus upload. Use a public HTTPS URL instead.`,
        });
      }
      const normalizedType = contentType === "audio/x-wav" ? "audio/wav" : contentType;
      const dataUrl = `data:${normalizedType};base64,${req.file.buffer.toString("base64")}`;
      return res.json({ url: dataUrl, contentType: normalizedType, fileName });
    }

    if (contentType === "video/mp4" || contentType === "video/quicktime") {
      if (!PUBLIC_BASE_URL) {
        return res.status(400).json({
          error: "BytePlus requires reference videos at a public HTTPS URL. Paste a video URL, or configure PUBLIC_BASE_URL on a deployed server.",
        });
      }
      const extension = contentType === "video/quicktime" ? ".mov" : ".mp4";
      const uploadDir = path.join(MEDIA_DIR, "uploads");
      fs.mkdirSync(uploadDir, { recursive: true });
      const storedName = `${randomUUID()}${extension}`;
      await fs.promises.writeFile(path.join(uploadDir, storedName), req.file.buffer);
      return res.json({
        url: `${PUBLIC_BASE_URL}/media/uploads/${storedName}`,
        contentType,
        fileName,
      });
    }

    return res.status(415).json({ error: "Unsupported file type for BytePlus Seedance 2.0." });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Upload failed" });
  }
});

// ---------- Generation ----------

async function submitAndPersist(user, mode, tier, input) {
  const modelId = MODEL_IDS[mode]?.[tier];
  if (!modelId) {
    throw Object.assign(new Error(`Unknown mode/tier combination: ${mode}/${tier}`), { status: 400 });
  }
  if (!input.prompt) throw Object.assign(new Error("input.prompt is required"), { status: 400 });

  const duration = Number(input.duration) || 10;
  const hasVideoInput = Boolean(input.video_urls?.length);
  const estCostCents = estimateCostCents({
    tier,
    resolution: input.resolution || "720p",
    aspectRatio: input.aspect_ratio || "auto",
    durationSeconds: duration,
    hasVideoInput,
  });

  if (!reserveCredits(user.id, estCostCents)) {
    const currentUser = getUserById(user.id);
    throw Object.assign(
      new Error(
        `Not enough credit. This clip reserves up to $${(estCostCents / 100).toFixed(2)}, you have $${(
          currentUser.credits_cents / 100
        ).toFixed(2)}.`
      ),
      { status: 402 }
    );
  }

  let providerJob;
  try {
    providerJob = await submitJob(ARK_API_KEY, modelId, mode, input, `user-${user.id}`);
  } catch (error) {
    adjustCredits(user.id, estCostCents);
    throw error;
  }

  try {
    return createJob({
      user_id: user.id,
      request_id: providerJob.id,
      model_id: modelId,
      status_url: providerJob.statusUrl,
      response_url: providerJob.statusUrl,
      mode,
      tier,
      prompt: input.original_prompt || input.prompt,
      resolution: input.resolution || "720p",
      aspect_ratio: input.aspect_ratio || "auto",
      duration,
      input_json: JSON.stringify(input),
      state: "queued",
      est_cost_cents: estCostCents,
      provider: "byteplus",
    });
  } catch (error) {
    adjustCredits(user.id, estCostCents);
    cancelTask(ARK_API_KEY, providerJob.id).catch(() => {});
    throw error;
  }
}

app.post("/api/generate", authMiddleware, generateLimiter, async (req, res) => {
  try {
    if (!ARK_API_KEY) {
      return res.status(500).json({ error: "ARK_API_KEY is not configured on the server." });
    }
    const { mode = "text-to-video", tier = "standard", input = {} } = req.body || {};
    const job = await submitAndPersist(req.user, mode, tier, input);
    res.json(serializeJob(job));
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Unexpected server error" });
  }
});

app.get("/api/jobs", authMiddleware, (req, res) => {
  res.json(listJobs(req.user.id).map(serializeJob));
});

app.get("/api/jobs/:id", authMiddleware, async (req, res) => {
  try {
    const job = getJobById(req.params.id, req.user.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (["completed", "failed", "cancelled"].includes(job.state)) {
      return res.json(serializeJob(job));
    }

    const providerTask = await getTask(ARK_API_KEY, job.request_id);

    if (providerTask.status === "succeeded") {
      const videoUrl = providerTask?.content?.video_url;
      if (!videoUrl) throw new Error("BytePlus completed the task without returning a video URL.");
      const videoPath = await downloadToMedia(videoUrl, `${job.id}-${job.request_id}.mp4`);
      const input = JSON.parse(job.input_json || "{}");
      const completionTokens = Number(providerTask?.usage?.completion_tokens) || 0;
      const costCents = completionTokens
        ? actualCostCents({
            tier: job.tier,
            hasVideoInput: Boolean(input.video_urls?.length),
            completionTokens,
          })
        : job.est_cost_cents;
      updateJob(job.id, { state: "completed", video_path: videoPath, error_message: null });
      reconcileJobCredits(job.id, req.user.id, costCents, completionTokens || null);
    } else if (providerTask.status === "running") {
      updateJob(job.id, { state: "in_progress" });
    } else if (["failed", "expired", "cancelled"].includes(providerTask.status)) {
      const providerError = providerTask?.error?.message || `BytePlus task ${providerTask.status}.`;
      reconcileJobCredits(job.id, req.user.id, 0);
      updateJob(job.id, {
        state: providerTask.status === "cancelled" ? "cancelled" : "failed",
        error_message: providerError,
      });
    } else {
      updateJob(job.id, { state: "queued" });
    }

    res.json(serializeJob(getJobById(job.id, req.user.id)));
  } catch (err) {
    console.error(err);
    // A polling or download transport error does not mean the provider task failed.
    // Keep the reservation and let the client poll again.
    res.status(err.status || 503).json({ error: err.message || "BytePlus status check failed" });
  }
});

app.post("/api/jobs/:id/cancel", authMiddleware, async (req, res) => {
  try {
    const job = getJobById(req.params.id, req.user.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.state === "completed" || job.state === "cancelled") {
      return res.json(serializeJob(job));
    }
    if (job.state !== "queued") {
      return res.status(409).json({ error: "BytePlus can only cancel a task while it is still queued." });
    }

    await cancelTask(ARK_API_KEY, job.request_id);
    reconcileJobCredits(job.id, req.user.id, 0);
    updateJob(job.id, { state: "cancelled" });
    res.json(serializeJob(getJobById(job.id, req.user.id)));
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Cancel failed" });
  }
});

app.post("/api/jobs/:id/retry", authMiddleware, generateLimiter, async (req, res) => {
  try {
    if (!ARK_API_KEY) {
      return res.status(500).json({ error: "ARK_API_KEY is not configured on the server." });
    }
    const job = getJobById(req.params.id, req.user.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.state !== "failed" && job.state !== "cancelled") {
      return res.status(400).json({ error: "Only failed or cancelled jobs can be retried." });
    }
    let input;
    try {
      input = JSON.parse(job.input_json || "{}");
    } catch {
      input = {};
    }
    const newJob = await submitAndPersist(req.user, job.mode, job.tier, input);
    res.json(serializeJob(newJob));
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Retry failed" });
  }
});

// ---------- Helpers ----------

async function downloadToMedia(url, fileName) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download finished video (status ${res.status})`);
  const dest = path.join(MEDIA_DIR, fileName);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  return `/media/${fileName}`;
}

function serializeJob(job) {
  let input = {};
  try {
    input = JSON.parse(job.input_json || "{}");
  } catch {
    // Keep legacy/corrupt rows readable even if their stored input cannot be parsed.
  }
  return {
    id: job.id,
    mode: job.mode,
    tier: job.tier,
    prompt: job.prompt,
    resolution: job.resolution,
    aspectRatio: job.aspect_ratio,
    duration: job.duration,
    state: job.state,
    videoUrl: job.video_path || null,
    errorMessage: job.error_message || null,
    estCostCents: job.est_cost_cents,
    actualCostCents: job.actual_cost_cents,
    completionTokens: job.completion_tokens,
    provider: job.provider || "byteplus",
    generateAudio: input.generate_audio !== false,
    hasReferenceAudio: Boolean(input.audio_urls?.length),
    voiceCharacterCount: Array.isArray(input.voice_characters) ? input.voice_characters.length : 0,
    cancellable: job.state === "queued",
    createdAt: job.created_at,
  };
}

app.listen(PORT, () => {
  console.log(`Seedance Studio backend listening on http://localhost:${PORT}`);
  if (!ARK_API_KEY) {
    console.warn("WARNING: ARK_API_KEY is not set. Copy .env.example to .env and add your BytePlus ModelArk key.");
  }
});
