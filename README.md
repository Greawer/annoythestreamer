# AnnoyTheStreamer 2.0

The current 2.0 alpha is an interactive streamer website built with Next.js,
Flask, MongoDB, and Socket.IO. Development status and planned work are tracked
in the [roadmap](./ROADMAP.md).

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
python -m pip install -r backend\requirements.txt
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

User-provided emoji and soundboard files are not included in the repository.
Add PNG emoji images under `public/img/emoji/` and soundboard audio
(`.mp3`, `.m4a`, or `.wav`) under `backend/static/sounds/soundboard/`.
Generated TTS audio is runtime output and is not versioned.

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
See [ROADMAP.md](./ROADMAP.md) for verified features, work in progress, and
planned follow-up features.
