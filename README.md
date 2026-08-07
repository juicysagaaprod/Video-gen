# Seedance Studio

A Dreamina-style AI video generator built on **BytePlus ModelArk** and **Dreamina Seedance 2.0**. It supports Standard and Fast tiers, text-to-video, first/last-frame image-to-video, multimodal references, 480p/720p output, 4–15 second clips, seven aspect-ratio modes, and optional native audio.

## Architecture

- **`backend/`** — Express + SQLite (`better-sqlite3`).
  - Cookie sessions with bcrypt password hashes and signed JWTs.
  - `lib/byteplus.js` maps the app's three generation modes to ModelArk's asynchronous video-task API.
  - Jobs reserve a conservative estimated cost, then reconcile the user's credit against BytePlus's returned `usage.completion_tokens` when generation completes.
  - Finished videos are downloaded into `backend/data/media/` so history does not depend on expiring provider URLs.
  - Per-user upload/generation rate limits and single-origin CORS protection.
- **`frontend/`** — Vite + React.
  - Authentication, generation controls, multimodal inputs, live polling, queued-job cancellation, retries, credit balance, and a persistent gallery.

## BytePlus modes

- **Text → Video** — prompt only.
- **Image → Video** — first-frame image, with an optional last-frame image.
- **Reference → Video** — up to 9 reference images, 3 reference videos, and 3 reference audio clips. Prompt references use `[Image 1]`, `[Video 1]`, and `[Audio 1]`.

Enable **AI-generated audio** to ask Seedance for synchronized ambience, sound effects, music, or dialogue from the prompt. In Reference mode, uploaded audio includes an in-browser preview and can guide the output when paired with at least one reference image or video; BytePlus does not accept audio as the only reference input.

The **Character voices** editor supports up to four speaking characters per clip. Each character can have a name, language, regional accent, vocal description, exact dialogue, and—when using Reference mode—an assigned `[Audio N]` voice-timbre sample. The frontend compiles these fields into Seedance dialogue instructions and asks the model to preserve speaker assignment and lip synchronization.

BytePlus requires approved ModelArk assets for real-person faces. The normal upload flow is intended for non-real-person images and media you have the rights to use.

## Local setup

### 1. Activate Dreamina Seedance 2.0

In the [BytePlus ModelArk console](https://console.byteplus.com/ark/region:ark+ap-southeast-1), purchase/activate a Dreamina Seedance 2.0 resource pack, then create a long-lived key on the [API keys page](https://console.byteplus.com/ark/region:ark+ap-southeast-1/apikey).

The app uses these model IDs:

- Standard: `dreamina-seedance-2-0-260128`
- Fast: `dreamina-seedance-2-0-fast-260128`

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env
```

Set the required values in `backend/.env`:

```dotenv
ARK_API_KEY=your_byteplus_modelark_api_key
JWT_SECRET=a_long_random_secret
ALLOWED_ORIGIN=http://localhost:5173
```

Then start the API:

```bash
npm run dev
```

It listens on `http://localhost:8787`.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

## Media inputs

- Images and audio selected locally are sent to BytePlus as Base64 data URLs. The full ModelArk request must remain below 64 MB.
- Reference videos must be public HTTP(S) URLs or ModelArk `asset://` URIs. In local development, add them with the URL field.
- A deployed instance may set `PUBLIC_BASE_URL=https://your-domain.example`; local video uploads are then stored under `/media/uploads/` and returned as public URLs.
- For durable production storage, use BytePlus TOS or another private object store with appropriately scoped access instead of relying on the local filesystem.

## Credit accounting

Every account starts with $5.00 of application credit. Before submission, the app reserves a conservative maximum based on model tier, resolution, aspect ratio, duration, and the maximum permitted reference-video duration. On successful completion, it replaces that estimate with the actual BytePlus token charge and refunds the difference. Failed or successfully cancelled queued jobs receive a full reservation refund.

This application credit is an internal spending guard; it does not add funds to the BytePlus account.

## Docker

```bash
docker compose up --build
```

The app is served at `http://localhost:8080`. Configure `ARK_API_KEY`, `JWT_SECRET`, `ALLOWED_ORIGIN`, and (for reference-video uploads) `PUBLIC_BASE_URL` in `backend/.env` before deployment.

## Netlify deployment

The Netlify build deploys the Vite frontend and a same-origin `/api/*` Function. Production users, jobs, credit balances, uploads, and completed MP4s are persisted in Netlify Blobs; local development continues to use Express and SQLite.

Set `ARK_API_KEY` and `JWT_SECRET` as secret Netlify environment variables before deploying. Netlify's binary Function request limit means direct uploads are capped at 4 MB in production; larger reference files should use public HTTP(S) or ModelArk `asset://` URLs. Generated MP4 responses are streamed from Netlify Blobs and should remain below Netlify's 20 MB streamed-response limit.

## Operational limits

- BytePlus can cancel only tasks that are still `queued`; running tasks continue to completion and are billed normally.
- ModelArk task records and provider output URLs are temporary, so completed videos are copied locally during polling.
- There are no webhooks yet; the browser polls the backend, and the backend polls ModelArk.
- SQLite is suitable for a single backend instance. Use Postgres and a background worker before scaling horizontally.
- Email verification, password reset, payment/top-up flows, and weekly budget enforcement are not yet implemented.
