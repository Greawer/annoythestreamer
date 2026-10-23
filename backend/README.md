# Flask backend

The Flask service is the API and real-time backend for the Next.js website. It
provides account authentication, capability-checked administration,
MongoDB-backed point and action records, meme/TTS queues, soundboard and emoji
APIs, and chat/presence events. Next.js proxies API and Socket.IO traffic to
Flask and preserves existing `/static/*` media URLs. Flask does not render the
website's pages; the main site and OBS browser views are implemented in Next.js.
In local development, keep Flask on its private loopback address; users access
the application through Next.js.

## Setup and startup

Start MongoDB, then from the repository root install the backend dependencies:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Start Flask from the repository root with the existing npm script:

```powershell
npm run backend
```

This runs `python backend/annoythestreamer.py`. Flask listens on
`127.0.0.1:420` by default. Start the frontend separately with `npm run dev`;
the website uses port `2137`.

The pinned Python dependencies in `requirements.txt` are Eventlet, Flask,
Flask-CORS, Flask-SocketIO, gTTS, PyMongo, and Mutagen.

## Database and configuration

`backend/client.py` connects to MongoDB at
`mongodb://127.0.0.1:27017/` and uses the `annoythestreamer` database. The
MongoDB URI is currently set in code.

The Flask process reads these optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ATS_BACKEND_HOST` | `127.0.0.1` | Flask bind address |
| `ATS_BACKEND_PORT` | `420` | Flask port |
| `ATS_SECRET_KEY` | Random value generated at startup | Flask session signing key; provide a private persistent value to preserve sessions across restarts |
| `ATS_COOKIE_SECURE` | `false` | Enables the secure session-cookie flag when set to `true` |
| `ATS_ALLOWED_ORIGINS` | `*` | CORS and Socket.IO allowed origins; a comma-separated list is accepted |

`ATS_BACKEND_URL` is read by the Next.js proxy, not Flask. Its default is
`http://127.0.0.1:420`; the root `.env.example` documents this frontend setting.
Do not commit secret values or local environment files.

## API and real-time behavior

Routes are registered in `backend/routes.py`. The main API routes include:

- `/auth/lookup`, `/auth/login`, `/auth/session`, and `/auth/logout` for account
  lookup, login/registration, and session management.
- `/admin/*` for permission-guarded pricing, user inspection, point adjustment,
  rank and timeout management, and stream controls.
- `/admin/assets/<sound|emoji>` and `/admin/assets/<sound|emoji>/<id>` for
  capability-guarded asset management; `/admin/pricing` for saved prices,
  proposal rewards, and upload limits.
- `/shop/catalog`, `/shop/purchase`, and `/shop/propose` for the authenticated
  Point Shop, purchases, and custom asset proposals; `/soundboard/favorites`
  persists each account's favorites.
- `POST /handle_post` for one authenticated face-meme, normal-meme, or TTS
  action. The backend resolves its price and balance change.
- `/facememe/next`, `/normalmeme/next`, `/ttsmeme/next`, and
  `/tts/done/<id>` for queued content; `/chathistory`, `/soundboardlist`,
  `/api/list-emojis`, `/public-emojis`, and `/static/*` for chat and media.

Socket.IO handles authenticated `playsound` requests, chat messages, connection
presence, and streaming status. Backend permissions and accounting are
authoritative; frontend visibility is not a security boundary.

## Pricing, assets, and ownership

The `pricing` collection stores the shared versioned pricing document. It
contains Send Your Chaos/TTS costs, sound and emoji catalog defaults and
exceptions, proposal reward defaults/exclusive costs/named exceptions, upload
limits, and sound play costs. An Admin needs the `admin_console` capability to
read or save pricing and administer assets. Prices and upload limits are
validated and enforced by Flask; a price of `-1` means unavailable, never free.

Assets are stored separately in the `sounds` and `emojis` collections.
`asset_ownership` associates accounts with stable asset IDs, `shop_purchases`
records idempotent purchases, and `sound_favorites` stores per-account sound
favorites and their ordering. Admin uploads are distinct from shop availability
and account ownership. User proposals are charged from the configured proposal
reward settings and become owned by their submitter; they do not become
shop-available automatically. The backend uses unique indexes for asset names,
ownership, purchase idempotency, and favorite membership.

All shared website images and media live under root `public/`: images and emoji
are in `public/img/`, and soundboard/TTS audio is in `public/sounds/`. Next.js
serves these files directly. Flask disables its built-in static folder and
retains existing `/static/<path>` URLs by serving the requested path from
`public/`. The Next.js proxy forwards `/static/*` requests to Flask.
Git excludes all files under `public/`; only empty-directory `.gitkeep`
markers are tracked, so restore required local assets separately.

User-provided soundboard audio belongs in `public/sounds/soundboard/`.
`/soundboardlist` scans that directory and derives titles from audio metadata
when available; `public/sounds/soundboard/_sound-list.txt` is a local-only
configuration file and is not read by the current code. Runtime-generated TTS
files belong in `public/sounds/tts/`. The worker keeps the five newest files in
MongoDB message-ID order. On eviction, it removes the file, marks the message
done, and removes its `filepath`; it retains the MongoDB document so retries
remain deduplicated. Missing files are handled the same way, and `created=yes`
records are not requeued. Existing playback URLs and filenames are preserved
for retained audio. Ignore rules exclude all `public/` contents without hiding
application source, tests, or configuration templates.

## Tests

Run the backend unit tests from the repository root:

```powershell
python -m unittest discover -s backend/tests -v
```

The suite includes focused coverage for point accounting and pricing, paid
actions, TTS oldest-first retention and queue-record cleanup, shared public
media routes, registration email, moderation permissions, timeouts, and
transaction migration.
