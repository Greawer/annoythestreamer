# Website Development Roadmap

## 1. Purpose and working rules

This roadmap records verified implementation status and plans incremental work
for the interactive streamer website. It supplements `AGENTS.md`; it does not
replace it. The user's explicit request for a task always takes priority.

- Implement one well-defined task or closely related group at a time.
- Inspect current code before relying on historical status or architecture.
- Preserve existing behavior, styling, user data, and unrelated work.
- Do not deploy, push, or perform destructive Git operations without explicit
  authorization.
- A feature is not complete merely because code exists or a build passes.
  Verify its acceptance criteria, including live/browser behavior where
  relevant, before setting `[x]`.
- Keep optional features separate from core prerequisites.

### Status conventions

- `[ ]` Not implemented or not yet verified.
- `[~]` Partially implemented or awaiting verification.
- `[x]` Implemented and verified against its acceptance criteria.

Use `[~]` where part is implemented but a required verification or behavior
remains. Keep unverified future work at `[ ]`.

## 2. Project baseline

Verify this baseline against the current code before relying on it.

- Frontend: Next.js, React, and TypeScript.
- Backend: Python Flask; MongoDB is the persistence layer.
- Real-time communication: existing Socket.IO/chat implementation.
- Main website: `http://localhost:2137/`; Flask: port `420`; MongoDB: port
  `27017`.
- Configured roles include Admin, Moderator, VIP, and User. Runtime
  authorization is capability-based; role names are used only to seed the
  initial defaults.
- The signed `point_transactions` collection is the point ledger. Positive
  `amount` values credit balances; negative values debit balances.

### Verified existing behavior

- The UI has login/logout, registration email collection, a displayed point
  balance, Send Your Chaos/TTS actions, chat, timeout moderation, and a limited
  Admin/Moderator panel.
- Timeouts are the chat restriction: active timeouts block sending chat and
  streaming rewards; users retain login, reading access, rank, and other site
  features. Legacy permanent-ban flags are inert.
- Streaming awards 100 points per complete minute to eligible online users.
- The chat streaming indicator reflects server streaming state.
- Runtime permission profiles and `staff` metadata are keyed to configured
  rank IDs. Existing rank labels are used to seed defaults, not as runtime
  authorization checks.
- Admin Send Your Chaos/TTS use is free; VIP uses the configured discount.

These are verified baselines, not permission to duplicate existing work. If a
later task reports a regression, reproduce it and update the relevant item.

## 3. Phase A — Account basics

### A1. Logout

Status: `[x]`

Verified in the browser: logout invalidates the server session, returns to the
login form, and protected inspection no longer succeeds.

Acceptance criteria:

- Invalidate the authenticated session on the server and clear client auth
  state.
- Return to the login form without deleting account data.

### A2. Registration email collection

Status: `[x]`

Focused backend tests cover validation, normalization, legacy-login
compatibility, and email-free user responses; frontend TypeScript validation
passed.

Acceptance criteria:

- Collect and store a validated email at account creation.
- Preserve username/password behavior and do not expose email in public
  responses.
- This does not provide email reset or account email-change functionality;
  those are tracked separately in G1.

### A3. Display current points

Status: `[x]`

Focused backend tests and a signed-in browser check verified the server balance
is returned and displayed.

Acceptance criteria:

- Display the server-side balance and update it after point changes.
- Never treat a client-supplied balance as authoritative.

## 4. Phase B — Moderation and chat interaction

### B1. Temporary chat bans (timeouts)

Status: `[x]`

Focused backend tests cover active/expired timeout enforcement, early removal,
permanent-ban flag compatibility, and streaming-point exclusion.

Acceptance criteria:

- Authorized staff can apply a positive duration in seconds and remove an
  active timeout early.
- Enforce the timeout and automatic expiry on the backend.
- Preserve login, reading chat, rank, session, and unrelated features.
- Expired timeouts never become permanent bans.
- Active timeouts exclude users from streaming-point awards.

### B2. Chat reply controls

Status: `[x]`

Acceptance criteria:

- Hovering a chat username exposes Reply to ordinary users and staff.
- Reply prepares `@username` in the existing composer; the user can continue
  typing and send normally.
- Handle usernames as text, without markup or command injection.
- Preserve chat rendering and layout when the hover menu is not shown.

### B3. Chat Inspect action

Status: `[x]`

Admin and Moderator Inspect access was verified in the browser with backend
permission checks in place.

Acceptance criteria:

- An actor with the stored inspection capability sees Inspect on chat
  usernames.
- Selecting it opens the panel and loads the selected user.
- Backend authorization remains authoritative.

### B4. Moderator permissions

Status: `[x]`

Focused backend tests and browser checks verify Moderator panel and Inspect
access while Admin-only controls remain unavailable.

Acceptance criteria:

- Moderators may inspect users, manage eligible timeouts, and assign configured
  non-staff ranks.
- Moderators cannot modify their own privileges, grant staff roles, or modify
  protected staff targets.
- Preserve Admin-only actions and enforce all permissions on the backend.

## 5. Phase C — Point economy foundations

### C1. Reliable point ledger

Status: `[x]`

Focused accounting tests cover duplicate/concurrent operations, streaming
awards, clamped admin adjustments, signed actual deltas, and pending-record
retry behavior. The standalone MongoDB deployment does not support
cross-collection transactions; balance mutations stage a pending ledger entry
atomically with the account update and flush it idempotently.

Acceptance criteria:

- Make backend point changes retry-safe and concurrency-safe.
- Record the signed actual delta (including clamped deductions) without
  silently losing a ledger entry.
- Keep action-queue `point_cost` distinct from signed ledger `amount`.
- Preserve correct charges/refunds when actions fail; admins' free use must not
  be charged.

### C2. Send Your Chaos and TTS point costs

Status: `[x]`

Focused backend tests, frontend checks/build, and live permission/cost checks
verified the current behavior.

Acceptance criteria:

- Charge `normalmeme`, `facemememe`, `soundmeme`, and TTS using server prices;
  the initial base cost is 5 points per use.
- Reject insufficient balances clearly and prevent duplicate charges.
- Admin actions are free and show no price; ordinary users see their effective
  cost.
- Preserve media/TTS behavior and refund failed actions safely.

### C3. Configurable prices and rewards

Status: `[~]`

Depends on: C1, C2, C4.

Add one backend pricing model and a separate Admin pricing interface.

The shared versioned MongoDB pricing document, capability-guarded API, Admin
editor, server-side Send Your Chaos/TTS price resolution, unavailable-price
handling, and focused tests are implemented. The pricing editor rendered in the
browser with isolated mock responses, but its save interaction has not yet
been verified in a signed-in Admin browser session. Shop purchases and
proposal submissions remain downstream integrations.

Acceptance criteria:

- Configure prices for each of the four Send Your Chaos categories.
- Configure emoji category defaults and named per-item exceptions.
- Configure per-item sound/emoji proposal rewards; allow lower explicit test
  prices than the initial proposal price.
- Treat price `-1` as unavailable to ordinary users: do not list it as
  purchasable, do not treat it as free, and reject purchase attempts.
- Validate all configured prices and enforce the saved price server-side.
- Reflect saved changes in consuming interfaces without hardcoded frontend
  price updates. Existing action clients refresh their effective costs when an
  administrator saves pricing; shop and proposal flows will consume the same
  model when implemented.

### C4. Database-driven rank permissions

Status: `[x]`

Verified by backend permission/pricing tests, frontend type check/build, live
MongoDB inspection after Flask startup, and browser checks of Admin and
Moderator panel access and Inspect. The live configured Admin, Moderator,
VIP, and User roles had permission records and the expected `staff` values.

Acceptance criteria:

- Store capabilities in MongoDB `permissions`, keyed by rank/role ID, and
  initialize `staff` metadata for configured roles.
- Use stored capabilities for Admin panel access, moderation eligibility,
  inspection, rank assignment, point adjustments, password reset, stream
  control, Admin-free actions, and VIP discounts.
- Define eligible staff target roles by role ID and use `staff` to distinguish
  staff from non-staff roles.
- Fail closed for privileged actions when permission data is absent or
  invalid.
- Do not use hardcoded rank labels for runtime authorization. Rank labels may
  be used by the idempotent default-seeding migration.
- Use the same permission profile for frontend visibility and backend
  enforcement.

## 6. Phase D — Assets, ownership, and shop

All asset management, ownership, and purchases depend on C1 (ledger), C3
(pricing), and C4 (permissions). Keep uploaded assets, shop availability,
account ownership, and usable items as distinct concepts.

### D1. Soundboard asset administration

Status: `[ ]`

Depends on: C1, C3, C4.

Acceptance criteria:

- Admins can upload/replace/remove sounds and edit display name and loudness.
- Validate file type, maximum size, actual audio format, and required metadata
  on the backend.
- Reject unsafe or unsupported uploads; do not expose arbitrary server paths.
- Safely replace/remove files without overwriting unrelated assets.
- Preserve separate asset identity, metadata, shop availability, and ownership.

### D2. Emoji/icon asset administration

Status: `[ ]`

Depends on: C1, C3, C4.

Acceptance criteria:

- Admins can upload/replace/remove emoji or icon assets and rename them.
- Validate file type, size, image dimensions, and required metadata on the
  backend.
- Preserve asset identity and existing ownership when display names change.
- Do not expose arbitrary server paths or damage unrelated assets.

### D3. Per-account asset visibility and ownership

Status: `[ ]`

Depends on: C1, C3, C4, D1, D2.

Acceptance criteria:

- Initially ordinary accounts have zero unlocked sounds and emojis for
  purchase-flow testing.
- Users can see/use only owned or otherwise entitled assets.
- Admins can access every asset without purchase limits; enforce this on the
  backend.
- Prevent users from claiming another account's ownership.
- Renaming an asset does not break existing ownership.
- Keep uploaded, available, owned, and usable states distinct.

### D4. Point Shop

Status: `[ ]`

Depends on: C1, C3, C4, D1, D2, D3.

Acceptance criteria:

- Provide categories Emojis, Sounds, OBS, and Extra, using the existing
  joined-button/category-switching pattern where appropriate.
- Show item name, applicable cost, preview, and owned/purchasable/unavailable
  state.
- Allow local sound preview before purchase.
- Initial ordinary sound and emoji price is 100 points each.
- Purchased sounds and emojis become usable by their owner and appear in the
  appropriate sound/emoji lists and chat UI.
- Enforce ownership and price server-side; prevent duplicate purchase,
  duplicate charge, and inconsistent balance updates.
- Admins have unrestricted access without being charged.
- OBS reward listings must not imply that a remote OBS integration exists;
  optional OBS rewards are planned separately in Phase I.

### D5. Extra asset proposals

Status: `[ ]`

Depends on: C1, C3, C4, D1, D2, D3, D4.

Acceptance criteria:

- Offer sound and emoji proposals in Extra, initially costing 100,000 points
  each; permit explicitly configured lower test prices.
- Require review metadata and validate files server-side.
- Proposed emoji images are square; proposed audio is shorter than three
  seconds.
- Keep proposals separate from approved assets until an approval workflow
  publishes them.
- Apply configured per-item proposal rewards/prices using the shared pricing
  model.

## 7. Phase E — Chat activity and pop-out chat

### E1. Authenticated system activity messages

Status: `[ ]`

Depends on: C4; purchase-related announcements additionally depend on D4.

Acceptance criteria:

- Render applicable moderation, Admin, and shop actions as visually distinct
  grey system-style messages.
- Do not fabricate a user identity for actions that do not belong to a user.
- Admin-only activities need not identify the admin.
- For actions available to Admins and ordinary users, show the acting
  username in grey rather than the normal rank color.
- Log adding a new sound or emoji and other relevant specified actions, but do
  not log ordinary sound/emoji purchases.
- Generate and authorize events on the backend; do not trust client-forged
  activity messages.

### E2. Pop-out chat

Status: `[ ]`

Acceptance criteria:

- Add a control at the top of chat to open a dedicated chat-only page in a
  separate resizable browser window.
- Size the desktop window to the chat section where practical.
- On mobile, use a new card/page rather than relying on desktop-window
  behavior.
- Preserve authentication, real-time updates, and existing chat permissions.

## 8. Phase F — Media and streaming operations

### F1. Normalmeme local file handling and archive

Status: `[ ]`

Acceptance criteria:

- When `normalmeme` sends a local file, download it to the local drive for
  active use; safely replace it or retain at most one previous item.
- Save every normalmeme as a `.jpg` in an archive folder at exactly
  400 × 300 pixels.
- Validate file handling and avoid arbitrary path writes or unrelated file
  replacement.
- Verify with a representative local file and inspect the generated archive
  output.

### F2. Local sound and TTS playback for Admins

Status: `[ ]`

Acceptance criteria:

- When an Admin is logged in on the main website, soundboard and TTS output is
  also audible locally while preserving existing playback and stream behavior.
- Investigate the VH-Audio Virtual Cable monitoring setup as a possible
  simpler route.
- Verify the actual relationship and audio paths of the main site and the two
  separate sub-sites before choosing an architecture; do not assume they can
  or cannot share local playback.
- Distinguish verified local playback from a mockup or queue-only behavior.

### F3. Stream Deck control and restart state

Status: `[ ]`

Depends on: C1, C4.

Acceptance criteria:

- Provide an authenticated, secure way for the Stream Deck on the streaming
  PC to set streaming on/off and query current state from the website on the
  mini-PC.
- Keep the chat indicator and point worker synchronized with the authoritative
  state.
- Preserve 100 points per complete minute and existing online/timeout
  eligibility rules.
- On every Flask restart, force streaming off even if it was previously on;
  require manual reactivation. Do not leave a stale start time that can produce
  retroactive awards.
- Verify with a controlled restart: state reads off, indicator is off, no
  points accrue until manually enabled, then eligible complete-minute awards
  resume once.
- Current implementation persists stream state and does not explicitly reset
  it at startup; this acceptance criterion is not yet met.

## 9. Phase G — Email, themes, and interaction polish

### G1. Account email reset/change

Status: `[ ]`

Depends on: A2.

Acceptance criteria:

- Provide authorized email reset/account email-change behavior distinct from
  registration email collection.
- Validate and normalize new email addresses and protect the operation with
  appropriate authentication/authorization.
- Do not expose email addresses in public APIs or chat.
- Define and verify recovery proof before allowing an unauthenticated reset;
  do not treat knowledge of a username as sufficient authorization.

### G2. Persistent themes and theme rewards

Status: `[ ]`

Depends on: C1, C3, C4, D4.

Acceptance criteria:

- Replace the binary dark/light selector with a picker for multiple visual
  styles; define one default theme.
- Persist the selected theme in MongoDB so it survives Flask restarts.
- Make non-default themes purchasable through the same ownership/purchase
  infrastructure, initially 10,000 points each.
- Render each theme icon as a square split diagonally between its main/
  background color and accent color.
- Show unavailable themes with a red dot or border at the top-right.
- Allow temporary preview. Closing the picker or navigating away without
  saving restores the last saved theme; explicit Save commits the selection.

### G3. Smooth chat auxiliary-panel transitions

Status: `[ ]`

Acceptance criteria:

- Animate the emoji tray and online-user section opening and closing smoothly
  instead of snapping.
- Preserve chat layout, keyboard/pointer usability, reduced-motion
  accessibility, and mobile behavior.

### G4. Iterative visual refinement

Status: `[ ]`

Acceptance criteria:

- Track broad visual-fixing work rather than treating styling as finished when
  features compile.
- Review the actual rendered site across desktop and mobile, including
  responsiveness, spacing, typography, contrast, and interaction states.
- Record concrete visual defects and address them in bounded follow-up tasks.
- Do not mark this complete based only on functionality, type checks, or a
  production build.

## 10. Phase H — Chat polls and point bets

Polls and bets must use C1's signed ledger and the shared permission model.
Every state transition must be backend-authoritative, concurrency-safe,
idempotent, and auditable.

### H1. Poll lifecycle and interface

Status: `[ ]`

Depends on: C1, C4.

Acceptance criteria:

- Admins can create free-to-vote polls; a poll may have multiple choices.
- Polls may coexist with one active bet and with other polls.
- Voting closes automatically after a configurable duration, default 60
  seconds.
- A user may submit only one vote per poll and cannot change it afterward.
- Pin active events above chat, switch between multiple active events, and
  allow the pinned interface to collapse upward.
- A newly created poll or bet automatically becomes selected and expanded.
- Enforce voting eligibility, one-vote rules, close time, and concurrency on
  the backend.

### H2. Bet lifecycle and stakes

Status: `[ ]`

Depends on: C1, C4, H1.

Acceptance criteria:

- Admins can create Yes/No bets, including a prompt such as whether an action
  will occur within a specified number of attempts.
- Only one bet can be active at a time; bets cannot have multiple-choice
  options.
- Users stake points on one outcome. Validate and atomically debit stakes
  against the authoritative balance; prevent duplicate or changed stakes.
- Close voting automatically after the configured duration (default 60
  seconds) and show the event in the shared pinned interface.
- Polls remain free and may run at the same time as the single active bet.

### H3. Bet settlement and rollback

Status: `[ ]`

Depends on: C1, H2.

Acceptance criteria:

- An authorized Admin resolves a closed bet once.
- Return/redistribute the losing pool fairly among winners in proportion to
  their stakes, with deterministic integer rounding and documented handling of
  any remainder.
- If there are no winning stakes, explicitly define and implement the outcome
  by voiding the bet and refunding every participant's stake; do not
  redistribute a losing pool to nonexistent winners.
- For winning bets, pay each winner their stake plus their proportional share
  of the losing pool. Allocate indivisible point remainders deterministically
  (largest remainder, with a stable user-ID tie-break) so credits sum exactly
  to the losing pool.
- Store settlement records and signed point transactions so each affected
  balance can be restored exactly.
- Provide “Rollback Bet” to reverse only the prior settlement and restore
  pre-settlement balances; it does not select another result.
- Prevent duplicate settlement and repeated rollback; verify concurrent
  attempts and ledger consistency.

## 11. Phase I — Optional future OBS rewards

These features are optional and are not prerequisites for the core Point Shop.
Do not represent remote OBS control as working until the secure local
integration is researched, implemented, and verified.

### I1. Secure OBS integration research

Status: `[ ]`

Acceptance criteria:

- Research a secure architecture linking the deployed website to OBS running
  on the streaming PC. Streaming uses Discord virtual camera/video and a
  microphone, not Twitch.
- Account for the remote website/local-PC boundary; the Flask server alone
  cannot control hardware on a separate streaming PC.
- Keep OBS/WebSocket credentials private and the local integration
  authenticated, narrowly scoped, and independently controllable.
- Validate the architecture before implementing any reward controls.

### I2. Camera framing and shutdown rewards

Status: `[ ]`

Depends on: I1 and a verified local OBS integration.

Acceptance criteria:

- Camera resize/aspect-ratio changes keep fixed outer bounds and run for a
  configurable duration, initially 60 seconds.
- Admins can configure minimum and maximum X ratios.
- Horizontal/vertical flips preserve intended crop and framing.
- Rotation preserves correct orientation and permits limited overflow only
  where needed.
- Camera shutdown lasts for a configurable duration.
- Configure prices, durations, constraints, and reward behavior through the
  Admin point-shop pricing interface; announce applicable activity in chat.

### I3. Video reward

Status: `[ ]`

Depends on: I1 and a verified local OBS integration.

Acceptance criteria:

- Play a user-supplied or lawfully licensed/downloaded “Subway Surfers” video
  until an Admin changes it or it is hidden through a purchase.
- Verify rights, safe media handling, storage, and playback behavior before
  using any downloaded media.
- Configure price and behavior in the Admin point-shop interface and announce
  applicable activity in chat.

### I4. Camera filters and preview

Status: `[ ]`

Depends on: I1 and a verified local OBS integration.

Acceptance criteria:

- Provide temporary camera filters with configurable duration and either
  custom parameters or presets.
- Preview filter effects using a supplied JPG, never the live camera feed.
- Configure filter prices, duration, constraints, and reward behavior through
  the Admin point-shop interface; announce applicable activity in chat.

## 12. Dependency order

Use this order for new work; a dependency is not an instruction to implement
multiple phases in one task.

1. C1 and C2 are the verified point-ledger and Send Your Chaos foundations;
   C4 is the verified permission model.
2. Implement C3's shared price model and Admin pricing interface.
3. Implement D1/D2 asset administration, then D3 ownership and D4 shop; D5
   proposals follow the approved asset and purchase model.
4. Implement E1 system messages for moderation and purchases as their source
   actions become available; implement E2 pop-out chat independently.
5. F1/F2 media tasks can proceed independently where their existing media
   pipelines permit. F3 needs C1/C4 and must verify restart semantics.
6. G1 can proceed from existing account email data. G2 requires the shared
   shop/ownership model. G3 and G4 are UI tasks and should be browser-verified.
7. H1 can establish poll lifecycle; H2 adds stakes using C1; H3 follows only
   after H2's stake and event state are durable.
8. I1 is research-only until approved. I2–I4 require I1's verified secure
   local OBS integration and remain optional.

## 13. Out of scope unless separately requested

- Real-money gambling or payment processing.
- Public or unauthenticated access to moderation, account, points, or OBS
  controls.
- Treating frontend visibility as a security boundary.
- Automatically publishing proposed sounds/emojis before their approval.
- Deploying or changing live account balances, ranks, or moderation data as
  part of roadmap implementation.
