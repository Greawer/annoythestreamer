# AnnoyTheStreamer 2.0

The current 2.0 alpha is an interactive streamer website built with Next.js,
Flask, MongoDB, and Socket.IO.

## Architecture

- **Next.js, React, and TypeScript** serve the main website and OBS browser
  views on port `2137`. The Next.js server proxies API and static-file requests
  to Flask and forwards Socket.IO traffic.
- **Flask** provides the application API, authentication and authorization,
  MongoDB-backed accounts and point accounting, media queues, and Socket.IO
  events. It listens on `127.0.0.1:420` by default and should remain private.
- **MongoDB** stores application data in the `annoythestreamer` database and
  listens on `127.0.0.1:27017` in the default local setup.

## Requirements

- Node.js and npm, for the Next.js application.
- Python, for the Flask backend.
- MongoDB Community Server, running locally or at the configured database
  address.

Install from the repository root in PowerShell:

```powershell
npm ci
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## Configuration

The defaults support local development. The optional root `.env.local` can
override the Next.js backend URL using `ATS_BACKEND_URL`; see
`.env.example`. Flask settings must be provided in the Flask process
environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ATS_BACKEND_URL` | `http://127.0.0.1:420` | Flask target for Next.js API, static, and Socket.IO proxies |
| `ATS_BACKEND_HOST` | `127.0.0.1` | Flask bind address |
| `ATS_BACKEND_PORT` | `420` | Flask port |
| `ATS_FRONTEND_HOST` | `0.0.0.0` | Next.js bind address |
| `PORT` | `2137` | Next.js port |
| `ATS_SECRET_KEY` | Generated at startup if omitted | Set a private, persistent value to keep Flask sessions valid across restarts |
| `ATS_COOKIE_SECURE` | `false` | Set to `true` when serving over HTTPS |
| `ATS_ALLOWED_ORIGINS` | `*` | Flask CORS and Socket.IO origins; restrict this for a public deployment |

Never commit `.env.local` or secret values. Keep Flask private behind the
Next.js proxy; do not expose its port publicly.

## Media files

All shared website images and media have one physical home under root
`public/`: images and emoji in `public/img/`, and audio in `public/sounds/`.
Next.js serves these files directly. Flask's `/static/<path>` compatibility
route serves from the same `public/` tree for its APIs and existing media
clients. Website pages, including OBS browser views, are implemented in the
Next.js `app/` directory; Flask no longer renders legacy HTML templates.
Git excludes all files under `public/`; only empty-directory `.gitkeep` markers
are tracked. Restore any required local assets separately before using
features that depend on them.

Put user-provided soundboard audio (`.mp3`, `.m4a`, or `.wav`) in
`public/sounds/soundboard/`; keep generated TTS audio in
`public/sounds/tts/`. The worker retains the five newest generated files in
MongoDB message-ID order, marking evicted records done and removing their
filepaths while preserving records for request deduplication. Stored
`/static/sounds/tts/...` playback URLs are unchanged for retained messages.
Emoji images belong in `public/img/emoji/`. Public media and generated TTS
output are local runtime assets and are not versioned.

`public/sounds/soundboard/_sound-list.txt` is a local-only legacy title list.
The current soundboard obtains its list and titles from Flask's file scan and
audio metadata; it does not read this text file.

## Pricing, asset catalog, and Point Shop

Pricing is stored in MongoDB and edited from the capability-guarded Admin
panel. It controls Send Your Chaos/TTS costs, catalog purchase prices and
named exceptions, proposal rewards, upload limits, and sound play costs.
Price `-1` makes an item unavailable for purchase; the backend enforces prices,
balances, ownership, and idempotency.

Admins manage sound and emoji uploads, metadata, availability, and removal in
separate tabs. Users can purchase available catalog assets or submit sound
and emoji proposals in the Point Shop. Ownership is stored by account and
stable asset ID; uploaded, available, purchased, and usable states remain
separate. Sound favorites are per account, and sound play pricing is separate
from purchase pricing. These settings and records are database-backed; no
additional local setup or pricing file is required.

## Run locally

Start MongoDB first. Run each application service in its own PowerShell
terminal from the repository root:

```powershell
npm run backend
```

```powershell
npm run dev
```

Open <http://localhost:2137/>. The backend and frontend ports are intentionally
different: `420` is the internal Flask port and `2137` is the website port.

For a production build, run `npm run build` and then `npm run start`, with the
Flask backend running separately. This describes how to build and start the
application; deployment is not part of this repository setup guide.

## Checks

Run the frontend production build:

```powershell
npm run build
```

Run the backend test suite:

```powershell
python -m unittest discover -s backend/tests -v
```

## Development status

This is **AnnoyTheStreamer 2.0**, currently on the `2.0.0-alpha.1` development
version. The stable `2.0.0` release is reserved for the first stable release.
