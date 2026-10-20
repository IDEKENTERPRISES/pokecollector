# iPhone UI overhaul — design for PokéCollector

> **Status: design document. Nothing in it is implemented yet.** As each phase ships, current behaviour is documented in `docs/FRONTEND.md` and `docs/PWA.md` (see `CONTRIBUTING.md`: implementation briefs stay clearly labelled). This file stays as the rationale.
>
> Written 2026-10-19 against `origin/deploy` @ `2333043`, which is also where `feature/ios-ui` was cut. This is fork-only work on `IDEKENTERPRISES/pokecollector`. It is not offered upstream as is.
>
> The owner approved it on 2026-10-19 after two rounds of [mockups](https://claude.ai/artifact/FVYGUzcRSuEeLZshZgWJAS). Version 2 added the Pokémon look (OD-E) and sets grouped by series (OD-F).

**Contents:** 0 Owner decisions · 1 Summary · 2 Goals, principles, non-goals · 3 Verified code facts · 4 Information architecture and route map · 5 Screen specs · 6 Shell behaviour · 7 Visual system and tokens · 8 PWA placement · 9 Component inventory · 10 Settings coverage checklist · 11 iOS home-screen constraints · 12 Test plan · 13 iPhone checklists · 14 Phases · 15 Process · 16 Risks · 17 Decisions for the owner · 18 Docs to update · 19 Sources

---

## 0. Owner decisions

These are final (2026-10-19). They override anything below that contradicts them.

- **OD-A, tabs.** The bottom bar is **Home · Collection · (Scan) · Search · Profile**.
  - **Search** holds card search plus Browse: Sets and Pokédex.
  - **Profile** holds Analytics, Sealed products, Trades, Leaderboard, Achievements, Settings, Sync & offline and Log out.
  - **Collection** keeps Cards | Binders | Wishlist. In English the app calls `/binders` "Card Lists" (`nav.binders`); see Q12.
- **OD-B, Scan.** The big middle circle is labelled **Scan**.
  - Tapping it **opens the live camera at once**.
  - **Photos** (library) and **Inbox** buttons are on the camera screen.
  - The flow is "Review (n)" → "Start scanning".
  - If the camera is unavailable, the photo picker is offered instead.
- **OD-C, look.** An **iOS 26 "Liquid Glass" approximation**:
  - a floating, blurred capsule tab bar with the Scan circle in the middle;
  - a **pure black** base (`#000`) that blends into the opaque black status bar, with iOS system grays;
  - the **SF Pro** system font;
  - the owner's accent themes stay;
  - the glow orbs and the animated background gradient go;
  - **dark only**.
- **OD-D, fork only.** `feature/ios-ui` is cut from **`origin/deploy`** and never targets `main` or `upstream`.
- **OD-E, Pokémon look** (after the first mockups, which felt basic, like iPhone Settings and a stocks app). The iOS structure of OD-A to OD-C stays; a Pokémon layer goes on top (§7.12):
  - colour from the Pokémon world: energy-type colours on tiles, chips and cards, and a glow behind each tab's header;
  - Pokémon shapes: a Poké Ball Scan button and shutter, a trainer card with gym badges, HP bars for progress, holo shine on featured cards;
  - cards before money: Home leads with your cards, sets and Pokédex; the portfolio value is one tile, and the chart lives in Analytics;
  - a rounder, chunkier type for titles and numbers (SF Pro Rounded, still a system font);
  - a little playful wording (Q18).
- **OD-F, sets by series.** Sets shows series first: a 2-column grid of series tiles, each with the series logo, its years, its number of sets, and the cards owned out of every card in the series. A series opens a 2-column grid of its sets. A switch in Settings › Appearance, **Show sets in series**, turns this off to show all sets in one grid. The server downloads the official series logos during sync (Q19, an approved backend change, phase P6a).

**Standing rules** (from the owner's memory; they apply to the coordinator and every worker):
- Use a fresh worktree and branch for every phase or fix.
- **No Claude attribution** anywhere that reaches GitHub: no `Co-Authored-By` trailer and no "Generated with Claude Code" line, even if a harness reminder asks for them. Check squash-merge messages too.
- Open and handle PRs with `gh`, called by full path (`C:\Program Files\GitHub CLI\gh.exe`) and always with `--repo IDEKENTERPRISES/pokecollector`.
- Start worker sessions with `model: "claude-sonnet-5-5"` and `effort: "medium"`.
- **Every merge into `deploy` needs the owner's OK.**
- No version bumps.

**Smaller decisions (§17).** The owner answered Q1–Q19 on 2026-10-19 (§17). The answers are as binding as the decisions above.

## 1. Summary

The home-screen app gets the shell of a native iPhone app: a floating glass tab bar with a big Scan button, large titles that collapse, back buttons that name the parent screen, segmented controls, page sheets and iOS menus. On top of that structure sits a Pokémon layer: energy-type colours, Poké Ball shapes, a trainer card, HP bars and holo shine (OD-E). Sets are grouped by series (OD-F). Pages keep their data fetching and business logic; only their chrome changes.

Delivery follows the PWA rollout: P0 (this document and the mockups) → P1 foundations → P2 shell (milestone A, iPhone round 1) → P3–P7 in parallel (milestones B and C, rounds 2 and 3) → P8 polish → P9 cleanup. Every phase is a PR into `feature/ios-ui`; milestones reach `deploy` only with the owner's OK.

## 2. Goals, principles, non-goals

**Goal.** One-thumb navigation with a bottom tab bar, a big Scan button, standard iOS patterns people already know, and nothing that only works with a mouse.

**Principles**
1. **One navigation config** (`src/navigation/navConfig.js`) drives the tab bar, the desktop sidebar, the highlighted tab for each route, the Profile rows and the back targets.
2. **Real iOS patterns, nothing invented:** large titles, back buttons that name the parent, segmented controls, inset grouped lists, page sheets with a grabber, menus and action sheets, 44 pt touch targets.
3. **Change the chrome, not the guts.** Keep queries, mutations, filters and business logic. Replace headers, tab strips and action rows with shared components. Don't move large blocks of code between files: upstream changes keep arriving through `main` → `deploy` → `feature/ios-ui`, and small local diffs keep those merges cheap.
4. **Every screen has a way back.** No dead ends and no hover-only UI.
5. **Fast.** Blur only bars, sheets and menus. No ambient animation. Skeletons, not spinners.
6. **Offline keeps working.** The PWA components keep their logic; only placement and styling change.
7. **Accessible.** Real buttons with labels, `aria-current` on the active tab, WCAG AA contrast, `prefers-reduced-motion`, checked with VoiceOver.

**Non-goals:** App Store or native wrappers; light mode; backend or API changes, except the approved series-logo change (Q19, P6a; ask the owner first if another one ever seems necessary); changing scan recognition, the outbox, the read cache or the service worker; redesigning the public `/u/*` pages (palette only); features beyond the extras approved in §17.

## 3. Verified code facts

Re-checked on 2026-10-19 against `origin/deploy` @ `2333043`, including a real `vite build`. **Correction** marks a point where the brief was wrong or incomplete.

### 3.1 Branches
- `origin/main` = `upstream/main` = `d00efee` (v1.51.6).
- `origin/feature/pwa` @ `9fefec9` is fully merged into `origin/deploy`.
- `origin/deploy` @ `2333043` contains `main`, `feature/pwa`, the scan photo default, the collection added date, dynamic currency (`fa57020`), the security bundle and the Portainer compose files. The local `deploy` in the main checkout is stale (`9486f07`).
- **Correction:** the live batch camera is on `deploy` as `67b49d0`, which came in with the dynamic-currency merge (`d279128`). It is the same patch as `origin/fix/batch-camera` (`ee976b2`), but that branch tip is not an ancestor of `deploy`. `origin/feature/dynamic-currency` (`0bb26b8`) is a separate branch and not an ancestor either.
- `feature/ios-ui` was pushed on 2026-10-19 @ `2333043`.
- There are no open PRs on the fork. CI (`frontend-card-system.yml`) runs on the fork's PRs in about 7 minutes, but only for changes under `frontend/**`, `docs/FRONTEND.md`, `docs/CARD_SYSTEM.md` or `CONTRIBUTING.md`. **Correction:** besides unit tests, the build and both visual suites, CI also runs `npm run test:pwa`.
- Installed versions: React 18.3.1, React Router 7.18.2 in declarative `<BrowserRouter>` mode, Tailwind 4.3.3 (with `@config "../tailwind.config.js"`), recharts 2.15.4, lucide-react 0.323.0, Playwright 1.62.1. Docker (Linux engine) is available on the owner's PC.

### 3.2 Navigation today
- `pages/HomeScreen.jsx` is a portal page. `PORTAL_ITEMS`: Collection, Search (carries the scan badge), Sets, Pokédex, Binders, Analytics, Trades, Leaderboard (multi-user only), Settings. It also has a Logout button (multi-user), an admin price-sync button, the portfolio/capital toggle, value and P&L, a chart with `PORTFOLIO_PERIODS` (1W, 1M, 1Y, Max), four stat tiles, Recently added (12), Top cards (8) and a `CardLegend`.
  - **Correction:** `InstallHint` is rendered by `Layout` under Home (`isHome && <InstallHint />`), not by `HomeScreen`.
  - **Correction:** Home's admin "Sync" calls `POST /sync/prices`. Settings' "Sync prices only" calls `POST /sync/prices/all` (forced). They are different actions.
  - `ProductValueInfo` opens on hover or focus. iOS Safari doesn't focus buttons on tap, so on the iPhone it never opens.
- `components/AppNav.jsx` shows a sticky uppercase title strip (`PAGE_TITLE_KEYS`) with logout and avatar (multi-user), and a floating Pokéball home button fixed bottom-left.
- **Correction:** the shell has no back button, but ten pushed screens render their own: SetDetail ("‹ Sets"), PokedexSpecies, BinderDetail and DeckEditor ("‹ Card Lists"), DeckCompare, Compare ("‹ Leaderboard"), Achievements for another user, UserCollection (`navigate(-1)`, which does nothing on a cold start), ScanQueue's job view, and a detail state in Collection. SetDetail and PokedexSpecies use `useDetailBackNavigation` from `hooks/useListScrollRestoration.js`, which restores list scroll on the way back.
- `components/TabNav.jsx` is used by Collection, Binders and Wishlist (`COLLECTION_TABS`, defined three times), `AnalyticsSectionNav` (Analytics | Products | Dashboard, used by all three pages), Leaderboard and Achievements (`SOCIAL_TABS`, defined twice) and `PublicProfileShell`.
- `pages/Settings.jsx` (1,917 lines) has tabs General, Data & Sync (admin), Notifications, Community and Users (admin + multi-user), built from `SectionHeader`, `SettingsCard` and `SettingsRow`.
  - **Correction:** "Change password" and "Sign out other devices" exist only inside the Users tab, so only admins in multi-user mode can reach them. The server's `PUT /auth/me/password` and `POST /auth/logout-others` accept any signed-in user (Q13).
- Dead code: `BottomNav.jsx` and `Sidebar.jsx` are never imported. **Correction:** `components/ui/OverflowMenu.jsx` has no importers either. The `.bottom-nav*` classes, `.pb-nav` and `--bottom-nav-height` are unused. **Correction:** `.more-sheet-enter` is still used (CardItem, Collection, SetDetail), and so is `.safe-area-bottom` (Sheet).
- `pages/Dashboard.jsx` repeats Home's data. Its value-versus-cost chart already exists in Analytics › Investment, so folding Dashboard into Home loses nothing.
- **Correction:** Analytics' tab order is Duplicates | Top Movers | Rarity Stats | Investment, and it opens on Duplicates (Q15).
- Trades has Live trade | History. Products is "Product Investments".
- **Correction:** Collection's header actions are the grid/list toggle, Add custom card, Manage printing tags, Import CSV, Export CSV and **Export PDF**. Collection has no select mode. Its grid is already 3 columns on phones; CardSearch results are 2.
- Unknown routes under the shell currently render an empty page; there is no catch-all route.

### 3.3 Scanner today
- `components/UnifiedCardScanner.jsx` is a modal opened only from the CardSearch header (a camera button titled "Scan card", next to a Scans button with a badge). It stages up to 50 photos. The per-photo and all-at-once "scan individually" toggles show only with more than one photo and `visual_verification === 'automatic'`.
- "Start scanning": with the queue flag on, `offline/ops/scanSubmit.submitScanBatch`, then `/scans/:id`, `/scans` or the toast "Saved on this device. It will sync automatically." With the flag off, `enqueueScanJob`, then `/scans/:id`.
- `components/BatchCameraCapture.jsx` is portaled to `document.body` (`z-[300]`) and gated by `liveCameraSupported()`. **Correction:** when `getUserMedia` fails, the scanner calls `cameraRef.current.click()` from an async catch, outside a user gesture. iOS may ignore that click, so the fallback must offer real buttons (§5.3).
- `addUpdateGuard` (`pwa/register.js`) is registered by `UnifiedCardScanner` and blocks the update reload while photos are staged or saving.
- The inbox is `pages/ScanQueue.jsx` (`/scans`, `/scans/:jobId`) with `components/ScanReview.jsx`. Badges come from `utils/scanJobs.js` (`scanAttentionCount`, `hasActiveScanJobs`). Offline scan batches are outbox items of type `scan.upload`.

### 3.4 PWA pieces the shell must host
- `components/sync/`: `OfflineBanner` (top strip, test id `offline-banner`), `SyncIndicator` (fixed top-right, hidden when idle, opens `SyncSheet`, test id `sync-indicator`), `StaleDataLabel` (test id `stale-data-label`), `LogoutGuardDialog` (used by `AuthContext.logout()`), `EvictedNotice`.
- `components/OfflineUnavailable.jsx` replaces the page when the route isn't in `offline/routes.js` `OFFLINE_ROUTES`: `/`, `/dashboard`, `/collection`, `/wishlist`, `/sets`, `/sets/:setId`, `/binders`, `/binders/:binderId`, `/search` and `/offline`.
- `components/pwa/`: `UpdateBanner` (portaled, `z-[60]`, with the updating overlay at `z-[70]`), `InstallHint` (iOS Safari, not standalone, outbox flag on; also on `/offline` with `force`), `NotificationsCard` (Settings › Notifications).
- The read cache keeps `collection`, `wishlist`, `dashboard`, `sets`, `set-checklist`, `binders`, `binder-cards`, `scanner-configuration`, `printing-detail-tags` and `investment-tracker`. The dashboard has `new_sets_count`, `products_needing_review_count` and `last_sync`, so Home and the new Profile have their numbers offline.
- **Correction:** some colour classes compile to no CSS at all (checked in the built stylesheet), so those surfaces are see-through today: `bg-card` and `bg-elevated` (SyncIndicator, InstallHint, OfflineUnavailable, OfflineCenter), `bg-bg-primary` (26 uses), `bg-bg-secondary` (14) and `brand-yellow` (14, in the scanner warnings). P1 fixes them centrally (§7.2).

### 3.5 Deploy-only features to keep working
Batch camera; scan photo default and `OwnPhotoPicker`; `AcquiredDateField` and the acquired-date sort; the currency list and exchange-rate cache (`SettingsContext` differs from upstream); `PasswordPromptDialog` before a restore; revocable sessions (`logout` calls `logoutSession()` after the guard). The iOS Password AutoFill markup stays exactly as it is: the names, ids and `autocomplete` values on `login-username(-saved)`, `login-password(-saved)`, `force-change-*`, `change-current-password`, `change-new-password` and `user-form-*`. Never re-add the `webauthn` hint (#24, reverted in #26).

### 3.6 Gotchas
- `index.css` has `#root > * { position: relative; z-index: 1 }`. It beats Tailwind's `.fixed` on any direct child of `#root`, so **every fixed piece of chrome is portaled into `document.body`**. The rule stays (§7.5).
- `#root::before` holds fixed glow orbs, `body` has an animated gradient (`bg-breathe`) and `HomeScreen` has its own floating orbs (`float-orb`). All go.
- **Correction:** inputs under 16 px are not only `.input` (14 px). `.input-sm`, `.select` and `.select-sm` are 12–14 px, and Settings has inline `text-xs` inputs. P1 fixes this with one rule (§6.12).
- `index.html` has `viewport-fit=cover` and `apple-mobile-web-app-status-bar-style=black` (opaque). Keep both. `theme-color` is `#08080f`, but Safari 26 ignores it for home-screen apps.
- `tailwind.config.js` maps `bg`, `bg-surface`, `bg-card` and `bg-elevated` onto `--color-*` variables. `text.primary/secondary/muted`, `border` and the semantic `green/yellow/blue` are hard-coded hex. **Correction:** each `[data-theme]` block also tints the backgrounds, not only the accent.
- Below 1024 px `components/ui/Modal.jsx` renders as `components/ui/Sheet.jsx`. Both lock body scroll with `overflow: hidden`.
- Avatars in AppNav, HomeScreen and Settings load GIFs from raw.githubusercontent.com, which fail offline. Public pages use `/api/pokedex/images/sprites/:id.png`; the shell uses that too.
- The `react-hot-toast` `Toaster` is top-centre with hard-coded colours (`main.jsx`).
- `t()` does no interpolation; counts are composed in code or with `.replace()`. `npm run check:translations` needs keys only in `en.js`.
- **Card system contract** (`docs/CARD_SYSTEM.md`): a screen that shows card indicators also shows the shared legend nearby; dialogs use the floating frame with the close at the top right. See Q14.

### 3.7 Tests that encode today's navigation
Update these to the new navigation with the **same intent**; never delete them.
- `tests/pwa/offline-auth.spec.js`: the Logout button on Home and on `/collection`, the "Hello," greeting, the four-way logout guard.
- `tests/pwa/offline-scan.spec.js`: `/search` + `getByTitle('Scan card')`, then "0/50 Photos".
- `tests/pwa/push.spec.js`: `/settings`, then the "Notifications" tab button.
- `tests/pwa/service-worker.spec.js`, `read-cache.spec.js`, `sync-center.spec.js`: "Hello,", Logout, `offline-unavailable` on `/trades`, `/offline`.
- **Correction:** `tests/pwa/large-image.spec.js` and `offline-banner-probe.spec.js` also exist (both open `/collection`; the probe spec checks `offline-banner`). The PWA config runs page tests in Chromium and WebKit (Desktop Safari).
- `tests/visual/`: desktop (1280×1000) and mobile (390×844) projects. **Correction:** the Linux snapshots are `collection-list` and `analytics-duplicates` (card-pages) **and** `card-system-gallery` and `card-system-dialog` (card-system), each for both projects. Screenshots use `page.locator('main')`. Four DeckEditor tests use `page.locator('header')`, so the shell must not add a second `<header>` element to those pages.
- `playwright.webkit.config.js` runs only `card-system-webkit.spec.js` at desktop size.

## 4. Information architecture

### 4.1 Tab bar

| Slot | Label | Root | Stack |
|---|---|---|---|
| 1 | Home | `/` | — (`/dashboard` redirects here) |
| 2 | Collection | `/collection`, `/binders`, `/wishlist` (three segments of one root) | `/binders/:binderId`, `/decks/:deckId`, `/decks/compare` |
| 3 | **Scan** (circle) | overlay, not a route | The inbox `/scans` and `/scans/:jobId` belong to the Scan section: no tab is highlighted and the circle shows an active ring |
| 4 | Search | `/search` | `/sets` → `/sets/:setId`, `/pokedex` → `/pokedex/:dexId` |
| 5 | Profile | `/profile` (new) | `/analytics`, `/products`, `/trades`, `/leaderboard`, `/leaderboard/compare/:userId`, `/collection/user/:userId`, `/achievements`, `/achievements/:userId`, `/settings`, `/settings/:section` (new), `/offline`, `/migration` |

The Profile tab icon is the trainer's sprite (`/api/pokedex/images/sprites/:id.png`), falling back to a person icon.

### 4.2 Route map

Every route in `App.jsx`. "Back" is the logical parent that `useBack()` falls back to (§6.4). "Own back" marks pages that render their own back link until their phase migrates them; the interim nav bar shows no back button there (§6.5).

| Route | Section | Kind | Back | Compact title (key) | Offline | Own back |
|---|---|---|---|---|---|---|
| `/` | home | root | — | `nav.home` (new) | yes | |
| `/dashboard` | — | redirect → `/` | | | yes | |
| `/collection` | collection | root, segment "Cards" | — | `nav.collection` | yes | |
| `/binders` | collection | root, segment "Card Lists" | — | `nav.collection` | yes | |
| `/wishlist` | collection | root, segment "Wishlist" | — | `nav.collection` | yes | |
| `/binders/:binderId` | collection | pushed | `/binders` | `nav.binders` | yes | yes |
| `/decks/:deckId` | collection | pushed | `/binders` | `nav.binders` | no | yes |
| `/decks/compare` | collection | pushed | `/binders` | `nav.binders` | no | yes |
| `/decks`, `/decks/inventory` | — | redirect → `/binders` | | | | |
| `/decks/:deckId/build` | — | redirect → `/decks/:deckId` | | | | |
| `/search` | search | root | — | `nav.search` (new) | yes (Browse only) | |
| `/sets` | search | pushed | `/search` | `nav.sets` | yes | |
| `/sets/series/:seriesKey` (new) | search | pushed | `/sets` | the series name | **yes (new)** | |
| `/sets/:setId` | search | pushed | `/sets` | `nav.sets` | yes | yes |
| `/pokedex` | search | pushed | `/search` | `nav.pokedex` | no | |
| `/pokedex/:dexId` | search | pushed | `/pokedex` | `nav.pokedex` | no | yes |
| `/scans` | scan | pushed | previous screen, else `/` | `scanner.queueTitle` | no | |
| `/scans/:jobId` | scan | pushed | `/scans` | `scanner.queueTitle` | no | yes |
| `/profile` | profile | root (new) | — | `nav.profile` (new) | **yes (new)** | |
| `/analytics` | profile | pushed | `/profile` | `nav.analytics` | no | |
| `/products` | profile | pushed | `/profile` | `nav.products` | no | |
| `/trades` | profile | pushed | `/profile` | `nav.trades` | no | |
| `/leaderboard` | profile | pushed | `/profile` | `nav.leaderboard` | no | |
| `/leaderboard/compare/:userId` | profile | pushed | `/leaderboard` | `nav.leaderboard` | no | yes |
| `/collection/user/:userId` | profile | pushed | `/leaderboard` | `nav.leaderboard` | no | yes |
| `/achievements` | profile | pushed | `/profile` | `nav.achievements` | no | |
| `/achievements/:userId` | profile | pushed | `/leaderboard` | `nav.achievements` | no | yes |
| `/settings` | profile | pushed | `/profile` | `nav.settings` | no | |
| `/settings/:section` (new) | profile | pushed | `/settings` | section title | no | |
| `/offline` | profile | pushed | `/profile` | `sync.centerTitle` | yes | |
| `/migration` | profile | pushed | `/profile` | `migration.title` | no | |
| `/login`, `/u/*`, `/__card-system`, `/__ios` (new, dev) | outside the shell: no tab bar, no nav bar | | | | | |
| anything else | — | redirect → `/` (new catch-all) | | | | |

Rules:
- Map routes **explicitly** with patterns, never by prefix: `/collection/user/:userId` belongs to Profile even though it starts with `/collection`.
- The back label of a pushed page is its parent's label: `/binders` is labelled `nav.binders` ("Card Lists"), not "Collection".
- Add `/profile` (P2) and `/sets/series/:seriesKey` (P6) to `OFFLINE_ROUTES`; the series page is built from the cached sets list. `/settings` stays online-only; offline its row opens `OfflineUnavailable` with the tab bar still visible.

### 4.3 Entry points and cross-links
- **Scan overlay:** the Scan circle from any tab; Collection's "+" menu ("Scan cards"); "Scan a card instead" on Search's empty and no-results states. Until P6, CardSearch's own camera button also opens it.
- **Scan inbox:** the Inbox button on the camera screen (badge), a Home to-do card ("N scans need review" or "Scans processing"), the badge on the Scan circle.
- **Sets:** the Browse tile in Search (with "N new" from `new_sets_count`), the Sets tile and quick action on Home, and the Home to-do card "N new sets".
- **Analytics:** the Value tile on Home, the Analytics tile on Profile.
- **Sealed products:** the Profile tile (badge), and a Home to-do card when `products_needing_review_count > 0`.
- **Trades:** the Profile tile. **Leaderboard, Badges (Achievements):** Profile tiles and the trainer card's badge row, multi-user only.
- **Settings:** Profile › Settings (root list) › section.
- **Sync center:** `SyncIndicator` → `SyncSheet` → `/offline`; the Profile row "Sync & offline" when the queue flag is on; a Home to-do card "N items waiting to sync".
- **Custom card migration:** a Home to-do card and a Profile row, only while matches are pending, with the count; the existing row in Settings › Data & sync stays.
- **Log out:** the last Profile row, multi-user only. It calls `AuthContext.logout()`, so the guard still runs.
- **Public profile:** the Public page tile on Profile when public profiles are on and the trainer's profile is public.
- **Cards on Home** open `/collection?itemId=…` as today (the card sheet opens in the Collection tab). Opening the card sheet over Home would mean moving Collection's dialog logic out of `Collection.jsx`, which principle 3 rules out for v1.

## 5. Screen specs

The [mockups](https://claude.ai/artifact/FVYGUzcRSuEeLZshZgWJAS) (§17) show each screen at 390×844. Text styles are those of §7.6; strings are existing keys unless marked new.

### 5.1 Home (`/`)
Cards first, money second (OD-E).
1. **Nav bar** (large-title mode). Trailing: `SyncIndicator` when visible, then the hide-values eye (Q1a). The compact title after scrolling is "Home".
2. **Header bloom** in the theme accent and Pokémon yellow (§7.12), masked to black at the top so it meets the status bar without a seam.
3. **Greeting block** in place of the large title: the trainer's sprite (local endpoint) in a ring with Poké Ball colours, and two lines, "Hello," (Subheadline) over the trainer name (Title 1, rounded, heavy). The literal "Hello," stays (`t('home.hello')` + ","), because four PWA specs look for it.
4. **Latest pulls** (new wording, Q18): a carousel of the newest cards from `recent_additions`, 118 px wide, with holo shine; "All" (tint) → `/collection` (its default sort is date added, newest first). The shared `CardLegend` (collapsed) stays near it, as the card-system contract requires.
5. **Stat tiles**, 2 × 2, in type colours (§7.12); each opens its page (the Value tile also has a mode button):
   - **Cards** (Fire): `total_cards`, with "N unique" → `/collection`;
   - **Sets** (Water): `owned_sets`, with "N complete" (sets whose `owned_count` equals `total`, from the cached sets list) → `/sets`;
   - **Pokédex** (Grass, Poké Ball icon): caught out of total, from the `summary` of `GET /pokedex` (cached for an hour; hidden offline when not cached) → `/pokedex`;
   - **Value** (Lightning, dark text): the headline value (Portfolio value or Capital invested, per `portfolio_display_mode`), the change over the last month and a sparkline of it (`investment-tracker`, period 1M). The tile's label is its own small button that switches between Portfolio value and Capital invested (the existing setting); the rest of the tile opens `/analytics`. The tile is a container of these two controls, not one link around them.
   The big chart, the period control, P&L, realized P&L and the product-value note move to Analytics › Investment (§5.7). Under the tiles, a footnote says "Prices updated 12 min ago" (from the cached `dashboard.last_sync.finished_at`), as Q5 promised.
6. **To-do cards**, shown only when the count is non-zero: bright rounded cards with an icon, a title, a line of detail and a button:
   - "N scans need review" (yellow) → `/scans`; "Scans processing…" (spinner) → `/scans`;
   - "N items waiting to sync" → opens `SyncSheet` (queue flag on only);
   - "N custom card matches" → `/migration` (`getCustomMatches`, online only);
   - "N products need review" → `/products`;
   - "N new sets" (blue) → `/sets`.
7. **Quick actions:** four round buttons in type colours with labels: Wishlist (Fairy), Card Lists (Water), Sets (Grass), Analytics (Lightning) (Q4).
8. **Your sets:** a row of the sets closest to complete (from the cached sets list), each with a logo-style title, "owned / total" and an HP bar (§7.12) → `/sets/:setId`.
9. **Top cards:** a carousel of `top_cards` with a rank badge and a price tag on each card. "All" → `/collection?sort=market_price&order=desc` (P5 teaches Collection to read `sort` and `order`; until then the parameters are ignored).
10. **`InstallHint`** (Safari only) as an inset card. It stays rendered by `Layout` under Home's content (§8).

Removed: the portal grid, Home's Logout (now in Profile), the admin price-sync button (now in Settings › Data & sync, Q5), the big portfolio chart (now in Analytics), the orbs, the gold text glow and the uppercase labels. Dashboard's content is covered by Home and Analytics; `/dashboard` redirects to `/`.

### 5.2 Collection (`/collection`, `/binders`, `/wishlist`)
- **Large title** "Collection" with the subtitle "N cards · N sets · £value" (Subheadline; the amount is masked when values are hidden).
- **Segmented control** under the title: Cards | Card Lists | Wishlist (Q12). It switches routes with `replace`, so the segments don't pile up history.
- **Nav bar menus** (trailing):
  - "+": Scan cards (`openScanner()`), Search the catalogue (`/search`), Add custom card (the existing modal), Import CSV (the existing modal).
  - "⋯": Export CSV, Export PDF, Manage printing tags.
  - On Card Lists, "+" holds the page's existing create actions. Wishlist keeps its own actions in a "⋯" menu.
- A header bloom in Pokémon blue and the theme accent (§7.12).
- **Cards view:**
  - a search field ("Search cards...", the existing placeholder);
  - a row of **type chips** (§7.12): All, then each energy type present in the collection, with its symbol. A chip sets the existing type filter, and the chips and the Filters sheet stay in sync;
  - a toolbar row: a Sort menu (the existing nine options, with the current choice checked, then Ascending/Descending), a Filters button with a count badge that opens a page sheet with the existing normal and advanced filters, and a grid/list toggle;
  - **grid:** 3 columns on phones (as today), the card system's tiles with their quantity and variant indicators, plus a soft glow in the card's type colour from a page-level wrapper (no card-system change). Variant chips get the foil look of §7.12 through the card system's own tokens, one shared change reviewed with its checklist. **List:** the existing `CardRow` list (name, set, variant, price).
- Tapping a card opens the card detail (Q14: a page sheet on iPhone with the existing `UnifiedCardDialog` content, including `OwnPhotoPicker`, `AcquiredDateField`, printing tags and price details).
- **Card Lists:** inset rows per list (artwork or icon, name, type, card count, chevron); per-row actions (edit, public, delete) move into a "⋯" menu on the row.
- Binder, deck and compare pages are pushed with "‹ Card Lists". DeckEditor keeps its `<header>` element (four visual tests use it); the shell's nav bar is not a `<header>`.

### 5.3 Scan overlay
- `ScannerContext` (`useScanner()` → `{ isOpen, openScanner, closeScanner }`) is provided by `Layout`. The overlay is portaled into `document.body`, above the tab bar and sheets and below the update banner. It lives **outside the routed `<Outlet>`**, so `OfflineUnavailable` never hides it and offline scanning works from every tab. Closing it returns to where you were.
- **Camera screen** (from `BatchCameraCapture`), full screen, black:
  - top: ✕ (glass circle), the title "Scan", and Inbox (glass capsule with the attention badge and a pulse dot while jobs process);
  - when the outbox holds `scan.upload` items, a status line under the top bar: "N batches waiting to upload";
  - middle: the live video (`object-fit: cover`; the captured frame still holds everything in view), a card-shaped frame guide (63:88, about 70 % of the width, Pokémon-yellow corners, the outside dimmed) and the existing photo-guide hint;
  - bottom: **Photos** (library, multi-select), the shutter, and the **review stack**: the last thumbnail with an "N caught" badge (Q18) and "3/50" under it. Tapping the stack opens the review sheet as "Review (3)";
  - the shutter is a Poké Ball whose top half is the theme accent (Q17, §7.12): 70 px inside a 4 px white ring.
  - At 50 photos the shutter is disabled and the existing limit toast shows.
- **Review sheet** (page sheet over the camera, today's staging UI):
  - title "Review (n)"; leading "Clear" (destructive, confirmed); trailing "Done" back to the camera;
  - a 3-column grid of thumbnails with remove buttons and, when allowed, the per-photo and all-at-once "scan individually" toggles;
  - "Add more": Take photo and Choose from library;
  - the primary button "Start scanning (n)", with a small Poké Ball icon;
  - `submitScanBatch` unchanged, with today's size, storage and server-version errors; `addUpdateGuard` held while photos are staged or saving.
- **After submit:** a sent batch closes the overlay and goes to `/scans/:id` (one job) or `/scans`; a batch saved offline closes the overlay and shows today's toast.
- **Fallback:** if `getUserMedia` is missing, denied or fails, the review sheet opens on its own with **Take photo** (`<input capture="environment">`) and **Choose from library** (`<input multiple>`) as real buttons, so iOS accepts the tap. A denial is remembered for the session (`sessionStorage['pc.scan.cameraDenied']`), so the next tap goes straight to the sheet; a "Try the camera again" link clears it.
- **Closing with staged photos** asks in an action sheet: "Discard N photos?" (Discard, destructive) / Keep. Existing strings.
- **Circle badges:** a yellow count = `scanAttentionCount`; a pulse ring = `hasActiveScanJobs`. **P0 decision:** uploads queued offline are not counted on the circle. They are not scans yet, `SyncIndicator` already shows them, and the camera screen shows its status line.

### 5.4 Search (`/search`) and Browse
- Large title "Search" over a header bloom in Pokémon blue and yellow (§7.12), and a sticky search field ("Cards, sets or numbers (e.g. MEP 022)", new key) with Cancel while focused. Cancel clears the query (URL `replace`) and blurs.
- **Empty state:**
  - **Browse tiles** (§7.12): Sets (blue; "N new" and "N series · N sets") → `/sets`; Pokédex (Pokédex red with its lens lights; "N of 1,025 caught") → `/pokedex`; a wide "Scan a card instead" tile with a Poké Ball → the scanner;
  - **Browse by type:** a 3-column grid of the eleven energy types, each with its symbol. A type opens the results filtered by that type (the existing type filter in the URL).
- **With a query:** today's CardSearch results (2 columns on phones, because each tile carries add controls; Q3). Under the field: type chips for the types in the results, then "Filters (n)", which opens the advanced-filter page sheet. Each result shows its type symbol, set and number, price, and an accent "+" add button. The nav bar's "⋯" holds Select (bulk add) and Create custom card. No results: the existing empty text plus "Scan a card instead" and "Create custom card".
- **Offline:** the tiles keep working from the read cache (the Pokédex count hides if it isn't cached). The field is disabled with the placeholder "Search needs a connection" (new).
- **Sets** (`/sets`, pushed; OD-F). The per-user setting `sets_view` (`series` by default, or `sets`) picks the view. Settings › Appearance has the switch **Show sets in series** (§5.6). The app saves it with `updateSettings`, the way the Sets page already saves `set_overview_filters`: `PUT /settings/` stores any non-admin key per user and `GET /settings/` returns it, so the setting follows the user to every device without a server change.
  - **Series view:** a 2-column grid of **series tiles** (§7.12). Each tile shows the series logo (Q19, through P6a's image route; before P6a or the next sync, the namesake set's logo, else the newest set's), the years (first and last `release_date`), "N sets", and the cards owned out of every card in the series with an HP bar. The totals are sums of `owned_count` and `total` over the series' sets in the cached sets list, so the view works offline. A finished series gets a green Complete badge. The existing filters (language, progress, sort, hidden sets) apply to the sets before they are grouped. A tile opens the series page.
  - **Series page** (`/sets/series/:seriesKey`, pushed, "‹ Sets"): a header with the series logo, its years, "N sets" and "owned / total cards" with an HP bar, over a bloom in the series colour (`colourFor`, §7.12). Below it, a 2-column grid of **set tiles**, newest first. Each tile shows the set logo (the existing set image route), name, set code (`abbreviation`), "owned / total" with an HP bar, a yellow "Releases <date>" strip when `release_date` is in the future, and a green Complete badge when every card is owned. A tile opens Set detail.
  - **Sets view** (switch off): the same set tiles in one 2-column grid, newest first, with the existing filters.
  - `seriesKey` is the set's `series_id` (P6a) when known, otherwise a slug of the series name, so the page works before the next sync fills `series_id`. Grouping uses the same key.
- **Set detail** (`/sets/:setId`, pushed; back returns to where you came from, else `/sets`), following screenshot 1 (Q1d):
  - a banner in the set's colour (`colourFor`) with a logo-style title, the release date and the card count;
  - swipeable stat cards: "Complete set" with a Poké Ball progress ring, "178 of 252", an HP bar and the market value (summed on the client from the checklist prices); then "Master set" (printings owned / available, from `variants_*` and `owned_variants`) with the owned value. The release date comes from the cached sets list;
  - a "Search in set" field (name or number, on the client);
  - a toolbar: Sort menu (number, price, name), Filter menu (All / Owned / Missing, rarity) and a "Split variants" toggle (one tile per available printing, dimmed when not owned);
  - the 3-column grid with foil variant chips, quantity badges and the existing `dimWhenUnowned`. Card art is not restyled.
  - All of this comes from data the checklist and sets endpoints already return.
- **Pokédex** (`/pokedex`, pushed): the existing list with completion in the new list style, caught entries marked with a small Poké Ball; the species page is pushed with "‹ Pokédex".

### 5.5 Profile (`/profile`, new)
- **Trainer card** (§7.12), in place of a large title; the compact title after scrolling is "Profile". An accent gradient card with holo shine and a Poké Ball watermark, showing:
  - the trainer's sprite in a white ring, the trainer name (rounded, heavy), "@handle" (only when the public profile is on) and "ID No." with the user id padded to five digits;
  - three stats, Cards · Sets · Pokédex, from the cached dashboard and the Pokédex summary;
  - in multi-user mode, a row of gym badges for the first eight achievements (coloured when earned) and "N/20 ›" → `/achievements`.
  Amounts respect hidden values; the nav bar has the eye too.
- **Tiles** (3 columns, type colours, §7.12): Analytics (the value change this month), Sealed products (badge: products needing review), Trades, and, in multi-user mode, Leaderboard (your rank, when known), Badges (`/achievements`) and Public page (when the profile is public; opens `/u/:handle`).
- **List** (inset rows with coloured icons): Settings; Sync & offline (queue flag on; value = waiting items); Custom card migration (only while matches are pending; value = count); Install on iPhone (Safari on iOS only; opens a sheet with the install steps); then **Log out**, a centred red row, multi-user only. It calls `logout()`, so the guard runs.
- A footer line with the app version.
- Offline, the card, tiles and rows render from cached data (the Pokédex count and the rank hide when not cached); rows to online-only pages open `OfflineUnavailable`.

### 5.6 Settings (`/settings` → `/settings/:section`)
- `/settings` is a root list of sections with coloured icons, in this order. Hidden sections are left out, never disabled.

| Section (`:section`) | Who sees it | Holds (§10 has the full checklist) |
|---|---|---|
| Account (`account`) | everyone | Avatar, username, the public profile group; change password and sign out other devices (Q13) |
| Appearance (`appearance`) | everyone | Accent theme (a picker of Poké Balls), **Show sets in series** (new, OD-F), language, currency, price type, own card photos |
| Scanner (`scanner`) | everyone | `ScannerSettingsCard`, Gemini fallback, scan diagnostics |
| Notifications (`notifications`) | everyone | Telegram, price alerts, `NotificationsCard` (push) |
| Data & sync (`data`) | admins | Sync and price sync actions, the new "Update prices" row (Q5), languages, fallbacks, digital sets, intervals, migration, debug, image cache, CSV export, backup and restore |
| Users & sign-in (`users`) | admins | The multi-user mode toggle, and the user list when multi-user is on |
| Community (`community`) | everyone | Contributors, supporters, sponsors |
| About (`about`) | everyone | Version, data source, source code, website, contact, credits |

- **P0 decision:** the brief's separate "Multi-user mode" section is folded into "Users & sign-in", so admins find the toggle and the list in one place.
- **Implementation:** the sections stay inside `Settings.jsx`. `useParams().section` picks one; no section renders the root list; an unknown or hidden section redirects to `/settings`. The old tab strip goes. There are no deep links into the old tabs today (checked), so no key mapping is needed beyond `general` → root.
- Controls move into iOS rows (label, description as Footnote, control on the right; long controls below the label). Switches are iOS switches (51×31, green when on). Nothing changes in the handlers.

### 5.7 Other pages
- **Analytics** (pushed): a segmented control Investment | Movers | Rarity | Duplicates, opening on Investment (Q15). Investment takes over Home's former value block: the period control (1W · 1M · 1Y · Max), P&L, realized P&L, and the product-value note as a tap popover. Its existing value-and-cost chart and figures stay.
- **Products:** "+ Log purchase" in the nav bar; the list in the new style.
- **Trades:** a segmented control Live trade | History.
- **Leaderboard, Achievements, Compare, UserCollection, OfflineCenter, CardMigration, ScanQueue:** pushed pages with the nav bar back button and the new list styles. Their own back links and `SOCIAL_TABS`/`AnalyticsSectionNav` strips go as each page migrates.

### 5.8 Sign-in, forced password change, startup screen
Restyle only: black background, a large title, inset grouped fields, a full-width filled button. The markup in §3.5 stays exactly as it is.

### 5.9 Public `/u` pages
Palette only. `PublicHomeButton` stays.

## 6. Shell behaviour

### 6.1 Layout and stacking
```text
<body>
  #root
    Layout                       min-h-dvh; one <main>; no overflow wrapper
      NavBar (sticky, z 30)      bar + StatusLine, safe-area top
      SidebarNav (≥1024 px)
      <main>                     padding-bottom: var(--content-bottom) on phones
        OfflineUnavailable | <Outlet/>
        InstallHint (Home only)
  portals in <body>
    TabBar                       z 40, hidden ≥1024 px
    Sheets, Modal, Alert         z 50
    Menu popovers                z 55
    Scanner overlay              z 58 (its own sheets and alerts render inside it)
    UpdateBanner                 z 60 (existing); updating overlay z 70 (existing)
    Toaster                      react-hot-toast default (9999)
```
Every z-index comes from the variables in §7.1; nothing else picks numbers. The primitives that portal (`PageSheet`, `ActionSheet`, `Alert`, `Menu`) take a `container` prop, `document.body` by default. The scanner passes its overlay element, so its review sheet and confirmations stack above the camera instead of under it.

### 6.2 Tab bar
- `<nav aria-label={t('nav.tabBar')}>` (new key), portaled to `document.body` as its own fixed element, never nested in another fixed element.
- **Geometry:** a glass capsule 64 px tall, 12 px from the sides (max width 440 px, centred), its bottom edge at `max(8px, calc(var(--safe-bottom) - 10px))` from the bottom of the viewport, so it sits on the home-indicator area as in iOS 26. `--safe-bottom` caps the inset at 34 px (§11).
- **Items:** two tabs on each side of the Scan circle. Each tab: a 24 px icon over a Caption 2 label (11/13), at least 44×44. Active tab: a pill behind icon and label (accent at 18 %), icon and label in `--color-tint`, `aria-current="page"`. Inactive: secondary label colour.
- **Scan button:** a 60 px **Poké Ball** whose top half is the theme accent (Q17, §7.12), with a small gloss highlight, raised so it overlaps the capsule's top edge by 16 px, with the label "Scan" on the label row. A yellow count badge at its top right; a yellow pulse ring while jobs process (static under reduced motion); a white ring on `/scans*`. `aria-label` is composed: "Scan" or "Scan, 3 need review".
- **Icons:** Home (`Home`), Collection (`Layers`), Search (`Search`), Profile (the trainer's sprite, or `User`). Only icons that exist in lucide-react 0.323. Tab labels use the rounded display font (§7.6).
- **Content padding:** `--content-bottom = calc(var(--tabbar-height) + var(--safe-bottom) + 16px)` on `main`.
- **Hidden:** outside the shell; at 1024 px and wider; while the scanner overlay is open; while a text field has focus on a touch device (`useKeyboardOpen`, §6.12). Sheets cover it.
- The scan badge comes from the `scan-jobs` query (polling every 3 s only while jobs are active, as today).

### 6.3 Tab memory and re-tap
A small reducer (`src/navigation/tabMemory.js`, unit-tested), kept in memory and in `sessionStorage['pc.tabs.v1']`:
- On every location change in a tab: `last[tab] = pathname + search`; on a root route also `lastRoot[tab] = pathname` (Collection's root is whichever segment was last open).
- **Tap an inactive tab:** navigate to `last[tab]`, or the tab root.
- **Tap the active tab while on a pushed page:** navigate to `lastRoot[tab]`.
- **Tap the active tab at its root:** scroll to the top (smooth; instant under reduced motion).
- Scroll is saved per location when leaving a tab and restored after the tab's page renders (retry for up to 1 s while content loads). Lists that already use `useListScrollRestoration` keep it for their detail round trips.

### 6.4 History mirror and `useBack()`
`navigate(-1)` alone is wrong after a tab switch: Collection › binder, switch to Search, back to Collection (the binder again), then back would land on Search. So the shell keeps a mirror of the in-app history (`src/navigation/historyMirror.js`, unit-tested, `sessionStorage['pc.nav.history.v1']`, at most 50 entries):
- PUSH: drop the entries after the current index, append `{ key, path, section }`.
- REPLACE: overwrite the current entry.
- POP: move to the entry with that `location.key`; if it isn't known (after a reload), reset to the current location.

`useBack()` (`src/navigation/useBack.js`, unit-tested):
- If the previous entry exists and is in the same section, or the route's back is "previous screen" (`/scans`): `navigate(-1)`. List scroll restoration still works because this is a POP.
- Otherwise `navigate(parent, { replace: true })`, where `parent` comes from `navConfig` (with route params filled in), or the section root. This covers deep links and cold starts.
- It never relies on browser chrome or an edge swipe (there is none in standalone mode).

### 6.5 Nav bar, large titles and interim mode
- `Layout` renders one `NavBar`. A page customises it with `useNavBar({ title, subtitle, largeTitle, trailing, backLabel, hideBack })`, which registers through `NavBarContext` and resets on unmount. Pages that never call it get the `navConfig` defaults.
- **iOS 26 look:** the bar has no background of its own. Its buttons are glass circles (44 px) or capsules: the back button is a glass capsule "‹ Parent", truncated to about 12 characters. While content is under the bar, a "scroll edge" layer fades from black at the top (matching the opaque status bar, so there is no seam) to transparent, with a light masked blur. The compact title (Headline, centred) fades in.
- **Tab roots:** the page renders `<LargeTitle>` (34/41 bold, left-aligned) at the top of its content. An `IntersectionObserver` on it, not a scroll handler, toggles the compact title and the scroll-edge layer.
- **Pushed pages:** compact title from the start; "‹ {parent label}" leading; at most two trailing icons plus "⋯".
- **Trailing order:** `SyncIndicator` (when visible), then the page's items.
- **Interim mode (P2 until each page's phase):** no `useNavBar` call means a compact bar with the `navConfig` title, a back button unless the route has "own back" (§4.2), and the page keeps its own `h1`. The duplicate title is temporary, as with today's AppNav strip.
- The bar is a plain `<div>`: not a `<header>` element (§3.7) and not a second `<nav>` landmark. Its buttons carry labels.

### 6.6 Status line (offline and saved data)
- **P0 decision:** `OfflineBanner` and `StaleDataLabel` become one compact line inside the sticky nav bar, under the bar: "Offline · Showing saved data from 5 min ago", "Offline", or "Showing saved data from …".
- The line keeps `role="status"` and both test ids: `offline-banner` on the line while offline, `stale-data-label` on the saved-data text. Their conditions don't change.
- It no longer reserves room for the sync indicator, which now sits in the bar.

### 6.7 Sheets
- **`PageSheet` (new, `components/ios/PageSheet.jsx`):** the iOS page sheet for forms and filters.
  - a grabber (36×5), a sticky header with a leading text button (default "Cancel") and a trailing one ("Done", semibold, tint, can be disabled), and the title (Headline);
  - glass material, top corners 16 px, height up to 92 dvh so a sliver of the page stays visible;
  - an optional sticky footer (safe-area aware) for the primary action;
  - `overscroll-behavior: contain` on its body;
  - **swipe down from the grabber or header** to dismiss. `shouldDismiss({ dy, velocity, height })` is a pure, unit-tested function: dismiss when `dy > min(160, height × 0.25)` or when `velocity > 0.6 px/ms` and `dy > 24`; otherwise spring back;
  - with `isDirty`, Cancel, swipe and backdrop ask first in an action sheet: "Discard changes?" / Keep editing;
  - focus trap and focus restore from `components/ui/dialogBehavior.js`.
- **Legacy `Sheet` and `Modal`** keep their API. P1 gives the mobile `Sheet` the same look (grabber, glass, 92 dvh, 16 px corners) and swipe-down from the grabber and header (it calls `onClose`, like the ✕, which stays). Desktop `Modal` stays a centred dialog in the new palette.

### 6.8 Menus, action sheets, alerts
- **`Menu`:** an anchored popover from its trigger, portaled, glass, radius 14, width 220–280 px, rows 44 px with the label on the left and the icon on the right, hairline separators, an 8 px gap between sections, destructive items in red, a checkmark for the selected option. It scales in from the anchor (150 ms; instant under reduced motion). `role="menu"` with `menuitem`/`menuitemradio`, arrow keys, Enter/Space, Escape, focus back on the trigger.
- **`ActionSheet`:** from the bottom: one glass group (optional title and message in Footnote, rows 56 px, Body 17), then a separate bold Cancel. Used for destructive or multi-way choices (logout guard, discard photos, discard changes).
- **`Alert`:** centred, 270 px, title (Headline), message (Footnote), buttons side by side (stacked when there are three or more); destructive in red; the preferred action bold.
- **`ConfirmDialog`** keeps its props and renders an `Alert` from P1, so every `useConfirmDialog()` call becomes an iOS alert at once.
- The `OverflowMenu` file is dead; P9 deletes it.

### 6.9 Segmented control
iOS 26 style: a capsule track (`--color-fill-tertiary`), equal segments, a sliding capsule thumb (`#636366`, shadow), Footnote semibold labels, 32 px tall (36 px for page-level controls), at most four segments. Keyboard: `role="radiogroup"`, `role="radio"` with `aria-checked`, arrow keys move and select, roving `tabIndex`. Long labels truncate with an ellipsis.

### 6.10 Lists
Inset grouped: 16 px side margins, sections in `--color-card` with radius 12, rows at least 44 px tall (padding 11 × 16), separators inset to the text (16 px, or past the icon), chevrons on rows that drill down, values right-aligned in the secondary colour. Optional section header and footer in Footnote, secondary, sentence case (no tracked uppercase). Pressed rows highlight with `#2C2C2E` for 100 ms.

### 6.11 Toasts
Top-centre below the status bar (`containerStyle.top = calc(env(safe-area-inset-top) + 8px)`), styled as iOS banners: glass, radius 14, Subheadline text, max width 360 px; success icon green, error icon red. Never under the tab bar.

### 6.12 Keyboard, scrolling, touch
- **Input size:** one unlayered rule in `index.css` sets every text input, select and textarea to 16 px on touch devices (`@media (hover: none) and (pointer: coarse)`). Unlayered CSS beats Tailwind's layered utilities such as `text-xs`, so no call site needs to change. Desktop keeps the compact sizes.
- **Search fields:** `type="search"`, `enterKeyHint="search"`, `autoCapitalize="none"`, `autoCorrect="off"`, `spellCheck={false}`.
- **Tab bar and keyboard:** `useKeyboardOpen()` is true while a text-entry element has focus on a touch device (focusin/focusout, with a short delay so moving between fields doesn't flicker); the tab bar hides meanwhile. A fixed bar otherwise floats or jumps above the iOS keyboard.
- **Scrolling:** the document is the scroller, so a status-bar tap scrolls to the top. Never wrap the app in an `overflow: auto` container. Sheets use `overscroll-behavior: contain`.
- **Touch:** `-webkit-tap-highlight-color: transparent` on `html`; `touch-action: manipulation`; visible pressed states (opacity 0.6 or the row highlight) within 100 ms. Tailwind v4's `hover:` variant already applies only on hover-capable devices; the hand-written `:hover` rules in `index.css` (`.card-hover`, `.btn-*`, `.pokemon-card-glow`, `.binder-card` and the like) move behind `@media (hover: hover)`. `-webkit-touch-callout: none` and `user-select: none` on chrome and card tiles only.

### 6.13 Desktop and iPad (≥ 1024 px)
- The same `navConfig` renders `SidebarNav` (`components/ios/SidebarNav.jsx`, 260 px, `--color-bg` with a hairline right edge): a prominent "Scan cards" button at the top, then Home; Collection with Cards, Card Lists, Wishlist; Search with Sets, Pokédex; Profile with its rows.
- Content is centred with a maximum width of 1200 px. The nav bar spans the content column. The tab bar is hidden. `Modal` stays a centred dialog.
- Between 768 and 1023 px (iPad portrait) the phone layout applies, with the tab bar.

## 7. Visual system and tokens

### 7.1 Colour and layout tokens (P1)
Existing variables get new values, so every page restyles without edits. New variables are marked.

| Variable | Value | Notes |
|---|---|---|
| `--color-bg` | `#000000` | systemBackground; also `html`, `body`, the manifest and `theme-color` |
| `--color-surface` | `#1C1C1E` | sheets, grouped cells |
| `--color-card` | `#1C1C1E` | cards, inset list sections |
| `--color-elevated` | `#2C2C2E` | controls on cards, pressed rows |
| `--color-fill` (new) | `rgba(120,120,128,0.36)` | systemFill; also `-secondary` 0.32, `-tertiary` `rgba(118,118,128,0.24)`, `-quaternary` 0.18 |
| `--color-border` | `rgba(255,255,255,0.12)` | hairlines, drawn 0.5 px |
| `--color-border-subtle` | `rgba(255,255,255,0.06)` | |
| `--color-text-primary` | `#FFFFFF` | label |
| `--color-text-secondary` | `rgba(235,235,245,0.6)` | secondaryLabel |
| `--color-text-muted` | `#8E8E93` | systemGray (see below) |
| `--color-text-tertiary` (new) | `rgba(235,235,245,0.3)` | placeholders and disabled text only |
| `--color-brand-red` | theme accent, `#E3000B` by default | fills: Scan circle, filled buttons, selected pill |
| `--color-brand-red-light` | theme's light accent, `#FF4D4D` by default | **tint**: accent-coloured text and icons |
| `--color-accent`, `--color-tint` (new) | aliases of the two above | |
| `--color-on-accent` (new) | `#FFFFFF` by default, `#000000` for the other eight themes | text and icons on accent fills |
| `--color-green` / `--color-red` (new) / `--color-yellow` / `--color-orange` (new) / `--color-blue` | `#30D158` / `#FF453A` / `#FFD60A` / `#FF9F0A` / `#0A84FF` | iOS dark semantic colours; gains, losses and destructive actions use green and red |
| `--glass-bg`, `--glass-filter`, `--glass-border` (new) | `rgba(28,28,30,0.72)`, `blur(24px) saturate(180%)`, `rgba(255,255,255,0.12)` | §7.7 |
| `--safe-top` (new) | `env(safe-area-inset-top, 0px)` | |
| `--safe-bottom` (new) | `min(env(safe-area-inset-bottom, 0px), 34px)` | caps the inflated standalone inset (§11) |
| `--navbar-height` / `--tabbar-height` (new) | `44px` / `64px` | |
| `--content-bottom` (new) | `calc(var(--tabbar-height) + var(--safe-bottom) + 16px)` | |
| `--z-navbar` 30, `--z-tabbar` 40, `--z-sheet` 50, `--z-menu` 55, `--z-scanner` 58 (new) | | the update banner keeps 60 and 70 |
| `--ease-ios` (new) | `cubic-bezier(0.32, 0.72, 0, 1)` | sheets and pushes, 400 ms |

**P0 decision on muted text.** The brief mapped the third label level to 30 % white. Today's `text-text-muted` carries information in 618 places (descriptions, dates, captions); at 30 % it would be about 2.2:1 on black, far below AA. It maps to systemGray instead: 6.4:1 on black and 5.2:1 on `#1C1C1E`. On `#2C2C2E` it is 4.3:1, so small muted text doesn't go on elevated surfaces. The 30 % value is kept for placeholders and disabled text.

### 7.2 Tailwind mapping (P1)
- `text.primary/secondary/muted`, `border.DEFAULT/subtle` and `green/yellow/blue` read the variables instead of hex.
- **Aliases for classes that compile to nothing today** (§3.4): `bg.primary` → `--color-bg` and `bg.secondary` → `--color-surface` (fixes `bg-bg-primary` and `bg-bg-secondary`); top-level `card`, `elevated`, `surface` (fixes `bg-card`, `bg-elevated`); `brand.yellow` → `--color-yellow` (fixes the scanner warnings). The surfaces that were see-through become solid, which is the intended look.
- New colours: `fill`, `fill-tertiary`, `tint`, `accent`, `on-accent`, `red`, `orange`, `label-tertiary`.
- Accent text: an unlayered rule makes `.text-brand-red` use `--color-tint`, so accent-coloured small text passes AA (the fill accent `#E3000B` is 4.3:1 on black).
- `fontFamily.sans` becomes the system stack (§7.6), and the iOS text styles are added as `fontSize` entries.

### 7.3 Accent themes
`hooks/useTheme.js` and the nine themes stay. Each `[data-theme]` block keeps only `--color-brand-red`, `-rgb`, `-light` and `-dark`, and adds `--color-on-accent: #000`. The tinted backgrounds go: every theme is pure black. Contrast was checked for every theme: the light accents pass as text on black and `#1C1C1E` (≥ 5.2:1), and black on each accent fill is ≥ 5.7:1. White on the default red is 4.9:1.

The semantic red (`#FF453A`) stays separate from a red accent. In the default theme the two look alike, so destructive actions always say what they do ("Delete", "Log out") and are confirmed in an alert or action sheet, and links carry a chevron.

### 7.4 Contrast reference

| Pair | Ratio |
|---|---|
| Label on `#000` / `#1C1C1E` | 21 / 17.0 |
| Secondary label on `#000` / `#1C1C1E` | 6.4 / 6.0 |
| Muted (systemGray) on `#000` / `#1C1C1E` / `#2C2C2E` | 6.4 / 5.2 / 4.3 |
| Tint `#FF4D4D` on `#000` / `#1C1C1E` | 6.4 / 5.2 |
| Accent `#E3000B` on `#000` (fills and icons only) | 4.3 |
| White on `#E3000B` | 4.9 |
| Green `#30D158` / red `#FF453A` / blue `#0A84FF` on `#1C1C1E` | 8.4 / 5.0 / 4.7 |

### 7.5 Removed
The `body` radial gradient, the animated `bg-breathe` gradient, the `#root::before` orbs, HomeScreen's `float-orb` orbs, glows and text shadows on numbers and buttons, and the 10–11 px uppercase tracked labels (each page's phase swaps them for Footnote or Caption styles). `#root > * { position: relative; z-index: 1 }` stays: it is harmless without the orbs, and removing it could shift absolutely positioned content in any top-level page. Fixed chrome is portaled instead (§3.6).

### 7.6 Typography
- Font stacks (both are system fonts, so nothing is downloaded):
  - **text:** `-apple-system, BlinkMacSystemFont, system-ui, sans-serif` (SF Pro on Apple devices);
  - **display:** `ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif` (SF Pro Rounded) for large titles, titles, tile numbers, tab labels, chips and buttons (OD-E).
  
  WebKit applies SF's optical sizes and tracking itself, so `letter-spacing` stays normal. The Google Fonts Inter link and its loader in `main.jsx` go (Q6).
- Text styles, as Tailwind utilities (`text-large-title`, `text-title-1`, …):

| Style | Size / line height | Weight in use |
|---|---|---|
| Tile number | 30/34 | heavy (800), display font |
| Large Title | 34/41 | heavy (800), display font |
| Title 1 | 28/34 | heavy, display font, for headers |
| Title 2 | 22/28 | heavy, display font, for headers |
| Title 3 | 20/25 | heavy, display font (section titles) |
| Headline | 17/22 | semibold |
| Body | 17/22 | regular |
| Callout | 16/21 | regular |
| Subheadline | 15/20 | regular |
| Footnote | 13/18 | regular |
| Caption 1 | 12/16 | regular |
| Caption 2 | 11/13 | regular (tab labels medium) |

- Prices and counts use `font-variant-numeric: tabular-nums` (`tabular-nums` utility).
- Dynamic Type (`font: -apple-system-body`) is out of scope for v1.

### 7.7 Materials
- `.glass` (tab bar, nav bar buttons, sheets, menus, action sheets, alerts, toasts): `background: var(--glass-bg)`, `backdrop-filter` and `-webkit-backdrop-filter: var(--glass-filter)`, a 0.5 px `--glass-border`, and a faint inner top highlight (`inset 0 1px 0 rgba(255,255,255,0.08)`) with a soft shadow.
- Under `@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))` it falls back to opaque `#1C1C1E`.
- No blur on cards, rows or tiles.

### 7.8 Shape and spacing
16 px side margins on phones (Layout uses 24 px today) and an 8 pt grid. Radii: lists 12, cards 16, sheets 16 at the top, menus 14, alerts 14; buttons, chips, segmented controls and the tab bar are capsules. Card art keeps the card system's own radii and frame colours (`card-system/tokens.css`); they read well on black.

### 7.9 Icons
lucide-react (0.323, no upgrade) with `strokeWidth` 1.75–2. Tab icons 24 px; row icons 18 px inside 29 px coloured squares (radius 7); nav bar icons 20 px.

### 7.10 Motion
Sheets and pushes: `--ease-ios`, about 400 ms. Tab switches: instant. Pressed states: about 100 ms. Menus: 150 ms. Everything is off under `prefers-reduced-motion`, which also stops the skeleton shimmer and the Scan pulse.

### 7.11 Existing component classes (P1, CSS only)

| Class | New look |
|---|---|
| `.card`, `.card-surface`, `.stat-card`, `.list-item` | `--color-card`, no blur, no border, radius 16 (`.list-item` 12) |
| `.btn-primary(-sm)` | filled capsule, accent fill, `--color-on-accent` text, no glow; pressed = `-dark` |
| `.btn-secondary(-sm)` | gray capsule: `--color-fill-tertiary`, label primary |
| `.btn-ghost(-sm)` | plain capsule: `--color-fill-quaternary`, label secondary |
| `.btn-danger` | plain, red label |
| `.input`, `.input-sm`, `.select`, `.select-sm` | `--color-fill-tertiary`, no border, radius 10, 44 px tall (36 px for `-sm`), focus ring only on `:focus-visible` |
| `.badge-*` | capsules on the iOS semantic colours |
| `.section-title`, `.page-title` | Title 3 and Title 2 |
| `.skeleton` | `--color-fill-quaternary` with a subtle shimmer; static under reduced motion |
| `.card-detail-*`, `.trainer-card`, `.set-hero` | the new palette; glows removed |

### 7.12 The Pokémon layer (OD-E)
Colour and character come from the Pokémon world; the structure stays iOS. Everything here is a token or a shared component in `components/ios/`, so pages don't invent their own versions. The mockups show it in use.

**Energy-type colours.** Eleven TCG types, each with a tile top, a tile bottom and a solid (`--type-<name>-top`, `-bottom`, `--type-<name>`). They are the same in every accent theme, so a Fire card always reads as Fire. Tile text sits anywhere on the tile, so both tile stops must give it 4.5:1; the tops below are darkened until they do (the mockups used lighter tops). P1 adds a unit test that checks every pair.

| Type | Tile top | Tile bottom | Solid (chips, icons, glows) | Tile text |
|---|---|---|---|---|
| Grass | `#328438` | `#145A27` | `#43B04A` | white |
| Fire | `#B4441F` | `#8A1D12` | `#F05A2B` | white |
| Water | `#236BB4` | `#123F8C` | `#2F8FF0` | white |
| Lightning | `#FFE56E` | `#F2A600` | `#F7C815` | `#1D1600` |
| Psychic | `#8A3BA5` | `#551C78` | `#B84FDC` | white |
| Fighting | `#995023` | `#6A2D0E` | `#CC6A2F` | white |
| Darkness | `#343F50` | `#141A24` | `#46546A` | white |
| Metal | `#606972` | `#3E4852` | `#94A2B0` | white |
| Dragon | `#836919` | `#5A4207` | `#C9A227` | white |
| Fairy | `#B35383` | `#86244F` | `#EF6FAE` | white |
| Colorless | `#F5F1E6` | `#BDB39B` | `#E3DCCB` | `#1D1600` |

The brand triad completes the palette: Pokémon red `#E3350D`, yellow `#FFCB05` and blue `#2A75BB`. `colourFor(key)` maps a set or series key to one of the eleven types with a stable hash, for banners and glows that have no colour of their own.

**Energy symbols.** `EnergyIcon` draws one simple SVG per type (leaf, flame, drop, bolt, eye, fist, moon, hexagon, claw, sparkle, star) in white on a circle of the type's colour, or in `#1D1600` on Lightning and Colorless. They are generic shapes, not the official energy artwork.

**Poké Ball.** One `PokeBall` SVG component whose top half takes a colour (the theme accent by default). It is the Scan button (Q17), the camera shutter, the centre of Set detail's progress ring, the theme picker, the "caught" mark in the Pokédex, the Start scanning icon and the sleeping offline illustration. Loading spinners keep `PokeBallLoader`.

**Header blooms.** `HeaderBloom` draws a static radial glow behind a tab root's header, about 380 px tall. It is masked so it starts black under the status bar (no seam) and fades to black below. Home: accent and yellow. Collection: blue and accent. Search: blue and yellow. A series page and Set detail use their `colourFor` colour. It scrolls with the content, is never animated, and never sits behind lists or sheets.

**Tiles.** `StatTile` (Home, Profile) and the Browse tiles have radius 22, the type gradient at 150°, a soft shadow in the type's solid at 55 %, a big rounded number, a label with an icon, and the energy symbol as a large, faint watermark.

**HP bars.** `HpBar` shows every completion: 8 px, rounded; green above 50 %, yellow from 20 % to 50 %, red below 20 %, like a Pokémon's HP.

**Holo and glows.** `.holo` adds a static rainbow sheen (`mix-blend-mode: screen`) to featured cards (Latest pulls, Top cards, the card sheet) and to the trainer card. Card tiles get a soft shadow in the card's type colour where the payload has `types` (Collection, Search, the card sheet). The set checklist and dashboard payloads have no `types`, so those tiles stay neutral. No animated shine is added; the card system's existing variant shimmer is unchanged.

**Trainer card and gym badges.** `TrainerCard` (Profile) and `GymBadges` (eight hexagonal badges, coloured when earned).

**Controls.** The segmented control's selected thumb is the accent with `--color-on-accent` text instead of iOS gray. Filled buttons get a subtle top-to-bottom accent gradient and a soft accent shadow. `TypeChip` is a capsule: the type's solid at 24 % over black, a 55 % inner outline, white text and the energy symbol; "All" is white with black text.

**Series and set tiles.** `SeriesTile` and `SetTile` (§5.4): a logo area over a spotlight in the item's `colourFor` colour, name, years or set code, counts and an HP bar; a yellow "Releases …" strip and a green Complete badge when they apply.

**Wording (Q18).** Some playful copy, in new strings only: "Latest pulls", "N caught" on the camera stack, "species caught" in the Pokédex. Existing strings keep their wording. New keys go into `en.js`; other languages show English until someone translates them.

## 8. PWA placement

| Piece | Today | New | Behaviour |
|---|---|---|---|
| `SyncIndicator` | fixed top right, `bg-card` (see-through) | inline in the nav bar's trailing slot, a glass capsule; still one instance, still hidden when idle | unchanged; test id, `data-state` and the live region stay |
| `SyncSheet` | `Modal` | page sheet look via the legacy `Sheet` | unchanged |
| `OfflineBanner` + `StaleDataLabel` | strip at the top + line above the page | one status line under the nav bar (§6.6) | conditions unchanged; both test ids stay |
| `OfflineUnavailable` | replaces the page | same, in the content area with the tab bar visible; a sleeping Poké Ball above the existing text and links | unchanged; test id and texts stay |
| `UpdateBanner` | portaled top banner | same place, iOS banner style (glass, radius 16, small filled "Update") | unchanged; test ids stay |
| `InstallHint` | `Layout`, under Home | still `Layout` under Home, as an inset card; also a Profile row that opens it as a sheet | unchanged |
| `LogoutGuardDialog` | `Modal` | an `ActionSheet` with the same four choices | unchanged; button names stay |
| `NotificationsCard` | Settings › Notifications | Settings › Notifications, inset style | unchanged; test id stays |
| `EvictedNotice`, `OfflineCenter` | | new palette and list style | unchanged |
| Scanner | modal from CardSearch | overlay from `ScannerContext` outside the `<Outlet>` | `submitScanBatch`, the outbox and the update guard unchanged |

## 9. Component inventory

New shared pieces live in `frontend/src/components/ios/` and `frontend/src/navigation/`. After P1, changes to them go through a small PR of their own.

| Component / hook | Props or return | Notes |
|---|---|---|
| `NavBar` | none; reads `navConfig`, the location and `NavBarContext` | rendered once by `Layout` |
| `useNavBar(options)` | `{ title, subtitle, largeTitle, trailing, backLabel, hideBack }` | registers for the current page, resets on unmount |
| `LargeTitle` | `{ title, subtitle, children }` | rendered by root pages; observed by `NavBar` |
| `BackButton` | `{ label }` | glass capsule; calls `useBack()` |
| `TabBar` | none | portaled; reads `navConfig`, tab memory, `ScannerContext`, scan jobs, the user |
| `ScanButton` | `{ badge, active, processing, onPress }` | the centre circle |
| `SidebarNav` | none | ≥ 1024 px |
| `StatusLine` | none | §6.6 |
| `SegmentedControl` | `{ options: [{ value, label }], value, onChange, ariaLabel, size: 'sm' \| 'md' }` | ≤ 4 options |
| `ListSection` | `{ header, footer, children }` | inset grouped |
| `ListRow` | `{ icon, iconColor, leading, title, subtitle, value, badge, to, href, onClick, chevron, trailing, destructive, disabled, testId }` | renders a `Link`, `a` or `button`; `trailing` replaces the chevron (switches) |
| `Switch` | `{ checked, onChange, label, disabled }` | iOS switch, green when on |
| `SearchField` | `{ value, onChange, onSubmit, placeholder, onCancel, cancelLabel, disabled, autoFocus, ariaLabel }` | §6.12 attributes; Cancel shows while focused when `onCancel` is set |
| `PageSheet` | `{ isOpen, onClose, title, leading, trailing, isDirty, footer, container, children }` | §6.7; `shouldDismiss` exported for tests |
| `Menu` | `{ label, trigger, sections: [[{ id, label, icon, onSelect, checked, destructive, disabled }]], align, container }` | §6.8 |
| `ActionSheet` | `{ isOpen, onClose, title, message, actions: [{ label, onSelect, destructive }], cancelLabel, container }` | |
| `Alert` | `{ isOpen, onClose, title, message, actions: [{ label, onSelect, style: 'default' \| 'cancel' \| 'destructive', preferred }], container }` | `ConfirmDialog` renders this |
| `Button` | `{ variant: 'filled' \| 'tinted' \| 'gray' \| 'plain', size: 'sm' \| 'md' \| 'lg', destructive, icon, loading, full }` | capsules |
| `IconButton` | `{ icon, label, variant: 'glass' \| 'gray' \| 'plain', size }` | 44 px hit area |
| `Badge` | `{ count, max = 99, tone, dot }` | |
| `HideValuesToggle` | none | eye / eye-off, `aria-pressed` |
| `PokeBall` | `{ size, top = 'var(--color-accent)', gloss }` | SVG; Scan button, shutter, rings, theme picker (§7.12) |
| `EnergyIcon` | `{ type, size }` | eleven symbols on type-coloured circles |
| `TypeChip` | `{ type, selected, onPress }` | capsule; `type = 'all'` gives the white "All" chip |
| `StatTile` | `{ type, icon, label, value, detail, to, sparkline }` | Home and Profile tiles; a link |
| `HpBar` | `{ value, max }` | 50 % and 20 % thresholds |
| `HeaderBloom` | `{ variant: 'home' \| 'collection' \| 'search', colour }` | static, masked at the top |
| `TrainerCard`, `GymBadges` | `{ user, stats, badges }`, `{ earned, total }` | Profile |
| `SeriesTile`, `SetTile` | `{ series \| set, owned, total, upcoming, complete, to }` | Sets and the series page |
| `colourFor(key)` | `(string) => type` | stable hash into the type palette |
| `groupSetsBySeries(sets)` | pure function | key, name, years, set count, owned and total, logo set id; unit-tested |
| `useSetsView()` | `{ view: 'series' \| 'sets', setView }` | reads and writes the `sets_view` setting |
| `navConfig.js` | `TABS`, `ROUTES`, `REDIRECTS`, `OUTSIDE_SHELL`, `PROFILE_GROUPS`, `SETTINGS_SECTIONS`, `matchRoute(path)`, `sectionForPath(path)`, `parentForPath(path)`, `titleKeyForPath(path)` | single source (§2) |
| `tabMemory.js` | reducer + `useTabMemory()` | §6.3 |
| `historyMirror.js` | reducer + `useHistoryMirror()` | §6.4 |
| `useBack()` | `() => void` | §6.4 |
| `ScannerContext` | `useScanner()` → `{ isOpen, openScanner, closeScanner }` | §5.3 |
| `useHideValues()` | `{ hidden, setHidden, toggle }` | `localStorage['pc.hideValues']`; `formatPrice` and `formatUsdPrice` show "••••" while hidden (Q16) |
| `useKeyboardOpen()` | `boolean` | §6.12 |
| `/__ios` gallery | dev only, like `/__card-system` | every primitive in every state |

## 10. Settings coverage checklist

Every control on today's Settings page, its visibility rule (unchanged), and where it goes. P7's acceptance includes ticking every row.

| # | Today: tab › section › control | Visible to | New section |
|---|---|---|---|
| G1 | General › Trainer › Avatar (AvatarPicker) | everyone | Account |
| G2 | General › Trainer › Username | everyone | Account |
| G3 | General › Public profile › Public profiles on the server (global switch) | admins | Account |
| G4 | General › Public profile › Public trainer name, URL, handle error | feature on | Account |
| G5 | General › Public profile › Public profile switch | feature on | Account |
| G6 | General › Public profile › Wishlist visibility | feature on | Account |
| G7 | General › Public profile › Show values publicly | feature on | Account |
| G8 | General › Public profile › Profile link with Copy | feature on, public, handle set | Account |
| G9 | General › Public profile › Save | feature on | Account |
| G10 | General › Theme › Theme grid | everyone | Appearance (shown as Poké Balls) |
| G11 | General › Multi-user › Multi-user mode switch and its warning modal | admins | Users & sign-in |
| G12 | General › Appearance › Language | everyone | Appearance |
| G13 | General › Appearance › Currency (dynamic list) | everyone | Appearance |
| G14 | General › Appearance › Price type | everyone | Appearance |
| G15 | General › Appearance › Prefer own card photos | everyone | Appearance |
| G16 | General › Appearance › Delete all own card photos | everyone | Appearance |
| A1 | (new) Show sets in series (`sets_view`, OD-F) | everyone | Appearance |
| G17 | General › AI scanner › `ScannerSettingsCard` (provider setup, admin parts inside) | everyone | Scanner |
| G18 | General › AI scanner › Gemini fallback | everyone | Scanner |
| G19 | General › AI scanner › Scan diagnostics switch and Delete | everyone | Scanner |
| G20–G24 | General › About › Version, Data source, Source code, Creator website, Contact | everyone | About |
| G25 | General › About › "Made with … Gilles Romer" | everyone | About |
| D1 | Data & Sync › Sync › Sync sets and cards (button, last sync, error) | admins | Data & sync |
| D2 | Data & Sync › Sync › TCGdex sync languages | admins | Data & sync |
| D3 | Data & Sync › Sync › Digital sets | admins | Data & sync |
| D4 | Data & Sync › Sync › Cross-language price fallback | admins | Data & sync |
| D5 | Data & Sync › Sync › Cross-language image fallback | admins | Data & sync |
| D6 | Data & Sync › Sync › Card migration (pending matches) | admins, matches > 0 | Data & sync (also a Profile row and a Home row) |
| D7 | Data & Sync › Sync › Full sync interval | admins | Data & sync |
| D8 | Data & Sync › Sync › Sync prices only (`/sync/prices/all`) | admins | Data & sync |
| D9 | Data & Sync › Sync › Price sync interval | admins | Data & sync |
| D10 | Data & Sync › Data › Debug mode and debug log download | admins | Data & sync |
| D11 | Data & Sync › Data › Clear image cache (confirmed) | admins | Data & sync |
| D12 | Data & Sync › Data › CSV export | admins | Data & sync |
| D13 | Data & Sync › Data › Backup download with the option chips | admins | Data & sync |
| D14 | Data & Sync › Data › Restore with `PasswordPromptDialog` | admins | Data & sync |
| H1 | Home › admin "Sync" (`/sync/prices`) | admins | Data & sync, new row "Update prices" (Q5) |
| N1 | Notifications › Telegram status | everyone | Notifications |
| N2 | Notifications › Telegram bot token and Save | everyone | Notifications |
| N3 | Notifications › Telegram chat ID and Save | everyone | Notifications |
| N4 | Notifications › Price alerts | everyone | Notifications |
| N5 | Notifications › Alert threshold (%) | when N4 is on | Notifications |
| N6 | Notifications › `NotificationsCard` (push) | everyone, flag on | Notifications |
| C1 | Community › Contributors | everyone | Community |
| C2 | Community › Supporters (fetched on entry) | everyone | Community |
| C3 | Community › Sponsors (Betterplace) | everyone | Community |
| U1 | Users › User list: activate, edit, delete; Add user | admins, multi-user | Users & sign-in |
| U2 | Users › Add or edit user form | admins, multi-user | Users & sign-in (page sheet) |
| U3 | Users › Change password | admins, multi-user (today) | Account for every multi-user user if Q13 is yes; otherwise Users & sign-in |
| U4 | Users › Sign out other devices | admins, multi-user (today) | as U3 |

## 11. iOS home-screen constraints (verify on the owner's iPhone)

- **Status bar.** Keep `black` (opaque). `black-translucent` has misbehaved since iOS 26.1 (a gradient scrim, blurred headers, a viewport short by the status bar height). iOS reads the style only when the app is added to the Home Screen, so a change needs remove-and-add. Safari 26 ignores `theme-color` for home-screen apps; the page background supplies the colour, and pure black blends with the bar. The nav bar's scroll-edge layer starts black for the same reason.
- **Viewport and bottom edge.** iOS 26 can size a standalone app's viewport short of the screen (WebKit 301108, mostly with `black-translucent`). Several projects report `env(safe-area-inset-bottom)` reading about 93 px instead of 34 in standalone mode, which `--safe-bottom` caps from the start. Round 1 measures it: the tab bar should sit just above the home indicator with no gap and no overlap, on short and long pages. If a gap appears, try the `@media (display-mode: standalone)` `html` min-height fix from frappe-ui #1284.
- **No edge-swipe back** in standalone mode. No custom swipe-back in v1.
- **Camera.** `getUserMedia` works in standalone mode, but the permission prompt may come back on every launch (PWA doc M-04); round 2 records how often. A file input opened by script outside a tap may be ignored, so the fallback offers real buttons (§5.3).
- **Scroll lock.** Modals lock scroll with `body { overflow: hidden }`. Round 1 checks that the page behind a sheet doesn't scroll or rubber-band on iOS 26.
- **No haptics API and no Background Sync.** Push needs the installed app (already handled).
- **View transitions.** Same-document view transitions work in Safari 18+, but React Router's `viewTransition` option needs a data router and React's `<ViewTransition>` needs React 19.3; the app uses `<BrowserRouter>` and React 18. If transitions are approved (Q1c), P8 uses a small helper around `document.startViewTransition` + `flushSync`, feature-detected and off under reduced motion. Back through `popstate` won't animate.
- **Input zoom.** Inputs under 16 px make Safari zoom on focus (fixed in P1).
- **Status-bar tap** scrolls only the document.

## 12. Test plan

**Every phase** (from `frontend/`):
```bash
npm test && npm run build
CI=1 npm run test:pwa        # port 4175 is shared by parallel workers: wait and retry when busy
npm run test:visual
npm run test:visual:webkit   # whenever the shell or the primitives change
```
The backend stays untouched; run its tests only if a phase touches it.

**New unit tests** (vitest, next to the code):
- `navConfig`: every `path` in `App.jsx` (read from the source file) matches a `ROUTES`, `REDIRECTS` or `OUTSIDE_SHELL` entry; every pushed route has a parent that is itself a route; the section and parent of each row in §4.2.
- `tabMemory` reducer: remember, restore, re-tap at depth, re-tap at root, Collection's segment root.
- `historyMirror` reducer: PUSH, REPLACE, POP to a known and an unknown key, the 50-entry cap.
- `useBack`: same section → `navigate(-1)`; other section → parent with `replace`; cold start → parent; `/scans` → previous screen or `/`.
- `SegmentedControl` keyboard handling; `shouldDismiss` thresholds; the scanner's camera-or-fallback choice (supported, unsupported, denied, remembered denial); `useHideValues` masking.
- The Pokémon layer: every type tile pair in §7.12 reaches 4.5:1 for its text colour; `colourFor` is stable; `HpBar` picks the right colour at 20 % and 50 %.
- `groupSetsBySeries`: grouping by `series_id` or, without it, by series name; years; set counts; owned and total sums; the complete flag; newest series first; the logo set (the namesake set, else the newest).
- `useSetsView`: `series` by default; saves through `updateSettings`.

**Backend tests (P6a):** `parse_set_for_db` stores `series_id` and `series_logo`; `GET /sets/` returns `series_id`; `GET /api/images/set/{id}/series` serves and caches the series logo, falls back to the namesake set's logo, then to the newest set's logo, then to the bundled wordmark; the migration runs twice without error. Run the whole backend suite (`cd backend && python -m unittest discover -s tests -p 'test_*.py'`).

**New Playwright tests** in `tests/visual/shell.spec.js`. They run in the mobile project (skipped in desktop) and in a new `webkit-iphone` project added to `playwright.webkit.config.js` (`devices['iPhone 13']`, WebKit, 390×844):
- on every route of §4.2 the tab bar is visible and the right tab has `aria-current="page"` (none on `/scans*`, where the Scan button is active);
- re-tapping a tab goes back to its root; re-tapping at the root scrolls to the top;
- every pushed page opened by deep link has a back button that lands on its parent;
- Scan opens from every tab and closes back to the same page;
- logging out from Profile shows the guard (the four-way case stays in the PWA suite);
- the desktop project sees the sidebar and no tab bar;
- Sets shows series by default, a series opens its sets, and with `sets_view` set to `sets` the page shows the plain set grid.

Plus, in the PWA suite (`tests/pwa/shell-offline.spec.js`): offline, the tab bar stays, the status line shows, `/profile` renders cached numbers and `/analytics` shows `OfflineUnavailable`.

**Existing specs, same intent** (never deleted):

| Spec | Change | Phase |
|---|---|---|
| `offline-auth.spec.js` | Logout from `/profile` instead of Home and `/collection`; "Hello," on Home stays | P2 |
| `read-cache.spec.js` | Logout from `/profile`; `/trades` still shows `offline-unavailable` | P2 |
| `push.spec.js` | open `/settings/notifications` instead of clicking the tab | P2 (routing) |
| `offline-scan.spec.js` | open the scanner from the tab bar's Scan button; without a camera the review sheet shows "0/50 Photos" | P4 (P2 keeps CardSearch's "Scan card" button working) |
| `sync-center.spec.js`, `service-worker.spec.js` | none expected; the indicator keeps its test id | P2 checks |
| `offline-banner-probe.spec.js` | none expected; the status line keeps `offline-banner` | P2 checks |
| `card-pages.spec.js` (`analytics-duplicates`) | click the Duplicates segment first if Analytics opens on Investment (Q15) | P7 |
| snapshots | regenerated when a phase changes the look (P1 changes all eight) | each phase |

**Snapshots** are Linux-named. Regenerate them on Linux, never on Windows, with the Playwright image matching the installed version. From `frontend/` in Git Bash on the owner's PC:
```bash
MSYS_NO_PATHCONV=1 docker run --rm --ipc=host -v "$(pwd -W):/work" -v /work/node_modules -w /work mcr.microsoft.com/playwright:v1.62.1-noble bash -lc "npm ci && npx playwright test --update-snapshots"
```
(`MSYS_NO_PATHCONV=1` and `pwd -W` stop Git Bash from rewriting the paths; on Linux or macOS use `$PWD` instead. The anonymous `/work/node_modules` volume keeps the Linux install away from the Windows one.) Commit only the changed PNGs under `tests/visual/*-snapshots/`, and look at each one before committing.

**Real iPhone:** the checklist in §13 at each milestone. Record the iOS version and test both the installed Home Screen app and a Safari tab.

## 13. iPhone checklists

The owner gets the short checklist for the round, not this document.

**Round 1 (milestone A, after P2)**
1. Delete the Home Screen app and add it again (theme colour and status bar are read at install).
2. Status bar: solid black, no seam under it; scrolled content never shows through it.
3. Tab bar: floating just above the home indicator, no gap below, no overlap, on Profile (short) and Collection (long); the last item of a long list scrolls clear of the bar.
4. Each tab: highlight; tap to switch; re-tap deep in a stack returns to the root; re-tap at the root scrolls to the top.
5. Back buttons: Sets › a set › back; Leaderboard › a trainer's collection › back; Profile › Settings › a section › back; Collection › a card list › back.
6. The Scan circle opens the scanner from every tab; closing returns to the same screen.
7. Profile: every row; Log out with nothing waiting; Log out with an item waiting → the four choices.
8. Airplane mode: the status line appears under the nav bar, the sync indicator shows in the bar, the tab bar stays, Profile shows numbers, Analytics says it isn't available offline.
9. Update banner: after the next deploy, the banner shows at the top; Update → the updating screen → the new version.
10. Safari tab: the install hint on Home; dismiss it.
11. Search: typing hides the tab bar; no zoom on focus; Return searches.
12. Rotate to landscape and back.
13. Pull down at the top of a page: black, never white.
14. A sheet open over a long page: the page behind doesn't scroll.

**Round 2 (milestone B, after P3 and P4)**
1. Home: the tiles (Cards, Sets, Pokédex, and Value with its mode switch), the eye hides every amount, to-do cards open the right pages, quick actions, Latest pulls, Your sets with HP bars, Top cards, "Prices updated".
2. Scan: how often the camera permission prompt appears (first launch, every launch, never); photo sharpness of a card; shutter count and the 50 limit; Photos from the library.
3. Review: remove a photo, scan individually, Clear, Start scanning online → the scan page.
4. Offline: Start scanning → "Saved on this device", the camera screen shows waiting batches, the upload happens after reconnecting.
5. With photos staged, an update can't reload the app (the banner says it's blocked).
6. Deny the camera (Settings › PokéCollector or Safari › Camera): the sheet with Take photo and Choose from library works.

**Round 3 (milestone C, after P5–P7)**
1. Collection: segments, search, Sort menu, Filters sheet, 3-column grid, list view, a card (sheet, swipe down), CSV and PDF export, add a custom card.
2. Card Lists → a binder → back; a deck → back; compare.
3. Search: the Browse tiles and Browse by type; Sets by series → a series → a set (stat cards, search in set, split variants) → back twice; the series logos after a sync; turn off Show sets in series and check the plain grid; Pokédex → species → back.
4. Settings: each section; restore asks for the password; push can be enabled in Notifications; change password (Q13).
5. Analytics segments; Trades; Products; Leaderboard; Achievements.
6. Sign in (Passwords in a Safari tab; in the home-screen app through the edit menu); forced password change; the startup screen offline.

**Final (after P8 and P9):** VoiceOver across the tabs and the scanner; Reduce Motion; pull to refresh; slide transitions (keep or drop); scrolling a large collection stays smooth.

## 14. Phases

Every phase: a fresh worktree and a branch `feature/ios-ui-pNN-<slug>` cut from `origin/feature/ios-ui` after its prerequisites have merged; the PR targets `feature/ios-ui`; no version bump; tests per §12; docs updated for what the phase changes. "Owns" lists the files the phase may change; anything else needs the coordinator.

**P0 — Design and mockups** (`feature/ios-ui-p00-design`, the coordinator). This file and the mockups. Gate: the owner approves; the PR merges.

**P1 — Foundations** (`feature/ios-ui-p01-foundations`; no navigation change)
- Owns: `src/index.css`, `tailwind.config.js`, `index.html`, `src/main.jsx`, `public/manifest.json`, `scripts/pwa-assets.test.mjs`, `src/components/ios/*` (new), `src/components/ui/{Sheet,Modal,ConfirmDialog}.jsx`, `src/contexts/SettingsContext.jsx` (hide values only), one dev route line in `src/App.jsx`, `src/i18n/en.js` (new `ios` block), `docs/FRONTEND.md` (theme colour), snapshots.
- Tasks: the tokens and mappings of §7.1–§7.3 and the Pokémon layer tokens of §7.12 (type colours with the contrast test, brand triad, `colourFor`); the base cleanup of §7.5 and §6.12 (input size, tap highlight, `touch-action`, hover guards); the text and display font stacks and the removal of the Inter link and loader (Q6); `#000` for the manifest, `theme-color` and the fallback layer, with the asset test updated; the restyle of §7.11; the toaster style (§6.11); the primitives of §9 that P2 doesn't own (`SegmentedControl`, `ListSection`, `ListRow`, `Switch`, `SearchField`, `PageSheet`, `Menu`, `ActionSheet`, `Alert`, `Button`, `IconButton`, `Badge`, `HideValuesToggle`, `.glass`, and the Pokémon components `PokeBall`, `EnergyIcon`, `TypeChip`, `StatTile`, `HpBar`, `HeaderBloom`, `TrainerCard`, `GymBadges`, `SeriesTile`, `SetTile`, `.holo`); `ConfirmDialog` → `Alert`; the legacy `Sheet` look and swipe; `useHideValues` with the masking in `formatPrice` (Q16; check that no caller feeds the result into an input); the `/__ios` gallery; unit tests; regenerated snapshots.
- Accept: all tests green, including the type-colour contrast test; every page renders in the new palette with no layout breaks at 390 and 1280 px; the see-through surfaces of §3.4 are solid; `/__ios` shows every primitive and Pokémon component; no input zooms on an iPhone.

**P2 — Shell and navigation** (`feature/ios-ui-p02-shell`; **milestone A**, round 1)
- Owns: `src/navigation/*` (new), `src/components/ios/{NavBar,LargeTitle,BackButton,TabBar,ScanButton,SidebarNav,StatusLine}.jsx`, `src/components/Layout.jsx`, `src/App.jsx`, `src/contexts/ScannerContext.jsx` (new), `src/pages/Profile.jsx` (new), `src/pages/Settings.jsx` (routing and the root list only), `src/pages/CardSearch.jsx` (one call: the camera button uses `openScanner()`), `src/components/sync/{SyncIndicator,OfflineBanner,StaleDataLabel}.jsx`, `src/offline/routes.js` (+ test), `src/i18n/en.js` (`nav` keys, new `profile` block, `settings.sections`), the PWA and visual specs of §12, `playwright.webkit.config.js`, `docs/FRONTEND.md`, `docs/PWA.md`.
- Tasks: `navConfig` with its test; tab memory; history mirror and `useBack`; the `TabBar` with the Poké Ball Scan button (Q17); `ScannerContext` with the existing `UnifiedCardScanner` (camera-first comes in P4); the `NavBar` with interim mode and "own back"; `StatusLine`; `SyncIndicator` into the bar; `/profile` per §5.5 (trainer card, tiles, list, Log out, the eye); `/settings/:section` routing with the root list; the `/dashboard` redirect and the catch-all; `AppNav` and the Pokéball button removed from `Layout` (the files stay until P9; `PublicHomeButton` stays on `/u`); `SidebarNav`; `/profile` in `OFFLINE_ROUTES`; the `/sets/series/:seriesKey` route in `App.jsx`, `navConfig` and `OFFLINE_ROUTES`, rendering `Sets` (P6 reads the parameter); the spec updates and new specs; the route table and navigation docs.
- Accept: every route in §4.2 shows the right tab, title and back target; all tests green in Chromium and WebKit; no page lost an action (old in-page back links remain until their phase); offline behaviour unchanged.
- Gate: deploy candidate with the owner's OK, then iPhone round 1.

After P2 merges, **P3–P7 can run in parallel**: they own different page files. P6a touches only the backend and can run at any time after P0. Shared files (`index.css`, `tailwind.config.js`, `App.jsx`, `Layout.jsx`, `navConfig`, `components/ios/*`) change only through the coordinator; `en.js` changes only inside each phase's own namespaces.

**P3 — Home** (`feature/ios-ui-p03-home`)
- Owns: `src/pages/HomeScreen.jsx`, `src/components/pwa/InstallHint.jsx`, `en.js` (`home`).
- Tasks: §5.1 with the existing queries plus `getCustomMatches`, `useOutbox`, the cached sets list and the Pokédex summary; the Value tile with its mode button; the local avatar sprite. The product-value note moves to Analytics in P7.
- Accept: "Hello," present; every to-do card appears only with a non-zero count; the Portfolio value | Capital invested switch still works; offline Home renders from the read cache; nothing hover-only.

**P4 — Scan** (`feature/ios-ui-p04-scan`; with P3, **milestone B**, round 2)
- Owns: `src/components/UnifiedCardScanner.jsx`, `src/components/BatchCameraCapture.jsx`, `src/contexts/ScannerContext.jsx`, `src/pages/ScanQueue.jsx`, `src/components/ScanReview.jsx` (restyle only), `en.js` (`scanner`), `tests/pwa/offline-scan.spec.js`, `tests/visual/scan-review.spec.js`.
- Tasks: §5.3, the fallback and the remembered denial; the Poké Ball shutter, the yellow guide corners and the "N caught" badge (Q17, Q18); the inbox badge on the camera screen; ScanQueue and ScanReview restyle.
- Accept: the PWA scan specs pass in Chromium and WebKit; the update guard holds while staged; recognition, outbox and queue logic unchanged.

**P5 — Collection** (`feature/ios-ui-p05-collection`)
- Owns: `src/pages/{Collection,Binders,BinderDetail,DeckEditor,DeckCompare,Wishlist}.jsx`, `src/components/CardItem.jsx`, the frame part of `src/components/UnifiedCard.jsx` (Q14), `en.js` (`collection`, `binders`, `wishlist`, `decks`), `collection-list` and `card-system-dialog` snapshots, and the variant-chip tokens in `src/components/card-system/tokens.css` (a shared change, reviewed with the checklist in `docs/CARD_SYSTEM.md`).
- Tasks: §5.2, including the type chips, the type glows and the foil variant chips; `sort` and `order` URL parameters; remove the three `COLLECTION_TABS` strips and the in-page back links.
- Accept: every existing action is reachable from the menus; the four DeckEditor `header` tests pass.

**P6 — Search** (`feature/ios-ui-p06-search`)
- Owns: `src/pages/{CardSearch,Sets,SetDetail,Pokedex,PokedexSpecies}.jsx`, `src/utils/setSeries.js` (new: `groupSetsBySeries`), `src/hooks/useSetsView.js` (new), `en.js` (`cardSearch`, `sets`, `setDetail`, `pokedex`), `tests/visual/advanced-search.spec.js`.
- Tasks: §5.4: the Browse tiles and Browse by type; the series view, the series page (inside `Sets.jsx`, keyed by `useParams().seriesKey`) and the sets view, following `sets_view`; series logos through P6a's `series` image type when the sets carry `series_id`, otherwise the namesake set's logo, else the newest set's; the Set detail upgrade (Q1d); Pokédex caught marks; the offline search state; remove CardSearch's own scanner buttons (the tab bar and "Scan a card instead" replace them).
- Accept: URL state of search and sets unchanged; Browse, the series view and the series page work offline; each series total equals the sum of its sets.

**P6a — Series logos, backend** (`feature/ios-ui-p06a-series-logos`; Q19, the one approved backend change; it can run at any time after P0)
- Owns: `backend/models.py`, `backend/database.py` (migration list), `backend/services/pokemon_api.py`, `backend/schemas.py`, `backend/api/images.py`, new `backend/tests/test_series_logos.py`, `docs/BACKEND.md`.
- Tasks:
  - `Set` gains two nullable columns, `series_id` and `series_logo`, added through the existing migration list (`ALTER TABLE sets ADD COLUMN IF NOT EXISTS …`, as `abbreviation` was).
  - The sync already fetches `/series/{id}` for every series (`services/pokemon_api.py`). Keep that series' `id` and `logo` with each of its sets (`_series_id`, `_series_logo`), and let `parse_set_for_db` store `series_id` and `series_logo` (`<logo>.webp`, the same convention as set logos).
  - `SetBase` returns `series_id`. The logo URL stays on the server.
  - `GET /api/images/set/{set_id}/series` serves the set's series logo through the existing image cache (`_get_or_fetch`, one cache key per language and series). Without a series logo it serves the namesake set's logo (the set whose name equals the series name), then the newest set's logo, then the bundled wordmark. The same visibility check as for set images applies.
  - Existing installs fill the new columns on the next full sync; until then the frontend uses its fallback (P6).
- Accept: the whole backend suite passes, including the new tests; the migration runs twice without error; no other API change; the sets payload grows only by `series_id`.

**P7 — Profile, Settings and the rest** (`feature/ios-ui-p07-profile`; P5–P7 together are **milestone C**, round 3). May ship as two PRs with disjoint files: 7a (Profile polish, Settings sections, auth screens) and 7b (portfolio and social pages).
- Owns: `src/pages/{Profile,Settings,Analytics,Products,Trades,Leaderboard,Achievements,Compare,UserCollection,OfflineCenter,CardMigration,Login}.jsx`, `src/components/{ScannerSettingsCard,AuthStartupScreen}.jsx`, `src/components/pwa/NotificationsCard.jsx`, `src/components/sync/{LogoutGuardDialog,SyncSheet}.jsx`, `ForcePasswordChangeScreen` in `src/App.jsx` (the only `App.jsx` change in this window), `en.js` (`settings`, `profile`, `analytics`, `products`, `trades`, `leaderboard`, `achievements`).
- Tasks: §5.5–§5.8; the coverage checklist of §10, row by row, including the new A1 switch (through `useSetsView` once P6 has merged, otherwise `updateSettings({ sets_view })` directly) and the Poké Ball theme picker; the logout guard as an action sheet; Analytics' order and default (Q15) and its new value block; remove `AnalyticsSectionNav` and `SOCIAL_TABS` strips.
- Accept: every row of §10 ticked; the AutoFill markup byte-identical; all tests green.

**P8 — Polish** (`feature/ios-ui-p08-polish`): the approved extras (pull to refresh, transitions), large-title tuning, a VoiceOver pass, a performance pass on the blur layers, a reduced-motion audit. Final iPhone checks.

**P9 — Cleanup and docs** (`feature/ios-ui-p09-cleanup`): delete `AppNav`, `BottomNav`, the old `Sidebar`, `OverflowMenu`, `AnalyticsSectionNav`, `Dashboard` and unused CSS (`.bottom-nav*`, `.pb-nav`, `--bottom-nav-height`, `float-orb`, `bg-breathe`); `TabNav` stays for `PublicProfileShell`. Update the docs (§18). Final deploy with the owner's OK.

## 15. Process

- **Integration branch:** `feature/ios-ui`. Each phase PR is reviewed and re-tested by the coordinator together with anything landing at the same time, then squash-merged. Check the squash message for attribution lines.
- **Never** target `main`, `upstream` or `deploy` from a phase.
- **Staying current:** when `deploy` moves (an upstream sync through `main`, PWA fixes through `feature/pwa`), merge `origin/deploy` into `feature/ios-ui` before the next phase starts. Merge, don't rebase.
- **Deploy merges** at milestones A, B, C and the end: merge `feature/ios-ui` into `deploy` in a local worktree, run the full test set, push only after the owner says OK; the owner redeploys in Portainer and runs the round's checklist. Because `feature/ios-ui` comes from `deploy`, these merges should be conflict-free.
- **Hot files** (one writer at a time, or through the coordinator): `src/index.css`, `tailwind.config.js`, `src/App.jsx`, `src/components/Layout.jsx`, `src/navigation/*`, `src/components/ios/*`, and `src/i18n/en.js` outside the phase's own namespaces.
- **Workers:** Sonnet 5.5 at medium effort; every brief is self-contained (base branch, owned files, tasks, acceptance criteria, tests) and points at the sections of this document. If the app refuses `start_session` on a turn started by an automated event, propose a card instead.
- **Later PWA work:** if P9 of the PWA plan (offline adds) is revived, its UI follows this design system.

## 16. Risks

| Risk | Mitigation |
|---|---|
| iOS 26 viewport and safe-area bugs put the tab bar in the wrong place | `--safe-bottom` cap from P1; measured in round 1; the frappe-ui fix is ready |
| Blur layers stutter on older iPhones | blur only bars, sheets and menus; opaque fallback; P8 performance pass; the blur radius is one variable |
| Upstream changes conflict with restyled pages | chrome-only diffs; `deploy` merged into `feature/ios-ui` before each phase |
| Workers drift from the spec | self-contained briefs, "owns" lists, acceptance criteria, coordinator review and re-test |
| Test churn (PWA specs, snapshots) | same-intent updates listed in §12; Linux snapshots through Docker; each PNG looked at |
| The keyboard and a fixed tab bar fight | the bar hides while typing |
| The camera permission prompt on every launch | the fallback always works; round 2 measures it |
| Hiding values breaks a calculation | masking only in display formatters; P1 checks every caller |
| Custom controls lose accessibility | roles and keyboard support in the primitives, unit tests, a VoiceOver pass |
| The desktop layout regresses | the desktop visual project; the sidebar keeps every destination |
| A Settings control disappears | the §10 checklist is part of P7's acceptance |
| Light accent themes make white text unreadable | `--color-on-accent` per theme |
| `useBack` misreads history after a reload or in a Safari tab | the history mirror resets on unknown keys and falls back to the parent; unit and deep-link tests |
| The Pokémon layer makes screens busy or slow | colour lives in tiles, chips, card glows and static header blooms; lists, sheets and Settings stay calm; no animated shine; P8 performance pass |
| Text on coloured tiles is hard to read | the tile colours are AA-checked by a unit test (§7.12) |
| The series-logo change conflicts with upstream syncs | two nullable columns, one image type and a small change in `pokemon_api.py`, in its own tested PR (P6a) |
| New playful strings stay English in other languages | only new keys use them; the English fallback is the documented behaviour (Q18) |

## 17. Decisions for the owner

The owner answered in the mockup page on 2026-10-19 and approved version 2. Q1–Q16 came with the first mockups, Q17–Q19 with version 2.

**Mockups:** [PokéCollector iPhone Mockups](https://claude.ai/artifact/FVYGUzcRSuEeLZshZgWJAS) (a private Artifact, open only to the owner): every screen of §5 at 390×844, the tab bar states, the menus, and these questions with a Save button. Sample data only; the card pictures are stand-ins.

| # | Question | Recommendation | Alternative | Answer |
|---|---|---|---|---|
| Q1 | Extras: (a) hide-values eye on Home and Profile; (b) pull to refresh on tab roots; (c) slide transitions for push and pop; (d) Set detail upgrade: stat cards, search in set, split variants; (e) recent searches | (a) yes, (b) yes in P8, (c) yes in P8 if smooth on the device, (d) yes in P6, (e) not in v1 | any subset | **(a)–(d) yes, (e) not in v1**, as recommended |
| Q2 | Scan circle style | accent circle with a viewfinder icon (follows the accent theme; the badge stays legible) | Poké Ball circle (red and white in every theme) | **Accent circle**, superseded by Q17 (a Poké Ball whose top half is the theme colour) |
| Q3 | Grid density | 3 columns on phones in Collection and Set detail, list view for details; Search results keep 2 because their tiles carry add buttons | 3 everywhere | **As recommended** |
| Q4 | Home quick actions | Wishlist, Card Lists, Sets, Analytics | another four | **As recommended** |
| Q5 | Admin price sync | its own row "Update prices" in Settings › Data & sync (it is a different action from "Sync prices only"); Home shows "Prices updated …" | keep a small sync button on Home for admins | **As recommended** |
| Q6 | Font | the system font everywhere; drop the Google Fonts Inter link | keep Inter for headings | **As recommended** |
| Q7 | Search offline | Browse rows work; the search field is disabled | hide Search's field offline | **As recommended** |
| Q8 | Not in v1 | long-press context menus on cards, swipe actions on rows, the tab bar shrinking on scroll | pick any for P8 | **As recommended** |
| Q9 | Public `/u` pages | palette only | full redesign later | **As recommended** |
| Q10 | iPad and desktop | a sidebar from 1024 px | tab bar everywhere | **As recommended** |
| Q11 | Light mode | out of scope (the opaque black status bar can't change at runtime) | — | **As recommended** |
| Q12 | Name of the middle segment | keep "Card Lists", the app's current English name for binders and decks (already translated in every language) | rename to "Binders" in English | **As recommended** |
| Q13 | Change password and Sign out other devices | show them to every signed-in user in multi-user mode, under Settings › Account (the server already allows it) | keep them admin-only under Users | **As recommended** |
| Q14 | Card detail on the iPhone | a page sheet that slides up, with a grabber and swipe down to close; the content stays the same | keep today's floating dialog (the card system's shared frame) | **As recommended** |
| Q15 | Analytics | open on Investment, order Investment · Movers · Rarity · Duplicates | keep Duplicates first | **As recommended** |
| Q16 | What the eye hides | every amount in the app (masked in `formatPrice`) | only portfolio totals on Home, Profile and Collection | **As recommended** |
| Q17 | Scan button in version 2 | a Poké Ball whose top half is the theme colour | the plain theme-coloured circle of Q2 | **As recommended** |
| Q18 | Playful wording | a little, in new strings only ("Latest pulls", "N caught", "species caught") | plain wording | **As recommended** |
| Q19 | Series pictures | the logo of the series' own first set, with no server change | the server downloads the official series logos during sync | **The server downloads the series logos** (approved backend change, P6a) |

**Decided in P0** (no answer needed; reasons in the sections named): offline-queued uploads are not counted on the Scan circle (§5.3); one status line for offline and saved data (§6.6); muted text uses systemGray (§7.1); accent text uses the light accent and black on light accents (§7.2, §7.3); Collection's "⋯" keeps Export PDF and has no Select (§5.2); Multi-user mode lives in "Users & sign-in" (§5.6); the tab bar hides while typing (§6.12); the bottom inset is capped at 34 px (§7.1); the history mirror for back (§6.4); `#root > *` stays (§7.5); `InstallHint` stays in `Layout` (§8); new shell tests also run in WebKit iPhone emulation (§12).

## 18. Docs to update
- `docs/FRONTEND.md` (P2, then each phase): the Navigation section (`navConfig`, `TabBar`, `NavBar`, Profile, the Settings routes, `ScannerContext`) and the route table (`/profile`, `/settings/:section`, the `/dashboard` redirect, the catch-all).
- `docs/PWA.md` (P2): where the sync indicator, the status line and Log out now live (it says "a small button at the top right" and describes the Home logout).
- `docs/BACKEND.md` (P6a): the `series_id` and `series_logo` columns, the sync change and the `series` image type.
- `README.md` (P9): screenshots and feature bullets.
- This file stays as the rationale; its status banner changes when the work ships.

## 19. Sources
- [frappe-ui PR #1284](https://github.com/frappe/frappe-ui/pull/1284): the iOS 26 short viewport in an installed PWA (WebKit 301108) and the fix.
- [joe-bell/skills, apple-web-app status bar notes](https://github.com/joe-bell/skills/blob/main/skills/apple-web-app/references/theme-color-and-status-bar.md): status bar styles; `theme-color` ignored by Safari 26.
- [autobrr/qui #2520](https://github.com/autobrr/qui/issues/2520): iOS 26.1 draws a gradient over a `black-translucent` status bar.
- [coder/xum PR #5642](https://github.com/coder/xum/pull/5642) and [Zenbat PR #176](https://github.com/Dursun242/Zenbat/pull/176): an inflated bottom safe-area inset in standalone mode.
- [Discourse Meta, "Back button in iOS PWA"](https://meta.discourse.org/t/back-button-in-ios-pwa/93909): no swipe-back in standalone mode.
- [Can I use: View Transitions](https://caniuse.com/view-transitions) and [React Router: view transitions](https://reactrouter.com/how-to/view-transitions).
- Apple Human Interface Guidelines: typography (text styles), color (system colors), materials, tab bars, navigation bars, sheets, menus, action sheets, alerts, segmented controls, lists.
- WCAG 2.2: 1.4.3 Contrast (minimum) and 1.4.11 Non-text contrast; ratios in §7.4 computed with the WCAG relative-luminance formula.
- In the repo: `docs/PWA.md`, `docs/PWA_OFFLINE_DESIGN.md` (§D13, §6.4, §9.1.8, §10.3), `docs/CARD_SYSTEM.md`, `docs/FRONTEND.md`.
