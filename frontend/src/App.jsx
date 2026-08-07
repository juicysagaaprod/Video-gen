import { useEffect, useRef, useState } from "react";
import AuthScreen from "./AuthScreen.jsx";

const RATIOS = ["auto", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const RESOLUTIONS = ["480p", "720p"];
const POLL_INTERVAL_MS = 4000;
const REF_LIMITS = { image: 9, video: 3, audio: 3 };
const MAX_VOICE_CHARACTERS = 4;
const PENDING_STATES = new Set(["queued", "in_progress"]);

const BYTEPLUS_DIMENSIONS = {
  "480p": {
    "16:9": [864, 496], "4:3": [752, 560], "1:1": [640, 640],
    "3:4": [560, 752], "9:16": [496, 864], "21:9": [992, 432],
  },
  "720p": {
    "16:9": [1280, 720], "4:3": [1112, 834], "1:1": [960, 960],
    "3:4": [834, 1112], "9:16": [720, 1280], "21:9": [1470, 630],
  },
};

const BYTEPLUS_TOKEN_RATES = {
  standard: { withoutVideo: 7.0, withVideo: 4.3 },
  fast: { withoutVideo: 5.6, withVideo: 3.3 },
};

function estimatedBytePlusCost(tier, resolution, ratio, duration, hasVideoInput) {
  const dimensions = BYTEPLUS_DIMENSIONS[resolution] || BYTEPLUS_DIMENSIONS["720p"];
  const [width, height] = dimensions[ratio] || Object.values(dimensions).reduce((largest, candidate) =>
    candidate[0] * candidate[1] > largest[0] * largest[1] ? candidate : largest
  );
  const rate = BYTEPLUS_TOKEN_RATES[tier] || BYTEPLUS_TOKEN_RATES.standard;
  const costForSeconds = (seconds, perMillion) =>
    ((width * height * seconds * 24) / 1024 / 1_000_000) * perMillion;
  if (!hasVideoInput) return `$${costForSeconds(duration, rate.withoutVideo).toFixed(2)}`;
  return `$${costForSeconds(duration + 2, rate.withVideo).toFixed(2)}–$${costForSeconds(duration + 15, rate.withVideo).toFixed(2)}`;
}

function ratioGlyph(ratio) {
  const map = {
    "16:9": { w: 16, h: 9 },
    "9:16": { w: 9, h: 16 },
    "1:1": { w: 12, h: 12 },
    "4:3": { w: 14, h: 10.5 },
    "3:4": { w: 10.5, h: 14 },
    "21:9": { w: 18, h: 7.7 },
    auto: { w: 13, h: 13 },
  };
  const { w, h } = map[ratio] || map.auto;
  const scale = 16 / Math.max(w, h);
  return <span className="ratio-glyph" style={{ width: `${w * scale}px`, height: `${h * scale}px` }} />;
}

async function uploadFile(file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: form, credentials: "include" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Upload of ${file.name} failed`);
  return { url: data.url, name: file.name };
}

function UploadZone({ accept, multiple, max, items, onAdd, onRemove, label, kind }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const room = max ? max - items.length : files.length;
    if (room <= 0) {
      setError(`Max ${max} reached`);
      return;
    }
    const toUpload = files.slice(0, room);
    setBusy(true);
    setError("");
    try {
      for (const file of toUpload) {
        const uploaded = await uploadFile(file);
        onAdd({ ...uploaded, kind });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="upload-zone-wrap">
      <div
        className={`upload-zone ${dragOver ? "drag" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          hidden
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <span>{busy ? "Uploading…" : label}</span>
        {max && (
          <span className="upload-zone-count">
            {items.length}/{max}
          </span>
        )}
      </div>
      {error && <div className="upload-error">{error}</div>}
      {items.length > 0 && (
        <div className="ref-chip-list">
          {items.map((item, i) => (
            <div className={`ref-chip ${kind === "audio" ? "ref-chip-with-audio" : ""}`} key={`${item.name}-${i}`}>
              <div className="ref-chip-main">
                <span className="ref-chip-label">
                  {kind === "image" ? "Image" : kind === "video" ? "Video" : "Audio"}
                  {i + 1}
                </span>
                <span className="ref-chip-name">{item.name}</span>
                <button type="button" onClick={() => onRemove(i)} aria-label={`Remove ${item.name}`}>
                  ×
                </button>
              </div>
              {kind === "audio" && <audio className="audio-preview" src={item.url} controls preload="metadata" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UrlAdder({ kind, onAdd }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  function addUrl() {
    const url = value.trim();
    if (!/^(https?:\/\/|asset:\/\/)/i.test(url)) {
      setError("Use a public HTTP(S) URL or a BytePlus asset:// URI.");
      return;
    }
    const label = url.startsWith("asset://") ? url : url.split("/").pop()?.split("?")[0] || `${kind} URL`;
    onAdd({ url, name: label, kind });
    setValue("");
    setError("");
  }

  return (
    <div className="url-adder">
      <input
        type="url"
        value={value}
        placeholder={`Public ${kind} URL or asset:// URI`}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            addUrl();
          }
        }}
      />
      <button type="button" onClick={addUrl}>Add URL</button>
      {error && <div className="upload-error">{error}</div>}
    </div>
  );
}

function compileVoiceDirection(characters, referenceAudio, mode) {
  if (!characters.length) return "";
  const directions = characters.map((character, index) => {
    const name = character.name.trim();
    const language = character.language.trim();
    const accent = character.accent.trim();
    const voice = character.voice.trim();
    const dialogue = character.dialogue.replace(/[{}]/g, "").trim();
    const traits = [language && `speaks in ${language}`, accent && `with a ${accent} regional accent`, voice]
      .filter(Boolean)
      .join(", ");
    const audioIndex = Number(character.audioRef);
    const audioReference =
      mode === "reference-to-video" && audioIndex > 0 && referenceAudio[audioIndex - 1]
        ? ` Use the voice timbre of [Audio ${audioIndex}] for ${name}.`
        : "";
    return `${index + 1}. ${name}: ${traits || "a clearly distinctive natural voice"}.${audioReference} ${name} says in ${
      language || "the requested language"
    } {${dialogue}}.`;
  });

  return [
    "Voice and dialogue direction:",
    ...directions,
    "Keep every character's voice clearly distinct. Match each line to the correct visible speaker with accurate lip synchronization. Do not swap voices or add a narrator.",
  ].join("\n");
}

function VoiceDirector({ characters, onAdd, onUpdate, onRemove, referenceAudio, mode }) {
  return (
    <div className="voice-director">
      <div className="voice-director-header">
        <div>
          <span className="field-label">Character voices</span>
          <span className="field-help">Define language, regional accent, vocal character, and exact dialogue.</span>
        </div>
        <button type="button" className="voice-add-btn" onClick={onAdd} disabled={characters.length >= MAX_VOICE_CHARACTERS}>
          + Character
        </button>
      </div>

      {characters.length === 0 ? (
        <div className="voice-empty">Optional. Add up to {MAX_VOICE_CHARACTERS} speaking characters.</div>
      ) : (
        <div className="voice-card-list">
          {characters.map((character, index) => (
            <div className="voice-card" key={character.id}>
              <div className="voice-card-header">
                <span>Character {index + 1}</span>
                <button type="button" onClick={() => onRemove(character.id)} aria-label={`Remove character ${index + 1}`}>
                  ×
                </button>
              </div>
              <div className="voice-field-grid">
                <label>
                  <span>Name</span>
                  <input
                    type="text"
                    value={character.name}
                    placeholder="e.g. Maya"
                    onChange={(e) => onUpdate(character.id, { name: e.target.value })}
                  />
                </label>
                <label>
                  <span>Language</span>
                  <input
                    type="text"
                    value={character.language}
                    placeholder="e.g. Japanese"
                    onChange={(e) => onUpdate(character.id, { language: e.target.value })}
                  />
                </label>
                <label>
                  <span>Regional accent</span>
                  <input
                    type="text"
                    value={character.accent}
                    placeholder="e.g. Jamaican English"
                    onChange={(e) => onUpdate(character.id, { accent: e.target.value })}
                  />
                </label>
                <label>
                  <span>Voice description</span>
                  <input
                    type="text"
                    value={character.voice}
                    placeholder="Warm, low, confident, measured pace"
                    onChange={(e) => onUpdate(character.id, { voice: e.target.value })}
                  />
                </label>
                {mode === "reference-to-video" && (
                  <label className="voice-field-full">
                    <span>Reference voice</span>
                    <select value={character.audioRef} onChange={(e) => onUpdate(character.id, { audioRef: e.target.value })}>
                      <option value="">No voice reference</option>
                      {referenceAudio.map((item, audioIndex) => (
                        <option key={`${item.name}-${audioIndex}`} value={audioIndex + 1}>
                          Audio {audioIndex + 1} · {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="voice-field-full">
                  <span>Dialogue</span>
                  <textarea
                    value={character.dialogue}
                    maxLength={320}
                    placeholder="Enter only this character's spoken line"
                    onChange={(e) => onUpdate(character.id, { dialogue: e.target.value })}
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="voice-note">Use a specific region or language variety rather than a broad ethnic label. Mixed-language dialogue may require retries.</div>
    </div>
  );
}

function CreditsPill({ creditsCents }) {
  const dollars = (creditsCents / 100).toFixed(2);
  const low = creditsCents < 100;
  return (
    <span className={`status-pill credits-pill ${low ? "low" : ""}`}>
      <span className={`status-dot ${low ? "" : "ok"}`} />${dollars} credit
    </span>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [mode, setMode] = useState("text-to-video");
  const [tier, setTier] = useState("standard");
  const [prompt, setPrompt] = useState("");

  const [imageItem, setImageItem] = useState(null);
  const [endImageItem, setEndImageItem] = useState(null);
  const [manualImageUrl, setManualImageUrl] = useState("");

  const [refImages, setRefImages] = useState([]);
  const [refVideos, setRefVideos] = useState([]);
  const [refAudio, setRefAudio] = useState([]);

  const [resolution, setResolution] = useState("720p");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [duration, setDuration] = useState(10);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [voiceCharacters, setVoiceCharacters] = useState([]);
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState([]);

  const promptRef = useRef(null);
  const pollTimers = useRef({});

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => setUser(u))
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (!user) return;
    fetch("/api/jobs", { credentials: "include" })
      .then((r) => r.json())
      .then((list) => {
        setJobs(list);
        list.filter((j) => PENDING_STATES.has(j.state)).forEach(pollJob);
      });
    return () => Object.values(pollTimers.current).forEach(clearInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  function insertTag(tag) {
    setPrompt((p) => (p ? `${p.trim()} ${tag}` : tag));
    promptRef.current?.focus();
  }

  function addVoiceCharacter() {
    setGenerateAudio(true);
    setVoiceCharacters((current) =>
      current.length >= MAX_VOICE_CHARACTERS
        ? current
        : [
            ...current,
            {
              id: `voice-${Date.now()}-${current.length}`,
              name: "",
              language: "English",
              accent: "",
              voice: "",
              dialogue: "",
              audioRef: "",
            },
          ]
    );
  }

  function updateVoiceCharacter(id, patch) {
    setVoiceCharacters((current) => current.map((character) => (character.id === id ? { ...character, ...patch } : character)));
  }

  function updateJob(id, patch) {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }

  function refreshCredits() {
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => u && setUser(u));
  }

  function pollJob(job) {
    if (pollTimers.current[job.id]) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${job.id}`, { credentials: "include" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Status check failed");
        updateJob(job.id, data);
        if (!PENDING_STATES.has(data.state)) {
          clearInterval(pollTimers.current[job.id]);
          delete pollTimers.current[job.id];
          refreshCredits();
        }
      } catch (err) {
        // A transient provider/status failure does not mean the task itself failed.
        updateJob(job.id, { errorMessage: err.message });
      }
    }, POLL_INTERVAL_MS);
    pollTimers.current[job.id] = timer;
  }

  async function cancelJob(jobId) {
    updateJob(jobId, { state: "cancelling" });
    try {
      const res = await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Cancel failed");
      updateJob(jobId, data);
      if (pollTimers.current[jobId]) {
        clearInterval(pollTimers.current[jobId]);
        delete pollTimers.current[jobId];
      }
      refreshCredits();
    } catch (err) {
      setError(err.message);
    }
  }

  async function retryJob(jobId) {
    setError("");
    try {
      const res = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Retry failed");
      setJobs((prev) => [data, ...prev]);
      pollJob(data);
      refreshCredits();
    } catch (err) {
      setError(err.message);
    }
  }

  const needsConsent = mode === "image-to-video" || mode === "reference-to-video";

  async function handleGenerate() {
    setError("");
    if (!prompt.trim()) {
      setError("Write a prompt before generating.");
      return;
    }
    if (needsConsent && !consent) {
      setError("Confirm you have the rights to use the uploaded files before generating.");
      return;
    }

    const activeVoiceCharacters = generateAudio ? voiceCharacters : [];
    if (activeVoiceCharacters.some((character) => !character.name.trim() || !character.dialogue.trim())) {
      setError("Every character voice needs a name and dialogue, or remove the incomplete character.");
      return;
    }

    const voiceDirection = compileVoiceDirection(activeVoiceCharacters, refAudio, mode);
    const originalPrompt = prompt.trim();

    const input = {
      prompt: voiceDirection ? `${originalPrompt}\n\n${voiceDirection}` : originalPrompt,
      original_prompt: originalPrompt,
      resolution,
      duration: String(duration),
      aspect_ratio: aspectRatio,
      generate_audio: generateAudio,
    };
    if (activeVoiceCharacters.length) {
      input.voice_characters = activeVoiceCharacters.map(({ id, ...character }) => character);
    }

    if (mode === "image-to-video") {
      const url = imageItem?.url || manualImageUrl.trim();
      if (!url) {
        setError("Upload a source image or paste an image URL.");
        return;
      }
      input.image_url = url;
      if (endImageItem?.url) input.end_image_url = endImageItem.url;
    }

    if (mode === "reference-to-video") {
      const totalFiles = refImages.length + refVideos.length + refAudio.length;
      if (totalFiles === 0) {
        setError("Add at least one reference image, video, or audio file.");
        return;
      }
      if (refImages.length === 0 && refVideos.length === 0) {
        setError("BytePlus reference mode requires at least one image or video; audio cannot be used alone.");
        return;
      }
      if (refImages.length) input.image_urls = refImages.map((i) => i.url);
      if (refVideos.length) input.video_urls = refVideos.map((i) => i.url);
      if (refAudio.length) input.audio_urls = refAudio.map((i) => i.url);
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mode, tier, input }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation request failed");

      setJobs((prev) => [data, ...prev]);
      pollJob(data);
      refreshCredits();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const estCost = estimatedBytePlusCost(
    tier,
    resolution,
    aspectRatio,
    duration,
    mode === "reference-to-video" && refVideos.length > 0
  );

  if (!authChecked) return null;
  if (!user) return <AuthScreen onAuthed={setUser} />;

  return (
    <div className="app-shell">
      <div className="sprocket-margin" aria-hidden="true" />
      <div className="app-main">
        <header className="topbar">
          <div>
            <div className="wordmark">
              Seedance <span>Studio</span>
            </div>
            <div className="tagline">{user.email} · BytePlus ModelArk</div>
          </div>
          <div className="topbar-right">
            <CreditsPill creditsCents={user.creditsCents} />
            <button
              className="signout-btn"
              onClick={() =>
                fetch("/api/auth/logout", { method: "POST", credentials: "include" }).then(() => {
                  setUser(null);
                  setJobs([]);
                })
              }
            >
              Sign out
            </button>
          </div>
        </header>

        <div className="workspace">
          <aside className="control-panel">
            <div className="field-group">
              <span className="field-label">Mode</span>
              <div className="mode-tabs mode-tabs-3">
                <button className={mode === "text-to-video" ? "active" : ""} onClick={() => setMode("text-to-video")}>
                  Text
                </button>
                <button className={mode === "image-to-video" ? "active" : ""} onClick={() => setMode("image-to-video")}>
                  Image
                </button>
                <button
                  className={mode === "reference-to-video" ? "active" : ""}
                  onClick={() => setMode("reference-to-video")}
                >
                  Reference
                </button>
              </div>
            </div>

            <div className="field-group">
              <span className="field-label">Model tier</span>
              <div className="tier-toggle">
                <label className={tier === "standard" ? "selected" : ""}>
                  <input type="radio" name="tier" checked={tier === "standard"} onChange={() => setTier("standard")} />
                  <span className="tier-name">Standard</span>
                  <span className="tier-sub">Seedance 2.0 · highest quality</span>
                </label>
                <label className={tier === "fast" ? "selected" : ""}>
                  <input type="radio" name="tier" checked={tier === "fast"} onChange={() => setTier("fast")} />
                  <span className="tier-name">Fast</span>
                  <span className="tier-sub">Seedance 2.0 Fast · lower cost</span>
                </label>
              </div>
            </div>

            {mode === "image-to-video" && (
              <div className="field-group">
                <span className="field-label">Source image</span>
                <UploadZone
                  accept="image/*"
                  max={1}
                  kind="image"
                  items={imageItem ? [imageItem] : []}
                  onAdd={(item) => setImageItem(item)}
                  onRemove={() => setImageItem(null)}
                  label="Click or drop an image"
                />
                <input
                  type="url"
                  placeholder="…or paste an image URL"
                  value={manualImageUrl}
                  onChange={(e) => setManualImageUrl(e.target.value)}
                  style={{ marginTop: 4 }}
                />
              </div>
            )}

            {mode === "image-to-video" && (
              <div className="field-group">
                <span className="field-label">End frame (optional, for a transition)</span>
                <UploadZone
                  accept="image/*"
                  max={1}
                  kind="image"
                  items={endImageItem ? [endImageItem] : []}
                  onAdd={(item) => setEndImageItem(item)}
                  onRemove={() => setEndImageItem(null)}
                  label="Click or drop an end-frame image"
                />
              </div>
            )}

            {mode === "reference-to-video" && (
              <>
                <div className="field-group">
                  <span className="field-label">Reference images (up to {REF_LIMITS.image})</span>
                  <UploadZone
                    accept="image/*"
                    multiple
                    max={REF_LIMITS.image}
                    kind="image"
                    items={refImages}
                    onAdd={(item) => setRefImages((prev) => [...prev, item])}
                    onRemove={(i) => setRefImages((prev) => prev.filter((_, idx) => idx !== i))}
                    label="Click or drop images"
                  />
                  <UrlAdder
                    kind="image"
                    onAdd={(item) => setRefImages((prev) => prev.length < REF_LIMITS.image ? [...prev, item] : prev)}
                  />
                </div>
                <div className="field-group">
                  <span className="field-label">Reference videos (up to {REF_LIMITS.video})</span>
                  <UploadZone
                    accept="video/*"
                    multiple
                    max={REF_LIMITS.video}
                    kind="video"
                    items={refVideos}
                    onAdd={(item) => setRefVideos((prev) => [...prev, item])}
                    onRemove={(i) => setRefVideos((prev) => prev.filter((_, idx) => idx !== i))}
                    label="Click or drop videos"
                  />
                  <UrlAdder
                    kind="video"
                    onAdd={(item) => setRefVideos((prev) => prev.length < REF_LIMITS.video ? [...prev, item] : prev)}
                  />
                </div>
                <div className="field-group">
                  <span className="field-label">Reference audio (up to {REF_LIMITS.audio})</span>
                  <span className="field-help">
                    Optional music, dialogue, or ambience. Add at least one reference image or video, then use [Audio 1] in
                    your prompt.
                  </span>
                  <UploadZone
                    accept="audio/*"
                    multiple
                    max={REF_LIMITS.audio}
                    kind="audio"
                    items={refAudio}
                    onAdd={(item) => setRefAudio((prev) => [...prev, item])}
                    onRemove={(i) => setRefAudio((prev) => prev.filter((_, idx) => idx !== i))}
                    label="Click or drop audio"
                  />
                  <UrlAdder
                    kind="audio"
                    onAdd={(item) => setRefAudio((prev) => prev.length < REF_LIMITS.audio ? [...prev, item] : prev)}
                  />
                </div>
                {(refImages.length > 0 || refVideos.length > 0 || refAudio.length > 0) && (
                  <div className="field-group">
                    <span className="field-label">Insert reference tag</span>
                    <div className="tag-insert-row">
                      {refImages.map((_, i) => (
                        <button key={`i${i}`} type="button" onClick={() => insertTag(`[Image ${i + 1}]`)}>
                          [Image {i + 1}]
                        </button>
                      ))}
                      {refVideos.map((_, i) => (
                        <button key={`v${i}`} type="button" onClick={() => insertTag(`[Video ${i + 1}]`)}>
                          [Video {i + 1}]
                        </button>
                      ))}
                      {refAudio.map((_, i) => (
                        <button key={`a${i}`} type="button" onClick={() => insertTag(`[Audio ${i + 1}]`)}>
                          [Audio {i + 1}]
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="field-group">
              <span className="field-label">Prompt</span>
              <textarea
                ref={promptRef}
                placeholder={
                  mode === "reference-to-video"
                    ? "[Image 1] walks confidently down a neon-lit street at night, camera tracking alongside. Cut scene to…"
                    : "Subject + action + camera + lighting + style. E.g. Slow dolly push in on a lighthouse at dusk, waves crashing, warm amber light sweeping across the lens, cinematic film grain."
                }
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                maxLength={1200}
              />
              <div className="char-count">{prompt.length}/1200</div>
            </div>

            <div className="field-group">
              <span className="field-label">Resolution</span>
              <div className="chip-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                {RESOLUTIONS.map((r) => (
                  <button key={r} className={`chip ${resolution === r ? "selected" : ""}`} onClick={() => setResolution(r)}>
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <div className="field-group">
              <span className="field-label">Aspect ratio</span>
              <div className="chip-grid ratios">
                {RATIOS.map((r) => (
                  <button key={r} className={`chip ${aspectRatio === r ? "selected" : ""}`} onClick={() => setAspectRatio(r)}>
                    {ratioGlyph(r)}
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <div className="field-group">
              <span className="field-label">Duration</span>
              <div className="slider-row">
                <input type="range" min={4} max={15} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
                <span className="slider-value">{duration}s</span>
              </div>
            </div>

            <div className="field-group audio-options-panel">
              <div className="toggle-row">
                <div className="audio-option-copy">
                  <span className="field-label" style={{ marginBottom: 0 }}>
                    AI-generated audio
                  </span>
                  <span className="field-help">Create synchronized ambience, effects, music, or dialogue from the prompt.</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-label="Generate synchronized audio"
                    checked={generateAudio}
                    onChange={(e) => setGenerateAudio(e.target.checked)}
                  />
                  <span className="track" />
                </label>
              </div>
              {generateAudio && (
                <VoiceDirector
                  characters={voiceCharacters}
                  onAdd={addVoiceCharacter}
                  onUpdate={updateVoiceCharacter}
                  onRemove={(id) => setVoiceCharacters((current) => current.filter((character) => character.id !== id))}
                  referenceAudio={refAudio}
                  mode={mode}
                />
              )}
            </div>

            {needsConsent && (
              <label className="consent-row">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>I have the rights to use the uploaded image, video, and audio files in this generation.</span>
              </label>
            )}

            {error && <div className="error-banner">{error}</div>}

            <button className="generate-btn" onClick={handleGenerate} disabled={submitting}>
              {submitting ? "Submitting…" : "Generate video"}
            </button>
            <div className="cost-hint">BytePlus estimate: {estCost} for this clip</div>
          </aside>

          <main className="gallery">
            <div className="gallery-header">
              <h2>Generations</h2>
              <span className="gallery-count">
                {jobs.length} clip{jobs.length === 1 ? "" : "s"}
              </span>
            </div>

            {jobs.length === 0 ? (
              <div className="empty-state">
                <span className="empty-glyph">Roll camera.</span>
                Your generated clips will appear here as they render.
              </div>
            ) : (
              <div className="job-grid">
                {jobs.map((job) => (
                  <div className="job-card" key={job.id}>
                    <div
                      className={`job-sprockets ${PENDING_STATES.has(job.state) ? "pending" : ""}`}
                      aria-hidden="true"
                    />
                    <div className="job-body">
                      <div className="job-media">
                        {job.state === "completed" && job.videoUrl ? (
                          <video src={job.videoUrl} controls loop />
                        ) : job.state === "failed" ? (
                          <div className="placeholder">{job.errorMessage || "Generation failed"}</div>
                        ) : job.state === "cancelled" ? (
                          <div className="placeholder">Cancelled</div>
                        ) : (
                          <div className="placeholder">
                            {job.state === "in_progress" ? "Rendering…" : job.state === "cancelling" ? "Cancelling…" : "Queued…"}
                          </div>
                        )}
                      </div>
                      <div className="job-meta">
                        <div className="job-prompt">{job.prompt}</div>
                        <div className="job-tags">
                          <span>{job.tier}</span>
                          <span>{job.resolution}</span>
                          <span>{job.aspectRatio}</span>
                          <span>{job.duration}s</span>
                          <span>{job.generateAudio ? "AI audio" : "silent"}</span>
                          {job.voiceCharacterCount > 0 && (
                            <span>
                              {job.voiceCharacterCount} character voice{job.voiceCharacterCount === 1 ? "" : "s"}
                            </span>
                          )}
                          {job.hasReferenceAudio && <span>reference audio</span>}
                          {job.state === "completed" && job.actualCostCents != null && (
                            <span>${(job.actualCostCents / 100).toFixed(2)}</span>
                          )}
                        </div>
                        <div className="job-footer">
                          <span className={`job-state ${job.state}`}>{job.state.replace("_", " ")}</span>
                          {job.state === "completed" && job.videoUrl && (
                            <a className="download-link" href={job.videoUrl} download target="_blank" rel="noreferrer">
                              download
                            </a>
                          )}
                          {job.cancellable && (
                            <button className="cancel-link" onClick={() => cancelJob(job.id)}>
                              cancel
                            </button>
                          )}
                          {(job.state === "failed" || job.state === "cancelled") && (
                            <button className="cancel-link" onClick={() => retryJob(job.id)}>
                              retry
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
