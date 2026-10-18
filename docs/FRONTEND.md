# Frontend Reference

React 18 SPA built with Vite. Source lives under `frontend/src/`.

## Browser Support

The frontend uses Tailwind CSS v4, which requires Safari 16.4+, Chrome 111+, or Firefox 128+. Older browser versions are not supported by this frontend build.

## Installable web app

The app can be added to an iPhone Home Screen (Share, then Add to Home Screen) and runs in its own window. This is installability only: there is no service worker yet, so nothing works offline.

- `public/manifest.json` declares `id`, `scope`, `start_url: /`, `display: standalone`, `theme_color`/`background_color` `#08080f` and four icons (`any` and `maskable`, 192 and 512 px).
- Icons live in `public/icons/` with a version suffix in the filename (`pc-*-v3.png`). nginx serves `.png` as `immutable` for a year, so a changed icon needs a new filename, not a query string. The older root icons stay for `og:image` and proxy allow-lists.
- `index.html` links the 180 px opaque `apple-touch-icon` and sets the iOS meta tags (`apple-mobile-web-app-capable`, `mobile-web-app-capable`, `apple-mobile-web-app-title`, `apple-mobile-web-app-status-bar-style=black`).
- `AppNav.jsx` pads the top strip and positions the floating Home button with `env(safe-area-inset-*)`, so they clear the notch and home indicator.
- Standalone detection (not used by any component yet): `navigator.standalone === true || matchMedia('(display-mode: standalone)').matches`.
- nginx revalidates `/`, `/index.html`, `/manifest.json` and SPA deep links (`Cache-Control: no-cache`); the security headers live in `nginx-security-headers.conf`, which `nginx.conf` includes in every location that sets its own `add_header`.
- `scripts/pwa-assets.test.mjs` and `scripts/nginx-config.test.mjs` guard these files and run as part of `npm test`.

## Service worker (opt-in)

The service worker is off by default. `PWA_ENABLED=true` on the frontend container turns it on; user-facing behaviour is in [`PWA.md`](PWA.md), the design in `PWA_OFFLINE_DESIGN.md` §6.3.

- `src/sw/sw.js` is the worker: a classic script with no imports and two build-time placeholders (`__BUILD_ID__`, `/*__PRECACHE__*/`) that are valid JavaScript unreplaced. `src/sw/sw.kill.js` is the kill worker.
- `npm run build` runs `vite build` and then `scripts/build-sw.mjs`, which writes `dist/sw.real.js` and a byte-identical `dist/sw.js`, copies `dist/sw.kill.js`, prints the precache size and fails above 12 MiB. `index.html`, `robots*.txt` and `sw*.js` are never precached; the HTML shell is fetched at install and kept only if every `/assets/*` it references is in the manifest.
- At container start `docker-entrypoint.d/45-configure-pwa.sh` (after `40-configure-public-mode.sh`, which resets `index.html`) copies `sw.real.js` or `sw.kill.js` over `sw.js` and inserts `<meta name="pokecollector-pwa" content="sw=1;queue=0">`. `src/pwa/flags.js` reads it; without the tag the build-time `VITE_PWA_DEFAULT=on|off` applies (default off).
- `src/pwa/register.js` registers the worker (production, secure context, flag on), checks for updates when the app returns to the foreground, handles `?pc_sw=off` and exposes `addUpdateGuard(fn)` so features can block an update while work is in flight. `components/pwa/UpdateBanner.jsx` shows the update bar.
- `src/utils/memoryBlob.js` copies upload files into memory when a PWA flag is on (WebKit empty-body bug); `api/client.js` uses it for its six multipart uploads.
- Tests: `src/sw/sw.test.js` (worker loaded in a `node:vm` context), `scripts/build-sw.test.mjs`, `scripts/configure-pwa.test.mjs` run in `npm test`. `npm run test:pwa` builds with `VITE_PWA_DEFAULT=on`, serves `dist/` on port 4175 and drives real Chromium (`tests/pwa/`; install the browser with `npx playwright install chromium`).
- Shell scripts must keep LF line endings (`.gitattributes`); a CRLF entrypoint fails inside the container.

## Route Table

Routes are defined in `frontend/src/App.jsx`.

| Route | Component File | Notes |
|------|----------------|-------|
| `/login` | `pages/Login.jsx` | Multi-user login screen |
| `/` | `pages/HomeScreen.jsx` | Portal-style home screen |
| `/dashboard` | `pages/Dashboard.jsx` | Portfolio summary |
| `/search` | `pages/CardSearch.jsx` | Card search, scanner entry, and multi-select bulk add |
| `/scans` | `pages/ScanQueue.jsx` | Persistent scan inbox |
| `/scans/:jobId` | `pages/ScanQueue.jsx` | Review one queued scan job |
| `/offline` | `pages/OfflineCenter.jsx` | Sync center: connection, waiting items, storage, capabilities, reset (needs `OFFLINE_QUEUE_ENABLED`; redirects to `/` otherwise) |
| `/collection` | `pages/Collection.jsx` | User collection |
| `/collection/user/:userId` | `pages/UserCollection.jsx` | Read-only view of another user's collection |
| `/pokedex` | `pages/Pokedex.jsx` | Grouped or exact-form National Pokédex completion overview |
| `/pokedex/:dexId` | `pages/PokedexSpecies.jsx` | Species/form detail, related forms, and exact matching card printings |
| `/sets` | `pages/Sets.jsx` | Set browser |
| `/sets/:setId` | `pages/SetDetail.jsx` | Set checklist |
| `/wishlist` | `pages/Wishlist.jsx` | Wishlist and alerts |
| `/binders` | `pages/Binders.jsx` | Unified Binders, Planned Binders, Planned Decks, and Real Decks |
| `/binders/:binderId` | `pages/BinderDetail.jsx` | Binder or Planned Binder detail |
| `/decks` | redirect | Redirects Card List discovery to `/binders` |
| `/decks/inventory` | redirect | Legacy redirect to `/binders` |
| `/decks/compare` | `pages/DeckCompare.jsx` | Side-by-side Deck comparison |
| `/decks/:deckId` | `pages/DeckEditor.jsx` | Planned or Real Deck editor |
| `/decks/:deckId/build` | redirect | Legacy Deck Builder redirect |
| `/analytics` | `pages/Analytics.jsx` | Analytics tabs |
| `/products` | `pages/Products.jsx` | Sealed products |
| `/trades` | `pages/Trades.jsx` | Trade journal and valuation |
| `/leaderboard` | `pages/Leaderboard.jsx` | Multi-user leaderboard |
| `/leaderboard/compare/:userId` | `pages/Compare.jsx` | Trainer comparison |
| `/achievements` | `pages/Achievements.jsx` | Current user achievements |
| `/achievements/:userId` | `pages/Achievements.jsx` | Another user's achievements |
| `/settings` | `pages/Settings.jsx` | App settings and admin tools |
| `/migration` | `pages/CardMigration.jsx` | Custom card migration queue |
| `/u` | `pages/PublicDirectory.jsx` | Anonymous public trainer directory |
| `/u/:handle` | `pages/PublicProfile.jsx` | Anonymous public trainer profile |
| `/u/:handle/decks` | `pages/PublicProfile.jsx` | Anonymous shared Deck directory for one trainer |
| `/u/:handle/binder/:binderId` | `pages/PublicBinderView.jsx` | Anonymous shared collection Binder |
| `/u/:handle/wishlist` | `pages/PublicWishlistView.jsx` | Anonymous searchable, filterable public Wishlist |
| `/u/:handle/deck/:deckId` | `pages/PublicDeckView.jsx` | Anonymous read-only Deck cards, validation, analytics, and probabilities |
| `/__card-system` | `pages/CardSystemGallery.jsx` | Development-only shared component gallery |

## Auth Flow

### `AuthContext`

Defined in `frontend/src/contexts/AuthContext.jsx`.

Responsibilities:

- Fetches `/api/auth/mode` on startup
- In single-user mode, attempts `/api/auth/me` without a token
- In multi-user mode, restores user from stored token if present
- Exposes:
  - `user`
  - `loading`
  - `status` (`loading`, `ready`, `offline` or `degraded`)
  - `offline` (`degraded` or `offline`)
  - `multiUser`
  - `loginUser(token, userData)`
  - `updateCurrentUser(updates)`
  - `logout()` (async; asks the offline logout guard first)
  - `setLogoutGuard(fn)`

With the offline queue flag on, a failed startup with a valid cached sign-in (`pc.auth.snapshot`, see `docs/PWA.md`) sets `status` to `degraded`: the cached user is shown, the retry timer keeps running and a success returns to `ready`. `OfflineProvider` (`src/offline/`) owns the outbox and registers the logout guard.

Security-related behavior:

- `logout()` removes token and user from local storage
- Logout forces a full page reload to clear cached React Query data and prevent cross-user leakage
- Axios also clears auth state on `401`

### Login and Password Change

- `pages/Login.jsx` is only used when `multiUser === true`
- `App.jsx` defines an inline `ForcePasswordChangeScreen`
- If `user.must_change_password` is true, normal app routes are blocked until `/api/auth/me/force-password` succeeds

## Settings & Localization

### `SettingsContext`

Defined in `frontend/src/contexts/SettingsContext.jsx`.

Provides:

- `settings`
- `updateSettings(updates)`
- `t(path)`
- `language`
- `priceDisplay`
- `pricePrimary`
- `pricePrimaryField`
- `currency`
- `currencySymbol`
- `exchangeRate`
- `formatPrice(eurAmount)`
- `formatUsdPrice(usdAmount)`

Notes:

- Translation bundles are loaded from `frontend/src/i18n/` and wired in `SettingsContext`
- UI languages include all supported TCGdex language codes, plus Swedish. Regional variants such as `es-mx`, `pt-br`, `pt-pt`, `zh-tw`, and `zh-cn` are selectable from a compact dropdown in Settings.
- Legacy stored `zh` settings are normalized in the frontend to `zh-cn` for display
- USD display uses exchange rates from the backend Frankfurter endpoint

### `useTheme`

Defined in `frontend/src/hooks/useTheme.js`.

- Stores the selected theme in `localStorage`
- Applies theme via `data-theme` on `document.documentElement`
- Available themes:
  - `default`
  - `fire`
  - `water`
  - `grass`
  - `electric`
  - `psychic`
  - `dragon`
  - `dark`
  - `fairy`

## Navigation

### Home / Portal Navigation

- `pages/HomeScreen.jsx` is the main portal view
- The app now uses a compact navigation pattern with 6 primary portal items on the home screen
- Secondary sections are organized with grouped tabs on individual pages

### `TabNav`

Defined in `frontend/src/components/TabNav.jsx`.

- Reusable horizontal tab bar
- Marks a tab active if the current pathname equals or starts with the tab path
- Used by pages such as `Dashboard`, `Collection`, `Wishlist`, `Binders`, `Analytics`, `Products`, `Leaderboard`, and `Achievements`

### `Layout` and `AppNav`

- `components/Layout.jsx` wraps protected routes
- `components/AppNav.jsx` shows the current page title and multi-user logout control

## Key Screens

### `pages/Login.jsx`

- Multi-user login screen
- Supports quick return to the last signed-in user via `lastUser` and `lastUserAvatar` in local storage

### `pages/Leaderboard.jsx`

- Social ranking view for multi-user mode
- Uses `TabNav`

### `pages/Compare.jsx`

- Side-by-side trainer comparison
- Route parameter: `userId`

### `pages/Achievements.jsx`

- Shows achievements for current user or another user when `:userId` is present

### `pages/Settings.jsx`

- Mixes per-user preferences and admin-only controls
- Admin users can enable multi-user mode from Settings
- When multi-user mode is enabled, admin users see a **Users** tab
- The **Users** tab supports creating users, editing usernames/roles/passwords, activating/deactivating users, deleting other users, and forcing first-login password changes
- Includes:
  - profile name editing
  - avatar picker
  - theme picker
  - app language, primary/display price source, currency, and portfolio-basis controls
  - owner-photo preference and delete-all owner-photo action
  - cross-language price/image fallback preferences and digital-set visibility
  - public-profile, public-handle, and optional public-value controls
  - TCGdex sync-language selection for admins
  - Telegram configuration and guided Gemini/OpenAI-compatible scanner setup
  - administrator-only tested custom scanner models and server setup summary
  - per-user scanner diagnostics consent and explicit stored-data deletion
  - sync controls
  - auth mode toggle
  - backup and restore
  - Community sections for contributors and supporters

The supporter section calls the installation's own
`/api/community/supporters` endpoint once whenever the Community view is
entered. It retains the last valid result only in the browser's in-memory query
cache, hides that cache while the entry fetch is pending or after it fails, and
performs no timed, background, or focus-based refreshes. Above the supporter
cards it shows the supporter count, combined donation count, and exact
known-currency totals grouped by currency; mixed-currency records are identified
instead of being combined into a misleading amount. The browser never calls the
public website registry directly, and no supporter projection is persisted by
the installation.

### Collection and Card Lists

`pages/Collection.jsx` owns filtering, strict CSV import, export actions,
printing-detail tags, and private owner-card photos. Owner photos are loaded
through authenticated endpoints and can be preferred over catalogue artwork in
the current user's UI.

`pages/Binders.jsx`, `pages/BinderDetail.jsx`, `pages/DeckEditor.jsx`, and
`pages/DeckCompare.jsx` share the Card List domain. Physical Binders and Real
Decks allocate exact owned copies from one capacity pool. Planned Binders and
Planned Decks store requirements without reserving inventory. The Deck editor
adds validation, composition, shortage, legality, probability, duplicate, and
planned/real conversion tools. See [`CARD_LISTS.md`](CARD_LISTS.md).

### Search, Pokédex, products, and trades

`pages/CardSearch.jsx` keeps free text and advanced filters in the URL. Filters
cover number, set, category, type, subtype, rarity, HP range, artist, rule text,
language, sort, and pagination. Text matching is accent-insensitive; card-code
queries such as `PFL 001` use the same route. The Pokédex detail screen applies
the compatible `dex_id` filter in Grouped mode and `pokedex_entry_id` in
Separate forms mode when it loads matching printings.

`pages/Pokedex.jsx` derives owned/missing species or form entries from collection data and
supports search, generation/region, and status filters. It uses German species
metadata when the app language is German and English metadata otherwise.
`pages/PokedexSpecies.jsx` reuses the card grid for grouped or exact-form printings and related-form navigation.

`pages/Products.jsx` covers sealed/opened product lifecycle, batch entry,
images and Cardmarket links, linked pulls, sales/flat gains, and realized versus
unrealized results. `pages/Trades.jsx` previews values and records editable
incoming/outgoing card and cash changes while keeping the collection in sync.

### Public profile routes

The `/u` route tree is intentionally outside `ProtectedRoutes`. It consumes
only `/api/public/*` serializers, not authenticated collection responses. The
admin master switch and trainer opt-in gate the public profile. Collection
Binders and Decks require individual opt-ins, while the Wishlist uses a
profile-wide Private, Trade matches, or Public choice. The separate
value-visibility preference controls whether prices are returned.

`PublicProfileShell` and `TabNav` provide one Binders/Wishlist/Decks profile
layout. Public card grids use `CardListGallery` in catalogue-only public mode;
public Decks reuse `DeckCompositionBar`, `DeckValidationPanel`, and
`DeckAnalyticsPanel`. The public mode never invokes owner-photo or authenticated
collection-card presentation, and Deck comparison is omitted because it depends
on private user-owned lists. Reverse-proxy installations must also allow the narrow route set in
[`REVERSE_PROXY_AUTH.md`](REVERSE_PROXY_AUTH.md).

## Card UI

### Shared card system

Feature pages import the public API from `frontend/src/components/card-system`. Its high-level components are `CardDisplay`, `CardRow`, `CardIdentity`, `CardDialog`, `CardLegend`, and `CardStack`.

The system centralizes card structure, borders, image handling, badges, ownership and unavailable states, responsive behavior, and keyboard/touch interactions. Pages supply data, layout, and actions rather than assembling their own card visuals.

Approved `CardDisplay` variants include `grid`, `carousel`, `ranking`, `selectable`, `artwork`, and `compact-artwork`. A development-only component gallery is available at `/__card-system`.

See [`CARD_SYSTEM.md`](CARD_SYSTEM.md) for usage, design tokens, review guidance, and the contributor-friendly process for proposing a new shared variant.

`CardItem.jsx`, `UnifiedCard.jsx`, and the low-level state components remain implementation details of this public system and should not be imported by feature pages.

`ImageZoomOverlay.jsx` provides the shared click/touch artwork inspection used
outside scanner comparison. It supports zoom, pan, keyboard close, and preserves
the normal Card Display click contract. Printing-detail badges and the unified
primary-price presentation are supplied through the same shared card state so
feature pages do not invent competing labels.

### `pages/CardSearch.jsx`

- Main search UI for locally cached TCGdex cards and matched custom cards
- Supports select mode for search results
- Can select the current page or all matching search results
- Bulk-add sends selected cards to `/api/collection/bulk-add` with default quantity `1`, condition `NM`, no variant, no purchase price, and the card language
- Bulk-add success toast reports added, updated, and failed counts

### Scanner and review inbox

`components/UnifiedCardScanner.jsx` is the capture-only entry point. It supports the native device camera and gallery uploads, stages one or more photos, allows per-photo individual recognition overrides, and includes an optional positioning guide beside **Take photo**. Every submission enqueues a persistent job and routes to the same review inbox, including a one-photo scan.

`pages/ScanQueue.jsx` and `components/ScanReview.jsx` show job progress, retry countdowns/reasons, sanitized source photos, ranked candidates, failed items, individual retry, dismissal, and collection-add review. The navigation badge counts outstanding items. A confirmed candidate id is sent when resolving an item so opted-in diagnostics can be labelled with human-reviewed ground truth.

Opening a candidate starts a full-screen linked pan/zoom comparison (`CardZoomModal`, `useLinkedZoom` in `components/ScanReview.jsx`): scroll or click to zoom toward the pointer (up to 6x), drag to pan, arrow keys step through the other candidates for that photo while the zoom/pan position is preserved, and Escape backs out of the zoom before closing the modal. Candidate images load progressively (`useCandidateFullImage`): a blurred thumbnail stand-in shows instantly and crossfades to the full-resolution image once decoded, sourced from the backend's candidate-image cache with a CDN fallback. Thumbnails are prefetched as soon as a photo's candidates arrive; the high-resolution image prefetches on hover/touch (`usePrefetchMatchImages`, `prefetchImage`). Accepting a match from the zoom view routes through the same add-to-collection modal used elsewhere — there is no auto-accept — and atomically adds and resolves the scan before automatically opening the next unresolved photo in the job (`openNextReview` in `ScanQueue.jsx`), so a failed request stays on the current review and a batch can be cleared without returning to the list between cards. A candidate whose printed set total contradicts the recognized photo shows a ⚠ badge in the grid. Once an item is resolved it collapses to a compact green-check row (recognized name and number), re-expandable as a read-only review on click, so a long batch stays scannable without allowing the same scan to be added twice.

Rate-limit countdowns distinguish daily quota from ordinary throttling. Queued
photos remain available only while their item needs review and are deleted on
confirmation/dismissal; jobs expire after 14 days. Before an atomic
add-and-resolve request, the frontend retains the source Blob in memory. When
the confirmed card has no catalogue or custom fallback artwork, it then makes a
best-effort upload into the user's private collection-card photo storage.
Failure to retain that optional copy never rolls back the collection add.

The AI/Card Scanner section in `pages/Settings.jsx` shows **Share scanner diagnostics** as an available control only when the server configured writable `SCAN_TRACE_DIR` storage. The toggle is off by default. Turning it off stops future tracing without deleting existing data; the adjacent confirmed delete button removes all stored diagnostics for the current user and remains available through the stable cleanup path when new collection is disabled.

## API Layer

`frontend/src/api/client.js` is the central Axios client.

Notable frontend API bindings include:

- auth mode and force-password endpoints
- GitHub community endpoints
- social endpoints for leaderboard / compare / achievements
- selective backup download via `downloadBackup(include)`
- Card List/Deck allocation and conversion endpoints
- product lifecycle, linked-card ledger, and trade endpoints
- Pokédex, profile, and anonymous public-profile endpoints
- authenticated collection-card photo and printing-detail-tag endpoints

## Offline outbox

`frontend/src/offline/` holds the client side of the offline queue designed in `docs/PWA_OFFLINE_DESIGN.md` (§6.2). The library is wired in by `OfflineProvider` (P5) and the sync center (P6); the scanner does not queue yet. Items are kept in IndexedDB and replayed from the page (Safari has no Background Sync); the server's `Idempotency-Key` contract makes a repeated send harmless.

### Module map

| Module | Role |
|--------|------|
| `constants.js` | Every tunable of design §6.2.1, plus `uploadTimeoutMs(bytes)` and `attemptTimeoutMs(item)` |
| `uuid.js` | `uuidv4()` from `crypto.getRandomValues` (never `randomUUID`) |
| `debug.js` | `applyDebugParams()`, `debugFlag(name)` — see flags below |
| `capabilities.js` | `getCapabilities()` by feature detection only |
| `outbox/db.js` | `openOutboxDb()`, ordered `migrations`, `versionchange` handling |
| `outbox/store.js` | `createStore(db)`: enqueue, claim, outcomes, retry/edit/discard, history, meta — single transactions, compare-and-set |
| `outbox/states.js` | State transition table as data, `canTransition()` |
| `outbox/classify.js` | Table-driven HTTP outcome classification (`classifyResponse`) |
| `outbox/probe.js` | `/api/health` reachability probe and banner tracking |
| `outbox/backoff.js` | Full-jitter backoff and `parseRetryAfter` |
| `outbox/lease.js` | Single-flight lease row in `meta` |
| `outbox/events.js` | `BroadcastChannel` change notifications with a `storage`-event fallback |
| `outbox/replay.js` | The replay session (probe → claim → fetch → classify → apply), circuit breaker, 429 pause |
| `outbox/ops/*.js` | `scanUpload`, `collectionAdd`, `wishlistAdd`: request builders, response validators, post-sync cache invalidation |
| `outbox/index.js` | `createOutbox({ctx, flags, fetchImpl, now, rng, queryClient, …})` |
| `durability.js` | `requestPersistence()`, `readEstimate()`, canary (`initCanary`/`checkCanary`), `ageWarning()` (design D12) |
| `routes.js` | `OFFLINE_ROUTES` and `isOfflineRoute(pathname)`: pages that stay usable while the server is unreachable |
| `useOffline.js` | `useOffline()`: two failed probes or `navigator.onLine === false` |
| `syncToasts.js` | Coalesced "synced" / "failed" toasts and the last-synced time |
| `OfflineProvider.jsx` | Owns the outbox, the logout guard (`runLogoutGuard`), storage protection and the eviction notice |

### Sync center components (P6)

All render nothing unless `OFFLINE_QUEUE_ENABLED` is on.

| Component | Role |
|-----------|------|
| `components/sync/SyncIndicator.jsx` | Floating button (offline / waiting / syncing / needs attention) mounted once in `Layout`; opens the sheet |
| `components/sync/SyncSheet.jsx` | Sheet with Sync now, Automatic sync, item list (Retry / Discard), storage lines; also exports `SyncControls`, `SyncItemList`, `StorageSummary` for `/offline` |
| `components/sync/OfflineBanner.jsx` | Banner at the top of `Layout` while offline |
| `components/sync/EvictedNotice.jsx` | Blocking notice when the browser removed the offline database |
| `components/OfflineUnavailable.jsx` | Replaces pages that need the server while offline (anything outside `OFFLINE_ROUTES`) |
| `components/pwa/InstallHint.jsx` | iOS "Add to Home Screen" card (Home and `/offline`) |

### Item states

States: `pending`, `sending`, `retry_wait`, `blocked` (`lastError.code` is `auth`, `proxy`, `wrong_account`, `server_old` or `newer_schema`), `failed`. Terminal: `sent` (item deleted, history row written) and `cancelled` (item and photos deleted).

| Trigger | Result |
|---------|--------|
| Enqueue committed | `pending` |
| Claim (compare-and-set) | `sending` with an expiring claim |
| Valid 2xx JSON | `sent` (also for `Idempotent-Replayed: true`) |
| Network error, timeout, 500, 502/503/504, 409 `idempotency_in_progress` | `retry_wait` (`maybeApplied` when the request may have reached the server) |
| 429 | back to `pending`; the whole engine pauses (`Retry-After` or 60 s, doubling, max 900 s) |
| 401 JSON, HTML/redirect/non-JSON 400-404, 409 `wrong_account`, old server | `blocked` |
| Other definitive 4xx, malformed 2xx, 12 server errors | `failed` |
| Claim expired (app killed) | `retry_wait`, `maybeApplied` |
| User Retry / Edit / Discard | `pending` (Retry keeps the key; Edit of a never-sent add rotates it) / `cancelled` |

### Constants

`PACE_MS` 2000, `PROBE_TIMEOUT_MS` 5000, `PROBE_BACKOFF_MS` 15/30/60/120 s, `JSON_TIMEOUT_MS` 20 s, upload timeout `clamp(30 s + bytes/40 KiB/s, 60 s, 290 s)`, backoff 5 s base / 15 min cap with full jitter, `MAX_SERVER_ERRORS_PER_ITEM` 12, lease 30 s TTL with 10 s heartbeat, `STALE_UNKNOWN_OUTCOME_MS` 12 days, history 100 rows / 14 days, outbox caps 500 items / 300 MiB / 100 MiB kept free, item caps 12 photos / 10 MiB (a single photo may be up to 15 MiB). The authoritative values are in `constants.js`.

### Debug flags

Production builds honour three harmless `localStorage` flags, set by opening `/?pc_debug=<names>` (comma-separated, fixed allow-list; the parameter is stripped afterwards). `/?pc_debug=off` clears all three.

| Name | Effect |
|------|--------|
| `forceUnreachable` | The reachability probe fails without touching the network |
| `forceQuota` | `enqueue` rejects with `{code: 'quota'}` |
| `forceLostResponse` | A replay response is discarded and treated as a network error (tests the lost-response path) |

## Removed / No Longer Documented

- No eBay integration in the current frontend
- No grading UI in the current frontend
