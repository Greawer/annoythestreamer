# AGENTS.md — Website Development Rules

## 1. Project purpose

This is a custom interactive website for a live streamer. It combines a Next.js frontend, a Python Flask backend, MongoDB persistence, real-time chat, user accounts, points, administrative tools, and planned soundboard, emoji shop, polls, betting, and OBS integration.

The project is being developed incrementally with AI coding agents. Correctness, preserving working functionality, and predictable changes are more important than implementing features quickly.

**The task explicitly requested by the user always takes priority over the roadmap.** Do not implement future features just because they are listed here.

## 2. Mandatory rules

1. Inspect the actual working tree and relevant code before editing. Never assume previous agent reports accurately describe the current implementation.
2. Make the smallest complete change that satisfies the current task.
3. Do not add unrequested features, restrictions, refactors, dependencies, redesigns, or behavior.
4. Preserve existing functionality, styling, layout, responsive behavior, data, and API contracts unless the task explicitly requires changing them.
5. Never remove or overwrite existing work simply because it appears unfinished or inconvenient.
6. Never deploy, push, reset Git, discard user changes, or send real chat messages without explicit authorization.
7. Never claim a test, build, server startup, browser interaction, or database operation succeeded unless it was actually executed and its result verified.
8. If requirements conflict, code is ambiguous, or a destructive action appears necessary, stop and ask the user rather than guessing.
9. Never expose credentials, session cookies, passwords, secret keys, or environment-file contents in logs, reports, commits, or generated documentation.
10. Do not modify unrelated files to make a task easier.

## 3. Technology and project architecture

The known stack is:

- **Frontend:** Next.js, React, TypeScript, and the existing styling system.
- **Backend:** Python Flask.
- **Database:** MongoDB, accessed through the existing Python database client.
- **Real-time communication:** Existing Socket.IO/chat mechanisms.
- **Local development:** Windows is a supported development environment.

Previously observed files and locations include:

- `app/page.tsx` — main website interface.
- `backend/routes.py` — Flask routes, authentication, administration, and chat-related backend behavior.
- `backend/client.py` — MongoDB client and collection setup.
- `backend/annoythestreamer.py` and `backend/background.py` — Flask entry point and background workers; inspect their current responsibilities before editing.
- `server.mjs`, `next.config.mjs`, and `route.ts` — existing server and frontend routing/configuration.
- `public/` — canonical physical home for Next.js and Flask-shared images and media; Flask preserves `/static/...` URLs by serving from this directory.
- `.env.example`, `.env.local`, and other environment files — configuration.
- `archive/stream-feature.md` — previously identified archived Stream panel reference.
- `package.json` and applicable Python dependency files — scripts and dependencies.

These paths are historical context, not a guarantee that every file still exists or serves the same purpose. Inspect the current repository before relying on them. Follow the actual project structure and existing conventions.

## 4. Ports and environment configuration

- Internal application/backend/frontend configuration must use **port 420 wherever applicable**.
- Port **2137 is intentionally separate and must not be changed** unless explicitly requested.
- Do not reintroduce port 4200 as an application default or reference.
- When a task involves port configuration, search the repository for stale references, including scripts, configuration files, environment examples, and documentation.
- Distinguish real application configuration from historical notes or unrelated numeric values before editing.
- Never overwrite `.env.local`, database configuration, or other local environment files wholesale.
- Never print secret values. Report variable names and whether configuration is present when necessary.
- Do not change ports, environment files, or startup configuration during unrelated tasks.

## 5. Current baseline and legacy behavior

The following is the intended baseline from previous work. **Verify it against the actual code before relying on it.**

### Panel layout

The main interface contains three relevant panels:

1. Chat + Online Users.
2. Send Your Chaos.
3. Admin.

All three must share the same desktop height rule derived from the archived Stream panel's original 16:9 video geometry and associated header/padding.

The previously reported desktop rule was:

`lg:h-[min(calc(56.25vw_-_16.8rem),856px)]`

The previously reported mobile and tablet heights were `h-[400px]` and `md:h-[500px]`.

Do not change these dimensions during unrelated work. If modifying layout, inspect the actual current classes and archived reference. Preserve the mobile stacking order, responsive behavior, and existing styling.

### Authentication and authorization

- Authentication, session lookup, and administrative authorization must remain distinct responsibilities.
- A user's ban status must not remove their account, prevent login, invalidate their session, or silently remove their rank.
- Administrative actions must be authorized by the backend. A frontend-only `isAdmin` check is not sufficient.
- Reuse the existing authentication and authorization conventions where possible.
- Do not trust client-supplied usernames, ranks, ownership, prices, points, or permissions without server-side verification.

### Ban behavior — current stage

The immediate plan is to keep ban/unban as a **status toggle only**, without introducing chat restrictions yet.

- A ban toggle must not prevent login, reading chat, using other website functionality, or retaining rank.
- A banned user must not receive streaming points.
- Do not implement temporary bans, timeouts, or other ban enforcement until explicitly requested.
- When temporary bans are later implemented, they must restrict sending chat messages only. Users must still be able to read chat, log in, and access other functionality. They must not earn points while the timeout is active.
- Preserve the ability to unban users.
- Keep moderation changes separate from authentication and unrelated authorization logic.

### Streaming points

The intended behavior is:

- An Admin control starts and stops streaming-point awards.
- Streaming state persists in MongoDB.
- While streaming is on, each eligible online user receives 100 points per complete 60 seconds.
- Offline users and banned users receive no streaming points.
- While streaming is off, no points accrue.
- The Chat header displays a glowing green indicator while streaming is on and a plain red indicator while off.
- The indicator reflects the actual persisted/server streaming state, not merely a local UI toggle.
- Only authenticated admins may change streaming state. Enforce this on the server, not just in the frontend.
- Prevent duplicate awards for the same interval, including worker-loop retries and multiple concurrent workers.
- Handle stopping and restarting safely. Never award points for time when streaming is off or award offline users retroactively.
- Use the existing persistence and worker architecture where practical.

Before changing the worker, establish how it tracks elapsed time, online status, persistence, and restarts. If the existing design cannot guarantee the required behavior, explain the limitation before making a broader redesign.

## 6. Feature roadmap — context only

These are future goals, not authorization to implement them in a single task. The user may change their order or specifications.

### A. Account and moderation improvements

- Email collection during registration; store it for future use.
- Logout functionality.
- Temporary chat-only bans with configurable durations and unban support.
- Moderator permissions for inspecting users, banning/unbanning, and granting/removing VIP rank.
- Chat hover actions for replying and, for admins, inspecting a user in the Admin panel.

Ranks currently in scope are `user`, `vip`, `mod`, and `admin`. Preserve existing rank conventions and do not invent additional ranks.

### B. Points and purchases

- Display the logged-in user's points in the welcome area.
- Charge points for normalmeme, facemememe, soundmeme, and TTS usage; the initial proposed price is 5 points per use.
- Admins use these actions for free.
- Reject insufficient-balance purchases or usage on the backend and give users clear feedback.
- Keep point deductions and rewards consistent, atomic where necessary, and protected against retries or concurrent requests.

### C. Soundboard and emoji/icon management

- Admin upload and management interfaces for sound files and emojis/icons.
- Editable display names and sound loudness.
- Require and validate all necessary metadata when uploading.
- The user initially wants ordinary users to have no unlocked sounds or emojis.
- Admins may access everything without purchase limits.
- Preserve the distinction between uploaded assets, available shop items, purchased ownership, and currently usable items.

### D. Point shop

- Separate categories: Emojis, Sounds, OBS, and Extra.
- Use the existing joined-button/category-switching UI pattern where appropriate.
- Display sounds for local preview before purchase.
- Initially price standard shop items at 100 points each.
- Purchases attach ownership to the account and make the item available in the appropriate lists and chat interface.
- Add configurable category prices and named exceptions.
- A price of `-1` means unavailable for purchase, not a negative charge or automatic reward.
- Extra rewards include proposing a new sound or emoji. Proposed initial requirements: 100,000 points, square emoji assets, and sounds shorter than three seconds. The user may change test prices.
- Keep separate configurable prices for the four Send Your Chaos categories.
- Enforce all prices, eligibility, ownership, and purchases on the backend.

### E. Chat activity and points

- Show appropriate administrative and shop-related activity in chat using muted/grey system-style messages.
- Do not attribute admin-only actions to an ordinary user.
- Attribute actions available to both users and admins where specified.
- Do not log shop purchases as chat activity; do log newly added sounds/emojis and other specified actions.
- Ensure logging cannot expose sensitive data or allow client-side message forgery.

### F. Polls and betting

- Admins can create polls and bets.
- Only one bet may be active at a time; polls may run concurrently with a bet and with other polls.
- Polls can be free, unlimited-vote events, with optional multiple-choice options.
- Bets require point stakes and have two outcomes.
- Voting closes automatically after a configurable duration, initially 60 seconds.
- Users cannot change a vote after voting.
- Admins can resolve bets and roll back a previous settlement to restore the affected point balances.
- Display active polls/bets at the top of chat, with switching and minimization behavior.
- A newly created event should automatically become the visible, expanded event.
- Settlement and rollback must be transaction-safe, auditable, and protected against duplicate execution.
- Rollback restores the prior point operation; it does not guess or change the correct outcome.
- Do not implement real-money gambling or introduce features outside the user's stated points-based system.

### G. Local audio and OBS integration

- Soundboard and TTS sounds should be audible locally on the streamer's main website when an admin is logged in.
- Investigate the existing audio routing and virtual audio cable setup before changing playback.
- Archive each normalmeme as a 400 × 300 JPG in an archive folder.
- Future OBS rewards may resize, flip, rotate, or turn off the camera, show a video, or apply filters for configurable durations.
- The website may run remotely while OBS runs on the streamer's local PC. Remote Flask code alone cannot directly control local camera/audio hardware.
- Before implementing OBS control, design and verify a secure local integration. Do not expose OBS control or WebSocket credentials publicly.
- Clearly distinguish a working integration from a mockup or frontend-only control.

### H. Visual refinement

Visual refinement is expected to be iterative.

- Preserve the existing visual language unless a redesign is requested.
- Keep desktop and mobile behavior independently usable.
- Check actual browser rendering when browser tools and local servers are available.
- Do not claim visual correctness based solely on a successful build.
- Avoid broad redesigns when the request concerns a specific component.
- If a visual issue cannot be verified in a browser, clearly state that limitation.

## 7. Required workflow for every task

### Step 1 — Inspect

- Read this file and any applicable nested instructions.
- Run `git status` and inspect relevant diffs before editing.
- Identify the exact frontend component, backend route/event, data model, and configuration involved.
- Search callers and related code paths before changing shared behavior.
- Treat previous agent summaries as unverified until confirmed by source code.

For read-only audit tasks, do not edit or create files.

### Step 2 — Plan

Briefly identify:

- The actual problem.
- The relevant files and functions.
- The smallest proposed change.
- The acceptance criteria and appropriate tests.
- Any uncertainty or risk.

For small, unambiguous tasks, this plan may be concise. For cross-cutting changes, wait for user approval of the plan before implementation when requested.

### Step 3 — Implement

- Make only the approved changes.
- Follow existing project patterns and dependencies.
- Validate all security-sensitive operations on the server.
- Preserve unrelated working code.
- Avoid unnecessary rewrites, renames, formatting churn, and dependency upgrades.
- Never alter local secrets or real user data to make tests pass.
- Use isolated test fixtures or temporary test records and clean them up safely.

### Step 4 — Verify

Run relevant non-destructive checks, as appropriate:

- Python syntax and targeted backend tests.
- Frontend lint, type checks, and production build.
- Targeted tests for permissions, points, persistence, and real-time behavior.
- Git diff and whitespace/error checks.
- Browser tests for UI changes, when available.

Report the exact checks executed and their results. If a check cannot run because MongoDB, dependencies, credentials, or another prerequisite is unavailable, report the actual error and do not claim success.

A successful build does not prove that database behavior, authorization, responsive layout, or browser interactions work correctly.

### Step 5 — Local server verification

When the task requires running the website:

1. Check the existing processes and ports before starting anything.
2. Check whether MongoDB is available before starting Flask.
3. Use existing project scripts and configuration.
4. Do not create duplicate server processes or change environment settings to work around startup failures.
5. Start/restart only what is necessary and keep servers running for manual verification when possible.
6. Report which services started, their local URLs/ports, and actual startup results.
7. If startup fails, provide the exact error and diagnose the prerequisite without making unrelated changes.

Do not deploy.

### Step 6 — Review and report

Inspect the final diff for:

- Unrelated modifications.
- Accidental secret exposure.
- Missing or unexpectedly recreated files.
- Incomplete implementations.
- Authorization gaps.
- Duplicate point awards or deductions.
- Mismatches between UI state and backend state.

Finish with:

1. Changes completed.
2. Files changed.
3. Checks/tests run and results.
4. Anything incomplete or uncertain.
5. Server status and a short manual browser checklist, when applicable.
6. Explicit confirmation that nothing was deployed.

Then stop. Do not continue making improvements while waiting for the user's manual verification or approval.

## 8. Git, backups, and recovery

### Asset and generated-file exclusions

The root `public/` directory is the canonical physical location for website
images in `public/img/`, soundboard files in `public/sounds/soundboard/`, and
generated TTS output in `public/sounds/tts/`. Next.js serves these files
directly. Flask's `/static/<path>` compatibility route serves the same files
from `public/`; do not maintain copies under `backend/static/`.

Do not commit user-provided emoji images, soundboard audio, generated TTS audio,
or temporary output. Ignore only those media files and the exact local-only
`public/sounds/soundboard/_sound-list.txt` configuration; do not ignore
required source code, tests, or configuration templates. A `.gitkeep` may be
retained only for a canonical asset directory that needs to exist in a fresh
checkout.

The TTS worker retains the five newest generated audio files by MongoDB
message ID. When audio is evicted or missing, its queue record remains for
request deduplication, is marked done, and has its `filepath` removed; these
records do not requeue audio generation.

No Jupyter notebook or notebook configuration exists in the current
repository. The local sound-to-title list at
`public/sounds/soundboard/_sound-list.txt` remains in the canonical soundboard
directory for local use; the current application does not read it. Do not add
a blanket notebook or asset-directory rule.

The `normalmeme` JPG archive feature is not implemented. Its future snapshots
must remain local, but no archive path or naming convention is defined yet, so
add a precise ignore pattern only after the feature defines one.

`AGENTS.md` and `ROADMAP.md` are tracked project documentation and must remain
tracked. Do not add either file to `.gitignore` or untrack them.

- Never run `git reset --hard`, `git clean`, or destructive checkout/restore commands without explicit approval.
- Do not assume untracked files are disposable. Previous work may exist entirely in untracked files.
- Do not commit, push, merge, or deploy unless explicitly authorized.
- Before any approved commit, review the staged diff and confirm that secrets, local environment files, generated data, and unrelated changes are excluded.
- If the working tree is already dirty, preserve all pre-existing changes and clearly distinguish them from the current task.

## 9. Communication rules

- Be precise and concise.
- Ask a direct question when an essential requirement is ambiguous.
- Do not repeatedly ask the user to reconfirm an already explicit requirement.
- Do not invent file paths, functions, test results, browser state, database contents, or server status.
- Separate verified facts from assumptions and recommendations.
- Explain blockers rather than repeatedly retrying a failing tool or command.
- Do not send test messages through the user's real account unless explicitly requested. A previous test was already sent as `Greawer`; do not repeat it without new authorization.

**Final principle:** Make one well-defined change, prove what you can, preserve everything else, and wait for the next instruction.
