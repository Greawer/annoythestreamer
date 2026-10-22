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
handling, and per-item catalog and proposal-reward exceptions are implemented.
The pricing editor rendered in the browser with isolated mock responses.
Focused tests cover saving and resolving item exceptions, including `-1`; a
mocked Admin browser flow verified editing an existing exception to `-1` and
reloading the saved value. A real signed-in Admin save remains unverified, so
C3 is still awaiting that acceptance check.

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
  administrator saves pricing; D4 shop clients refresh their catalog after the
  pricing-save broadcast.

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

Status: `[~]`

Depends on: C1, C3, C4.

Capability-guarded Admin endpoints and separate Soundboard/Emoji management
tabs now support validated uploads, edits, normalized renames, shop
availability, shared C3 price exceptions, and safe removal. Stable asset IDs
and ownership are preserved on rename. Focused Flask tests cover authorization,
validation, duplicate names, exception retention, and rename/removal. Browser
upload and playback through a real OBS/browser session remain unverified, so
the full acceptance criteria are not yet verified.
New assets appear in the Shop as unavailable until an Admin explicitly enables
shop availability, keeping upload separate from purchasability.

Acceptance criteria:

- In the admin page, a new section "Soundboard" needs to be created (shown along with Users/Admin/Pricing)
- If text becomes unreadable due to too many buttons in one row, two rows of buttons glued together are acceptable
- Admins can upload/remove sounds and edit display name and loudness.
- Upload is one section, update is another one, you insert the filename (without .mp3) and can edit all the important information.
- Changing loudness is actually reflected on /soundmeme while the sound is being played
- Changing display name should change the file name too, renaming it to lowercase letters and numbers only version (spaces and special characters removed) - follow the current naming scheme in public/sounds/soundboard.
- Duplicate name does not let proceed, even if the display name is different, but the file name would be the same.
- Validate file type (mp3 only), max length (max 10s for admins, users will be able to add them too in another part, for them 3s length max, just mentioning it if it changes the approach, but for now focus on 10s limit), gather all needed data (file (local upload), display name (file name applied automatically), price (if not set, is not an exception, if set, treat as an exception), loudness (by default 100% or 1))
- Upload the file into the soundboard folder, update the database, make the file visible in the store
- Reject unsafe or unsupported uploads; do not expose arbitrary server paths.
- Safely replace/remove files without overwriting unrelated assets.
- Preserve separate asset identity, metadata, shop availability, and ownership - change of name does not result in losing the item.
- All changes should be reflected in the database collection.

### D2. Emoji asset administration

Status: `[~]`

Depends on: C1, C3, C4.

Emoji uploads validate image signatures and dimensions, support animated GIF
files using their `.gif` extension, and use the shared C3 price model. Rename
preserves asset identity and ownership while updating stored chat shortcodes
and notifying connected clients to refresh emoji URLs. Focused Flask tests
cover authorization, validation, cross-format duplicate names, rename, and
removal. Real-account/browser rendering remains unverified, so the full
acceptance criteria are not yet verified.

Acceptance criteria:

- In the admin page, a new section "Emoji" needs to be created (shown along with Users/Admin/Pricing)
- If text becomes unreadable due to too many buttons in one row, two rows of buttons glued together are acceptable
- Admins can upload/remove emoji assets and rename them.
- Upload is one section, update is another one, you insert the filename (without .jpg/png) and can edit all the important information.
- Changing name should also update the filename.
- Duplicate name does not let proceed, even if the format is different (one name even if one is png and one is jpg).
- Validate file type (jpg, jpeg, png, and animated gif), max size (2048x2048 for admins, 1024x1024 for users, but for now focus on admin), gather all needed data (file (local upload), name lowercase letters and numbers only, no special characters allowed, price (if not set, is not an exception, if set, treat as an exception))
- Preserve asset identity and existing ownership when names change.
- Do not expose arbitrary server paths or damage unrelated assets.
- Change of name should update the chat history. Update the database entries and make sure chat looks the same (the emojis stay despite the different name).
- All changes should be reflected in the database collection.

### D3. Per-account asset visibility and ownership

Status: `[~]`

The database-backed catalogs, per-account ownership checks, C3 price
integration, soundboard filtering, and emoji composer/chat-rendering split are
implemented. Backend tests cover ownership filtering and admin capability
access. A mocked browser DOM check verified that the picker rendered only the
two usable emojis from a three-emoji public catalog, with a wrapping flex
layout and no hidden item slots. Cross-viewer rendering, owned/unowned
shortcode behavior with real accounts, and sound playback remain unverified;
no chat message was sent, so end-to-end ownership visibility is still awaiting
verification.

Depends on: C1, C3, C4, D1, D2.

Acceptance criteria:

- Sounds and Emojis should have their own mongodb collections.
- For sounds we need an id, a name, a displayed name, loudness (percentage wise, but can be for example 0.5) and a price.
- For emojis we need an id, a name and a price.
- Possible "is exception" flag field if needed to adjust the price from the default one.
- Changing price in admin console changes the price.
- Initially ordinary accounts have zero unlocked sounds and emojis.
- Tie ownership through ids on the database side.
- Users can see/use only owned or otherwise entitled assets. For sounds this applies to the soundboard. For emojis this applies for the emoji panel in chat.
- Users can hear/see assets used by other users. For example if user A buys emoji X and sends it in chat. User B can see it despite not being able to use it.
- If user B tries to use the emoji by writing its name :emojiname:, no image gets loaded, because he doesn't have it purchased.
- Admins can access every asset without purchase limits; enforce this on the
  backend through database permissions collection.
- Prevent users from claiming another account's ownership.
- Renaming an asset does not break existing ownership.
- Keep uploaded, available, owned, and usable states distinct.
- VIP half price does not carry over to the shop, it stays tied to the "Send Your Chaos" usage.

### D4. Point Shop

Status: `[~]`

The C3-backed catalog, idempotent backend purchase flow, and Point Shop
interface are implemented. The approved 66 sound and 76 emoji registration
overrides were removed narrowly; all registered assets now inherit their
configured C3 defaults. Backend tests cover the purchasable, owned, and
unavailable ordering; mocked browser checks verified that order and search
filtering in both categories. A mocked Admin browser flow verified editing an
existing exception to `-1` and reloading it. Purchase, local sound preview,
and the Admin-save-to-Shop refresh have not been verified with real accounts.
No live purchase was made, so the full acceptance criteria remain unverified.

Depends on: C1, C3, C4, D1, D2, D3.

Acceptance criteria:

- Create another panel, just like "Send Your Chaos", "Admin", "Chat.". Keep the same measurements.
- Provide categories Emojis, Sounds, and Add (formerly Extra), using the existing
  joined-button/category-switching pattern where appropriate.
- Show item name, applicable cost, and owned/purchasable/unavailable
  state.
- Allow local sound preview before purchase.
- Initial ordinary sound and emoji price is set by admin panel, stored by mongodb.
- Exceptions are set in the admin panel, stored by mongodb.
- Purchased sounds and emojis become usable by their owner and appear in the
  appropriate sound/emoji lists and chat UI.
- Enforce ownership and price server-side; prevent duplicate purchase,
  duplicate charge, and inconsistent balance updates, solve through database.
- Admins do not see the panel, since they have access to everything, enforce admin ownership through permissions rather than assigning every item to an admin. Solve through permissions collection.
- Order for all 4 panels should be: Desktop (left to right): Admin, Point Shop, Send Your Chaos, Chat. Mobile (top to bottom): Send Your Chaos, Chat, Admin, Point Shop. Whenever a role does not see a panel because of permissions, it is skipped in the order.

### D5. Add your own asset proposals

Status: `[~]`

Backend validation, charging, ownership, exclusive availability, proposal UI,
and focused regressions are implemented. Real-account proposal submission and
resulting asset use have not been verified.

Depends on: C1, C3, C4, D1, D2, D3, D4.

Acceptance criteria:

- Offer custom sound and emoji adding in Add (renamed from Extra) in Point Shop
- Fields the same as for admin except price, can be added from url or local file
- Has an "exclusive" toggle, if toggled, sets price to -1, otherwise sets price to default
- Cost based off of "Add your own" in Admin Panel -> Pricing
- Admin Panel -> Pricing should have a separate field for exclusive item per category called "Add your own (exclusive)" and set to 100000 for now. (Database compatibile)
- For exclusive the point is for the submitting user to pay more, but be the only one who can use the emoji (aside from Admin).
- Limits for sounds: must be .mp3, must be under 3 minutes. Limits for emojis, must be 1024x1024px max and must meet the format requirements of D2
- Proposed emoji images are square, non-square emojis are stretched
- Make sure database writes only after the file has been received (make sure it's true also for D1, D2)
- In the Add section of Point Shop make sure to keep these sub-sections one under another, emojis first, soundboard second.
- Icon for this button can be something related to upload

### D6. Admin custom assets limitations management

Status: `[x]`

Pricing-backed limits are implemented for Admin and Point Shop uploads, with
focused validation and TypeScript checks. MongoDB defaults were verified.

Depends on: C1, C3, C4, D1, D2, D3, D4, D5

Acceptance criteria:

- In admin panel -> pricing make Emoji and Soundboard sections hidden by default (The same as Exceptions), make them openable like exceptions
- Add a field for limitations per category: emoji: max px side (show the current value being 1024, make sure it's db verified) and max px for edmin (2048) (names Max px, Max px (admin)), for sounds: Max length and Max length (admin) -> respectively 3s and 10s
- Make sure changing these values updates the actual limits

### D7. Pinning favorite sounds + separately priced sounds

Status: `[~]`

Favorites are stored per account in MongoDB, play pricing is independently
configurable from purchase pricing, and focused regression tests pass. The
favorite ordering and play-price flow have not been verified in a real browser
session.

Depends on: C1, C3, C4, D1, D2, D3, D4.

Acceptance criteria:

- Make the sound board in Send Your Chaos look like soundboard shop - one sound per row
- Change the sound's purchase cost to sound play cost, remove the cost icon next to the search bar
- Change "Buy" button to "Play"
- Add an empty star icon befor the "Play" button, when pressed, it fills up (use the accent page color, here it would be the shade of pink being used), pressing again makes the star empty again - this is called "Adding to favorites"
- When added to favorites by a specific user, appears on top of the list, all the favorite ones are kept in the order from added to favorites the longest time ago (top) to newest (bottom), the non-favorites stay in A-Z order
- Make mongodb based, not frontend based
- In database add a separate cost for a sound playing, handle it like with exceptions - if not specified, keep the current default cost (10 points), if default cost changes, update
- Keep halved costs for VIP, even for exceptions
- -1 values not allowed here
- In admin panel in Pricing under soundboard under Default price add Default play price, set to 10 for now, make sure it's mongodb backed
- In admin panel in Pricing under soundboard add Play exceptions ([number]) under normal Exceptions, make it openable as well
- A sound can be either an exception for play price, exception for buy price or both, needs 2 flags
- In admin panel in Soundboard after loading info about the item, add "Play price" under "Price" and let it be changed from there, behavior like in admin panel -> Pricing
- Make Upload sound/Upload emoji sections hidable due to the amount of info available at once making it a scrollable element by default, while I'd rather make that optionable

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
