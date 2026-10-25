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
Flask-CORS, Flask-SocketIO, gTTS, PyMongo, Mutagen, and Pillow.

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
| `ATS_STREAM_CONTROL_TOKEN` | unset | Private 32-character-minimum bearer token for `/stream-control`; required for external triggers |

`ATS_BACKEND_URL` is read by the Next.js proxy, not Flask. Its default is
`http://127.0.0.1:420`; the root `.env.example` documents this frontend setting.
Do not commit secret values or local environment files. Store the stream-control
token in the Flask process environment, never in a script or repository file.
`public/reference/WebsiteStreamStart.py` reads it from the current process
environment or the current Windows user's environment registry value.

On Windows, generate and store a private token without displaying it, then
restart Flask so it inherits the setting:

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
[Environment]::SetEnvironmentVariable('ATS_STREAM_CONTROL_TOKEN', $token, 'User')
[Environment]::SetEnvironmentVariable('ATS_STREAM_CONTROL_TOKEN', $token, 'Process')
Remove-Variable token, bytes, rng
```

`WebsiteStreamStart.vbs` launches the local toggle trigger using the existing
VBS-to-BAT reference-script pattern. The authenticated `/stream-control` API
supports status, explicit start/stop, and an atomic `toggle` action. The trigger
uses `toggle` with a unique request ID; MongoDB applies each ID at most once
and retries state transitions against the latest persisted state. It defaults to
`http://127.0.0.1:420/stream-control`; set `ATS_STREAM_CONTROL_URL` on the
trigger PC to change its destination. It does not retry a timed-out toggle;
verify backend state before manually retrying. For a Stream Deck on another PC,
configure the same private token there and use an HTTPS destination protected by
a firewall. Flask defaults to loopback-only; do not expose its plain HTTP
listener to the LAN. Use a TLS-terminating private gateway for remote control.

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

Normalmeme uploads and supported image URLs are stored as locally served JPEGs
for active use under `public/img/meme/normalmeme/`. When a new Normalmeme is
accepted, the prior managed active image is deleted. The main Send Your Chaos
panel previews Normalmeme and FaceMeme output in a proportional 4:3 frame
before submission.
The FaceMeme page and preview use
`public/img/meme/facememe/facememe-template-placeholder.png`; the private
`facememe-template.png` is not referenced by the application.

Socket.IO handles authenticated `playsound` requests, chat messages, connection
presence, and streaming status. Backend permissions and accounting are
authoritative; frontend visibility is not a security boundary. When an Admin
is signed in to the main site, its Socket.IO client also plays requested
soundboard audio and generated TTS audio locally in that browser; existing
stream playback remains in place.

Stream control is available to admins through their authenticated website
session and to local/external triggers through the bearer-token-protected
`/stream-control` endpoint. Status, start, stop, and toggle operations are
authenticated. Toggle requires a unique UUID request ID and uses an atomic
MongoDB state transition to serialize concurrent requests and deduplicate
retries. Admins configure points per interval and interval seconds in the
Admin panel; saved settings apply when the next stream starts. Each Flask
startup forces streaming off and clears active timing, while preserving saved
award settings. Only complete intervals accrue to eligible online users.

## Pricing, assets, and ownership

The `pricing` collection stores the shared versioned pricing document. It
contains Send Your Chaos/TTS costs, sound, emoji, and theme catalog defaults
and exceptions, proposal reward defaults/exclusive costs/named exceptions,
upload limits, and sound play costs. An Admin needs the `admin_console`
capability to read or save pricing and administer assets. Prices and upload
limits are validated and enforced by Flask; a price of `-1` means unavailable,
never free.

Assets are stored separately in the `sounds` and `emojis` collections.
`asset_ownership` associates accounts with stable asset IDs, `shop_purchases`
records idempotent purchases, and `sound_favorites` stores per-account sound
favorites and their ordering. Admin uploads are distinct from shop availability
and account ownership. User proposals are charged from the configured proposal
reward settings and become owned by their submitter; they do not become
shop-available automatically. The backend uses unique indexes for asset names,
ownership, purchase idempotency, and favorite membership.

Themes and badges are database-backed assets. Theme selection is saved per
account; non-standard themes use shop ownership and shared pricing rules.
Admins manage themes and badge assets, and can grant badges to inspected users
or currently online users. Users can select one owned badge to display beside
their chat name. Authorized account inspection exposes profile and moderation
details only to permitted viewers.

All shared website images and media live under root `public/`: images and emoji
are in `public/img/`, and soundboard/TTS audio is in `public/sounds/`. Next.js
serves these files directly. Flask disables its built-in static folder and
retains existing `/static/<path>` URLs by serving the requested path from
`public/`. The Next.js proxy forwards `/static/*` requests to Flask. Git
includes `.gitkeep` directory markers and the FaceMeme placeholder image;
other public media is local-only and must be supplied separately.

User-provided soundboard audio belongs in `public/sounds/soundboard/`.
`/soundboardlist` scans that directory and derives titles from audio metadata
when available; `public/sounds/soundboard/_sound-list.txt` is a local-only
configuration file and is not read by the current code. Runtime-generated TTS
files belong in `public/sounds/tts/`. The worker keeps the five newest files in
MongoDB message-ID order. On eviction, it removes the file, marks the message
done, and removes its `filepath`; it retains the MongoDB document so retries
remain deduplicated. Missing files are handled the same way, and `created=yes`
records are not requeued. Existing playback URLs and filenames are preserved
for retained audio. Git retains `.gitkeep` directory markers and the
facememe placeholder image under `public/`, while excluding other assets and
the local-only `public/reference/` folder.

## Tests

Run the backend unit tests from the repository root:

```powershell
python -m unittest discover -s backend/tests -v
```

The suite includes focused coverage for point accounting and pricing, paid
actions, TTS oldest-first retention and queue-record cleanup, shared public
media routes, registration email, moderation permissions, timeouts, and
transaction migration.
