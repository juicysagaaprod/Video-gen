const DEFAULT_ARK_BASE = "https://ark.ap-southeast.bytepluses.com/api/v3";

export const MODEL_IDS = {
  "text-to-video": {
    standard: "dreamina-seedance-2-0-260128",
    fast: "dreamina-seedance-2-0-fast-260128",
  },
  "image-to-video": {
    standard: "dreamina-seedance-2-0-260128",
    fast: "dreamina-seedance-2-0-fast-260128",
  },
  "reference-to-video": {
    standard: "dreamina-seedance-2-0-260128",
    fast: "dreamina-seedance-2-0-fast-260128",
  },
};

// BytePlus ModelArk online-inference prices in USD per million completion tokens.
const TOKEN_RATES = {
  standard: { withoutVideo: 7.0, withVideo: 4.3 },
  fast: { withoutVideo: 5.6, withVideo: 3.3 },
};

// Seedance 2.0 output dimensions from the ModelArk video-generation API docs.
const DIMENSIONS = {
  "480p": {
    "16:9": [864, 496],
    "4:3": [752, 560],
    "1:1": [640, 640],
    "3:4": [560, 752],
    "9:16": [496, 864],
    "21:9": [992, 432],
  },
  "720p": {
    "16:9": [1280, 720],
    "4:3": [1112, 834],
    "1:1": [960, 960],
    "3:4": [834, 1112],
    "9:16": [720, 1280],
    "21:9": [1470, 630],
  },
};

function dimensionsFor(resolution, ratio) {
  const byRatio = DIMENSIONS[resolution] || DIMENSIONS["720p"];
  if (ratio && ratio !== "auto" && ratio !== "adaptive" && byRatio[ratio]) {
    return byRatio[ratio];
  }
  return Object.values(byRatio).reduce((largest, candidate) =>
    candidate[0] * candidate[1] > largest[0] * largest[1] ? candidate : largest
  );
}

function tokenRate(tier, hasVideoInput) {
  const rates = TOKEN_RATES[tier] || TOKEN_RATES.standard;
  return hasVideoInput ? rates.withVideo : rates.withoutVideo;
}

export function estimateCostCents({
  tier,
  resolution,
  aspectRatio,
  durationSeconds,
  hasVideoInput = false,
  maxInputVideoSeconds = 15,
}) {
  const [width, height] = dimensionsFor(resolution, aspectRatio);
  const billedSeconds = Number(durationSeconds) + (hasVideoInput ? maxInputVideoSeconds : 0);
  const tokens = (width * height * billedSeconds * 24) / 1024;
  return Math.ceil((tokens / 1_000_000) * tokenRate(tier, hasVideoInput) * 100);
}

export function actualCostCents({ tier, hasVideoInput = false, completionTokens = 0 }) {
  return Math.ceil((Number(completionTokens) / 1_000_000) * tokenRate(tier, hasVideoInput) * 100);
}

function normalizeReferenceTags(prompt) {
  return String(prompt || "")
    .replace(/@Image(\d+)/gi, "[Image $1]")
    .replace(/@Video(\d+)/gi, "[Video $1]")
    .replace(/@Audio(\d+)/gi, "[Audio $1]");
}

function buildContent(mode, input) {
  const content = [{ type: "text", text: normalizeReferenceTags(input.prompt) }];

  if (mode === "image-to-video") {
    if (!input.image_url) throw Object.assign(new Error("A source image is required."), { status: 400 });
    content.push({
      type: "image_url",
      image_url: { url: input.image_url },
      role: "first_frame",
    });
    if (input.end_image_url) {
      content.push({
        type: "image_url",
        image_url: { url: input.end_image_url },
        role: "last_frame",
      });
    }
  }

  if (mode === "reference-to-video") {
    if (!(input.image_urls?.length || input.video_urls?.length)) {
      throw Object.assign(
        new Error("BytePlus reference mode requires at least one image or video; audio cannot be used alone."),
        { status: 400 }
      );
    }
    for (const url of input.image_urls || []) {
      content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
    }
    for (const url of input.video_urls || []) {
      content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
    }
    for (const url of input.audio_urls || []) {
      content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
    }
  }

  return content;
}

export function buildTaskRequest(modelId, mode, input, safetyIdentifier) {
  return {
    model: modelId,
    content: buildContent(mode, input),
    resolution: input.resolution || "720p",
    ratio: input.aspect_ratio === "auto" ? "adaptive" : input.aspect_ratio || "adaptive",
    duration: Number(input.duration) || 10,
    generate_audio: input.generate_audio !== false,
    watermark: false,
    ...(safetyIdentifier ? { safety_identifier: safetyIdentifier } : {}),
  };
}

function arkBaseUrl() {
  return String(process.env.BYTEPLUS_BASE_URL || DEFAULT_ARK_BASE).replace(/\/$/, "");
}

function taskUrl(taskId = "") {
  return `${arkBaseUrl()}/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`;
}

async function safeJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

export function friendlyBytePlusError(status, data) {
  const raw = JSON.stringify(data || {}).toLowerCase();
  const providerMessage = data?.error?.message || data?.message || data?.detail;
  if (raw.includes("insufficient") || raw.includes("balance") || raw.includes("resource pack")) {
    return "Your BytePlus ModelArk balance or Seedance resource pack is insufficient. Add credit or activate the model in the ModelArk console.";
  }
  if (raw.includes("moderation") || raw.includes("safety") || raw.includes("content policy") || raw.includes("risk")) {
    return "BytePlus blocked this request during safety review. Adjust the prompt or reference assets and try again.";
  }
  if (raw.includes("real human") || raw.includes("portrait") || raw.includes("face")) {
    return "BytePlus requires approved assets for real-person faces. Use a verified ModelArk asset or a permitted generated character.";
  }
  if (status === 401 || status === 403) {
    return "BytePlus rejected the ModelArk API key or the Seedance model is not activated. Check ARK_API_KEY and model access.";
  }
  if (status === 429) {
    return "BytePlus rate-limited this request. Wait a moment or raise the ModelArk quota before trying again.";
  }
  return providerMessage || `BytePlus ModelArk returned HTTP ${status}.`;
}

async function fetchWithRetry(url, options = {}, { retries = 2, baseDelayMs = 600 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, options);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
        continue;
      }
      return res;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
        continue;
      }
    }
  }
  throw lastError || new Error("BytePlus request failed after retries.");
}

function authHeaders(apiKey, json = false) {
  return {
    Authorization: `Bearer ${apiKey}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

export async function submitJob(apiKey, modelId, mode, input, safetyIdentifier) {
  const request = buildTaskRequest(modelId, mode, input, safetyIdentifier);
  const res = await fetchWithRetry(taskUrl(), {
    method: "POST",
    headers: authHeaders(apiKey, true),
    body: JSON.stringify(request),
  });
  const data = await safeJson(res);
  if (!res.ok) {
    throw Object.assign(new Error(friendlyBytePlusError(res.status, data)), {
      status: res.status,
      providerStatus: res.status,
      raw: data,
    });
  }
  if (!data.id) throw new Error("BytePlus created a task without returning a task ID.");
  return { id: data.id, statusUrl: taskUrl(data.id) };
}

export async function getTask(apiKey, taskId) {
  const res = await fetchWithRetry(taskUrl(taskId), { headers: authHeaders(apiKey) });
  const data = await safeJson(res);
  if (!res.ok) {
    throw Object.assign(new Error(friendlyBytePlusError(res.status, data)), {
      status: res.status,
      providerStatus: res.status,
      raw: data,
    });
  }
  return data;
}

export async function cancelTask(apiKey, taskId) {
  const res = await fetchWithRetry(taskUrl(taskId), {
    method: "DELETE",
    headers: authHeaders(apiKey, true),
  });
  const data = await safeJson(res);
  if (!res.ok) {
    throw Object.assign(new Error(friendlyBytePlusError(res.status, data)), {
      status: res.status,
      providerStatus: res.status,
      raw: data,
    });
  }
  return true;
}

export { DIMENSIONS, TOKEN_RATES };
