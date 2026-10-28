# Engagement rollout — design for PokéCollector

Status: P0 (2026-10-28). Integration branch `nonprod`, cut from `deploy` @ `0c2cbb8`. Owner decisions are in §0. Every phase is a PR into `nonprod`, and each milestone reaches `deploy` only with the owner's OK.

## 0. Owner decisions

The owner chose these from a review of the shipped app (2026-10-28) and accepted the coordinator's defaults ("Start P0 with your defaults").

**In scope**
- Notifications by category, and a number on the app icon.
- Achievement unlock moments and new badges, in single-user mode too.
- A weekly recap, and "2026 Wrapped", which must be on `deploy` by **1 December 2026**.
- The daily loop:
  - a Today card;
  - whether you own the Pokémon of the day;
  - a streak with a freeze;
  - quests, XP and a trainer level;
  - Who's That Pokémon.
- A holo viewer with foil patterns. The owner noted that some holos have special patterns.
- Chase goals.
- A book view for sets and binders (Grid | Book). **Drag and drop is wanted**, so a binder's pockets mirror the physical binder.
- On this day, Showcase 6, and Collection DNA.
- Social: swap offers, an activity feed and a weekly challenge, all three, behind an admin switch that is off by default.

**Dropped:** pack-opening mode and deck playtest.

**Coordinator positions the owner accepted**
1. The icon number counts only things to act on: scans to review, and later swap offers waiting for you. It never counts "unseen alerts".
2. History is recorded from P1 on, so Wrapped, the feed, achievements and quests have data.
3. Chase goals are rules (set, generation, family, artist) that grow with new releases. They are not Planned Binders, but a goal can offer "make a Planned Binder from this".
4. Home gets one Today card (Pokémon of the day, Who's That Pokémon, streak and quests). The recap and On this day appear only when there is something to show, and the goal ring sits with Your sets.
5. The weekly challenge rewards everyone who finishes, with a podium for bragging.
6. Price alerts need a minimum amount as well as a percentage.
   - Dips, movers and new sets go out as one daily digest; scans-ready and swap offers are instant.
   - The unused `price_alerts_enabled` / `price_alert_threshold` setting becomes "big movers in your collection".
7. There are no "you'll lose your streak" pushes; the streak lives in the app.
8. Binder pockets hold one copy each. Removing a card leaves its pocket empty, new cards take the first free pocket, and a "close gaps" action tidies up. Dragging starts with a long press, and VoiceOver users get a "Move to…" sheet.
9. Everyone gets the same Who's That Pokémon each day. It is fetched ahead like the splash, so it works offline, and offline days count for the streak.
10. Streak days follow the phone's time zone.
11. Badges a trainer already qualifies for unlock silently the first time (no flood of sheets or pushes).

**Defaults the owner accepted**
- The daily loop is on for everyone, with one Settings switch to hide streaks and quests. There is one streak freeze a week. XP comes from engagement and completions, never per card added.
- Collection keeps Grid | List; sets and binders get Grid | Book.
- Notification defaults: scans-ready, new sets and dips are on; the weekly recap push is off.
- nonprod starts from a copy of prod's data.
- A promotion after each milestone.
- At most three workers at once on the owner's PC.
- The first foil patterns: holo, reverse, cracked ice, cosmos, textured/etched, rainbow, gold, Poké Ball reverse.

**Still open:** the nonprod hostname, which the owner sets up in Nginx Proxy Manager (see `docs/NONPROD.md`).

## 1. Summary

The app already has strong passive hooks: the Pokémon of the day, price alerts, closest-to-complete sets and leaderboards. It has little that pulls a trainer back, celebrates progress, or lets trainers interact. This rollout adds:
- one progress engine (P1);
- notifications that bring people back (P4);
- moments and rewards (P6, P7);
- recaps and goals (P9, P10);
- things to look at and play with (P2, P3, P5, P8);
- social actions (P11–P13).

## 2. Principles and non-goals

- **Follow `docs/IOS_UI_DESIGN.md`.** Keep the Pokémon layer (§7.12), accessibility (§2), and "no ambient animation". Motion is one-shot or driven by touch or tilt, and always has a Reduce Motion fallback.
- **Small diffs in upstream files.** New code goes in new files. Upstream endpoints are not edited to record events (§6).
- **Works in single-user mode,** except social.
- **Offline is stated per feature.** Reading works offline wherever the data is cached. Writes that the outbox can't queue say "Needs a connection".
- **Hide values.** Every amount goes through `formatPrice` and is masked by the eye. Share images respect it.
- **Push payloads say what they are about.** Detail is the default: the card, the price and the drop, the set names, the badge and its tier. A per-user switch, "Show card names and prices in notifications" (`notify_show_details`, default on), turns this off, and the pushes fall back to the earlier content-light texts. The details are stored when the notification is queued, so they match the moment of the event.
- **New strings go in `en.js` only.** Other languages show English.
- **Non-goals:** native wrappers, light mode, a pack simulator or pull-rate odds (no data), comments or chat, money between trainers.

## 3. Verified code facts (`nonprod` @ `0c2cbb8`)

**Push and notifications**
- Push is used only for wishlist price thresholds: `services/push.py` `send_price_alert`, called from `sync_service.check_wishlist_alerts`, once per item per 23 h.
- Payloads are `{"web_push": 8030, "notification": {title, body, navigate}}`.
- VAPID keys live in `/app/data/auth/vapid_private.pem`, not in the database.
- `telegram.send_new_sets_notification` exists but is never called.
- The global settings `price_alerts_enabled` and `price_alert_threshold` are saved by Settings and read by nothing.

**Achievements**
- 20 fixed thresholds in `api/social.py` `ACHIEVEMENTS`, computed on request from `_load_user_stats()`. Nothing is stored and nothing fires on an unlock.
- `pages/Achievements.jsx` redirects to `/` in single-user mode, and Profile hides the gym badges there.

**Scheduler**
- `services/scheduler.py` runs the full sync (every 5 days), the price sync (every 30 min), scan-queue maintenance (every 1 min) and idempotency cleanup.
- Both syncs end with `check_wishlist_alerts` then `take_portfolio_snapshot` (`sync_service.py` ~1133 and ~1247).

**Schema and migrations**
- New tables come from `Base.metadata.create_all` in `database.init_db()`.
- New columns need an idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` in `_run_migrations()`. It is PostgreSQL only and its errors are swallowed; tests on SQLite build tables from the models.

**Backups**
- A full backup is a pg_dump of everything.
- Selective groups are listed in `api/backup.py` `BACKUP_GROUPS`.
- The restore guard (`services/restore_sql_guard.py`) filters by statement type, not table name, so new tables need no change there.

**User deletion**
- `api/auth.py` deletes each table's rows by hand with bulk `query().delete()`. New per-user tables must be added there.
- Bulk deletes skip ORM events.

**Binders**
- `binders` plus `binder_cards`. A collection binder's row links one `collection_item_id` with `required_quantity` copies.
- There is no position column. `BinderDetail.jsx` sorts client-side (`binderSortBy`, default `recent`) and renders `CardListGallery`.
- Planned binders (`binder_type='wishlist'`) already compute `cost_to_complete`.

**Sets**
- `SetDetail.jsx` is a 3-column `CardDisplay` grid with:
  - an owned/missing filter, sort, rarity filter, search in set and "Split variants";
  - Complete set and Master set progress.
- It has no view switch. `Collection.jsx` has a Grid | List switch (`viewMode`).

**Holo**
- `utils/cardVariantEffect.js` maps only the owned variant (Holo, Reverse Holo, First Edition) to a looping diagonal sweep (`index.css` `.card-variant-*`).
- `hooks/useTilt.js` exists and is imported nowhere.
- `public/cardback.jpg` exists.

**Card data**
- Card: `rarity`, `types`, `subtypes`, `supertype`, `artist`, `dex_ids`, `variants_*`, `price_avg7`/`price_avg30` (and holo variants).
- Set: `release_date`, `series`.
- Collection: `added_at` (never edited), `acquired_at` (owner-editable, NULL = `added_at`), `variant`, printing-detail tags.

**Social**
- `api/social.py` has only GET routes: leaderboard, compare and achievements.
- Compare's trade suggestions are duplicates on the other trainer's wishlist (respecting `wishlist_visibility`).
- `Trade.partner_name` is free text. Logging a trade already moves the cards in the collection.

**Daily Pokémon and Home**
- The splash's Pokémon of the day comes from a fixed date order (`services/pokedex_splash.py`, `components/splash/`) and is prefetched for tomorrow.
- `TodayCard.jsx` shows it on Home.
- `pages/homeHelpers.js` has `closestToCompleteSets` and the to-do cards.

**Per-user settings:** `user_settings` is a (user_id, key, value) store.

## 4. Branches, environments, process

- **Branches:** `nonprod` is the integration branch, and `docs/NONPROD.md` has the test stack setup. Phase branches are `feature/np-pNN-<slug>`, cut from `origin/nonprod`, with their PR into `nonprod`.
- **CI:** it runs on every PR and every push to `nonprod`. A green `card-system` run on the `nonprod` head is the pre-promotion check.
- **Workers:**
  - A fresh worker per phase: Sonnet 5.5 at medium effort, in its own worktree.
  - Locally they run only `npm test`, `npm run build`, the backend tests they touch, and their own new specs. CI runs the full suites.
  - No Claude attribution in commits or PRs. PRs are opened with `gh … --repo IDEKENTERPRISES/pokecollector`.
- **Merging:** the coordinator squash-merges only PRs that are up to date with `nonprod` and green. Phases that touch Home or the trainer card (P6–P10) run one at a time; at most three workers run at once.
- **Milestones:** each ends with an owner test round on the nonprod stack (tracker page), then `nonprod` → `deploy` with the owner's OK. A fix that lands on `deploy` is merged back into `nonprod`.

## 5. Data model (P1)

All new per-user tables use `ForeignKey("users.id", ondelete="CASCADE")`, are added to the user deletion in `api/auth.py`, and are added to `BACKUP_GROUPS["users"]`. Timestamps are naive UTC, like the rest of the schema.

**`progress_state`**: one row per user, the evaluator's memory.

| column | type | notes |
|---|---|---|
| `user_id` | int PK, FK users | |
| `evaluated_at` | datetime, null | last finished evaluation |
| `dirty_at` | datetime, null, indexed | set when something changed; cleared by the evaluator |
| `completed_sets` | JSON list | `"<tcg_set_id>_<lang>"` keys complete at the last evaluation |
| `last_seen_collection_id` | int, default 0 | high-water mark for new collection rows (big pulls) |
| `state_version` | int, default 1 | bump when the stored shape changes |

**`user_events`**: what happened, written only by the evaluator and later phases' services.

| column | type | notes |
|---|---|---|
| `id` | int PK | |
| `user_id` | int, FK users, indexed | |
| `kind` | varchar(40) | P1 kinds: `set_completed`, `achievement_unlocked`, `big_pull` |
| `occurred_at` | datetime, indexed | |
| `subject_key` | varchar(160), null | set key, achievement id, collection item id |
| `payload` | JSON | small: names, numbers, card id; no secrets, no prices beyond what the owner already sees |
| `dedupe_key` | varchar(200) | `UniqueConstraint(user_id, dedupe_key)` makes writes idempotent |

**`user_daily_activity`**: one row per user per local day the app was opened.

| column | type | notes |
|---|---|---|
| `id` | int PK | |
| `user_id` | int, FK users | `UniqueConstraint(user_id, local_date)` |
| `local_date` | date | the phone's local day |
| `first_seen_at`, `last_seen_at` | datetime | server receive times |
| `opens` | int, default 1 | |
| `offline` | bool, default false | true when the date came from the offline replay |
| `data` | JSON, default `{}` | reserved for P7 (quests) |

**`user_achievements`**

| column | type | notes |
|---|---|---|
| `id` | int PK | |
| `user_id` | int, FK users | `UniqueConstraint(user_id, achievement_id)` |
| `achievement_id` | varchar(64) | an `ACHIEVEMENTS` id |
| `unlocked_at` | datetime | |
| `seen_at` | datetime, null | P6 sets it when the unlock sheet was shown |
| `notified_at` | datetime, null | P6 push |
| `backfilled` | bool, default false | unlocked on the trainer's first evaluation; never celebrated |

**`binder_slots`**: physical pockets (used by P5), added to `BACKUP_GROUPS["collection"]` and to the binder deletion paths.

| column | type | notes |
|---|---|---|
| `id` | int PK | |
| `binder_id` | int, FK binders `ondelete=CASCADE` | `UniqueConstraint(binder_id, slot_index)` |
| `slot_index` | int ≥ 0 | page = `slot_index // pocket_layout` |
| `binder_card_id` | int, FK binder_cards `ondelete=CASCADE` | `UniqueConstraint(binder_card_id, copy_index)` |
| `copy_index` | int ≥ 0 | 0 … `required_quantity-1` |

The ORM relationships (`Binder.slots`, `BinderCard.slots`) use `cascade="all, delete-orphan"`. Code that bulk-deletes `binder_cards` (user deletion, binder deletion, conversions) must delete `binder_slots` first. P1 adds that to every bulk path it finds, and lists them in the PR.

**New columns** (model plus migration line in `_run_migrations`):
- `binders.pocket_layout` INTEGER DEFAULT 9: 4, 9 or 12 pockets a page; it is validated in the API, not by a CHECK.
- `collection.foil_pattern` VARCHAR NULL: a foil pattern id (P3). NULL means automatic.

**No schema:** the time zone goes in `user_settings` key `time_zone`, an IANA name validated with `zoneinfo`.

## 6. Progress engine (P1)

Code: `backend/services/progress/` (`state.py`, `evaluator.py`, `listeners.py`, `checkin.py`) and `backend/api/progress.py` (router `/api/progress`).

**Dirty marking (fast path)**
- A session `after_flush` listener collects the user ids of new, changed or deleted `CollectionItem`, `BinderCard` (through its binder), `WishlistItem`, `Trade` and `ProductPurchase` objects into `session.info`.
- `after_commit` upserts `progress_state.dirty_at = now()` for them in a short separate session. `after_rollback` discards them.
- It is registered once at startup (`main.py` lifespan, one line).
- It is best-effort: bulk `query().delete()` and raw SQL skip it, and the slow path covers them.

**Evaluator**
- `evaluate_user(db, user_id)` uses the user's own price field (`sync_service._user_price_field`).
- It loads stats with `api.social._load_user_stats(db, [user_id], price_field)`, imported lazily; the function is not moved, to keep the upstream diff small.
- Achievements: each `ACHIEVEMENTS` entry at or past its target without a `user_achievements` row is inserted.
  - On the trainer's **first** evaluation (no `progress_state` row) the rows get `backfilled=true`, `seen_at=now`, and no event.
  - Later they get an `achievement_unlocked` event.
- Sets:
  - It computes the complete set keys the same way `_load_user_stats` counts `sets_completed`.
  - New keys since the last evaluation become `set_completed` events (payload: set name, language, total).
  - The first evaluation only stores them.
- Big pulls:
  - Collection rows with `id > last_seen_collection_id` and an effective market price of at least `BIG_PULL_EUR` (default 20, in `services/progress/state.py`) become `big_pull` events (payload: card id, name, variant).
  - Rows whose `added_at` is older than 2 days are skipped (imports, restores).
  - The high-water mark then moves to the maximum id. The first evaluation only sets the mark.
- Each evaluation is one transaction, idempotent through `dedupe_key`. One user's failure is logged and never blocks the others.

**Triggers (slow path, `services/scheduler.py`)**
- `progress_dirty_job` every 2 minutes evaluates users with `dirty_at` set, oldest first, at most 25 a run.
- After every price sync and full sync, every active user is marked dirty (value-based badges). It is one guarded call after `take_portfolio_snapshot` in each sync; the only edit to `sync_service.py`.
- `progress_nightly_job` at 03:30 server time marks every active user dirty: the safety net for anything the listeners missed.

**Check-in**
- `POST /api/progress/checkin` takes `{time_zone, dates: ["YYYY-MM-DD", …]}`. It holds up to 14 local dates: today, plus days the app was opened offline.
- It stores the time zone and upserts `user_daily_activity`.
- It rejects dates in the future (with a 1-day allowance for time zones) and dates older than 14 days.
- It returns `{local_date, days_recorded}`.

**Check-in, client side**
- A small module `frontend/src/progress/checkin.js` keeps a per-user list of pending local dates in `localStorage`. The current user is always known on start, including the degraded offline start.
- It adds today's local date on start and on return to the foreground, and sends the list when online, dropping what the server accepted.
- It never shows an error and never blocks start-up.

**Own events (debug and later phases)**
- `GET /api/progress/events?limit=50` returns the current user's own events, newest first.
- The read cache must skip it (add it to `READ_CACHE_DENY`) until P12 decides what is shareable.

**Not in P1:** UI, pushes, XP, quests, dex milestones.

**P1 acceptance**
- Tables and columns exist on a fresh database and after an upgrade.
- The first evaluation backfills silently.
- Adding a card that completes a set gives exactly one `set_completed` event within one dirty cycle.
- A price sync that pushes portfolio value over a threshold gives one `achievement_unlocked` event.
- Deleting a user removes all their new rows.
- A binder delete removes its slots.
- Check-in stores the time zone and dates, is idempotent, and rejects dates out of range.
- No change to any existing API response, except `foil_pattern` appearing on collection items.
- Backend unit tests cover each of these. Visual snapshots are unchanged.

## 7. Phases

Size: S = one PR, M = a few days of worker time, L = several PRs.

### Milestone A — look and notify (round 1, promotion 1)

**P1 Groundwork (M, backend, nothing visible).** §5–§6. Starts once this doc is merged.

**P2 Book view (M, frontend).** Starts after the owner OKs the mockups.
- A shared `components/book/BookView.jsx`:
  - pages of `pocket_layout` pockets (3×3 by default);
  - horizontal swipe and buttons to turn pages, with a one-shot page turn (instant under Reduce Motion);
  - a page counter, and "Go to page".
  - On iPad and desktop (≥ 1024 px), two-page spreads.
  - Only the current page ± 1 is rendered.
- Set page: a Grid | Book switch next to the filter, remembered per device.
  - The book is in collector-number order, with ghosted pockets for missing cards that show the number and dimmed art.
  - With Split variants, each variant gets its own pocket (master set).
  - The filters still apply: "Missing" shows only ghosts.
- Binder page: Grid | Book. Until P5 the book follows the chosen sort; planned cards show as ghosts.
- Works offline from the card database.
- Tested in WebKit with a 250+ card set and the CPU slowed down.

**P3 Holo viewer (M, frontend).** Starts after the mockup OK.
- On the card sheet's artwork:
  - tilt by finger drag, and by device motion after a "Tilt with your phone" tap (iOS `DeviceOrientationEvent.requestPermission`);
  - glare that follows the light, and a flip to `cardback.jpg`.
  - Under Reduce Motion: no motion tilt, a static sheen, and a tap to flip.
- A foil library in `components/holo/`:
  - `holo`, `reverse`, `cracked-ice`, `cosmos`, `etched` (textured full arts and illustration rares), `rainbow`, `gold`, `pokeball-reverse`;
  - CSS gradient and mask layers moved by CSS variables. No canvas, no WebGL.
- Automatic choice in `components/holo/foilRules.js`: an ordered table of rarity, subtype, set and variant rules with unit tests. Unknown cards fall back to `holo` / `reverse` / none.
- Overrides, strongest first:
  1. the copy's `foil_pattern` (picker on the card sheet, needs P1);
  2. a printing-detail tag whose name matches a pattern ("Cracked ice", "Cosmos", …);
  3. the rules.
- List tiles keep today's shimmer.

**P4 Notifications and icon number (M, backend, service worker and Settings).** After P1.
- Categories, each a per-user switch in `user_settings`:

  | category | default | timing |
  |---|---|---|
  | scans ready to review | on | instant |
  | new sets | on | digest |
  | wishlist dips | on | digest |
  | big movers in your collection | off | digest |
  | weekly recap | off | — (P9) |
  | badges | on | — (P6) |
  | goal milestones | on | — (P10) |
  | swap offers | on | — (P11) |

  The rows for later phases are wired as they ship.
- Wishlist dips: the effective price is at least 15 % below `avg30` **and** at least €1 lower (constants). Each card is told at most once a week.
- Big movers: owned cards move by the existing `price_alert_threshold` percent (default 10) **and** at least €2. That repurposes the dead global setting as the default.
- New sets: when a sync marks sets `is_new`, push to users with the category on. `send_new_sets_notification` is also called for Telegram.
- The digest is one push a day at 18:00 in the user's time zone (falling back to the server's). Quiet hours are 22:00–08:00, and instant pushes wait until the end of quiet hours.
- The service worker routes each notification to its page (`navigate`).
- **Push texts** (English, prices in EUR as stored, a body fitted to 300 characters with "and N more", never more than 4096 bytes). Each queued row keeps a `details` JSON (card name, set name and code, number, price, baseline, drop or change %, threshold, set name, scan count, badge id) as of the event.

  | push | title | body |
  |---|---|---|
  | one wishlist dip | Wishlist dip | Charizard ex (OBF 125) is down 18% to €12.40 (30-day avg €15.10) |
  | several dips | 3 wishlist dips | Charizard ex −18% €12.40 · Pikachu −16% €3.10 · … (biggest drop first) |
  | big movers | Big mover / 3 big movers | Pikachu ex (SSP 57) is up 12% to €30.00 (7-day avg €26.80); several: Pikachu ex ▲12% €30.00 · Mewtwo ▼11% €8.00 |
  | new sets | New set / 2 new sets | the set names |
  | mixed digest | counts, e.g. "2 wishlist dips, 1 new set" | one line per category: `Wishlist: …`, `Movers: …`, `New sets: …` |
  | wishlist price alert (instant) | Wishlist price alert | Charizard ex is now €12.40, under your €13.00 alert |
  | badge (instant) | Badge unlocked | the badge's English name and tier, e.g. Species Seeker 50 · Bronze |
  | scans ready (instant) | PokéCollector | 3 scans ready to review (with `app_badge`) |

  The digest still goes out once a day. It opens the page that fits: `/wishlist` for dips only, the card (`/collection?cardId=…`, or `/wishlist` for a dip) when it is about exactly one card, `/collection` for movers only, `/sets` for new sets only, otherwise `/`. Rows queued before `details` existed are shown as counts.
- **Privacy switch.** "Show card names and prices in notifications" (`notify_show_details`, default on). Off sends the earlier texts: counts only for the digest ("2 new sets, 1 wishlist dip"), "Scans ready to review", "You earned a badge", and the wishlist alert as "Wishlist price alert" / "A card on your wishlist hit your price alert" (no card name).
- Icon number: `navigator.setAppBadge(n)` where n = scans needing review (+ swap offers from P11).
  - It is set by the app on start, on foreground and after scan changes, and by the service worker on an actionable push (n included in the payload).
  - It is cleared at 0. It needs notification permission (iOS 16.4+ Home Screen apps).
- Settings › Notifications gets the category switches under the existing device switch, plus the card-details switch.
- Tests: digest assembly, the thresholds, quiet hours, the service worker routing (`sw.test.js`), and the Settings switches.

### Milestone B — progress (round 2, promotion 2)

**P5 Binder pockets with drag and drop (M).** After P1 and P2.
- Slots are assigned lazily in the binder's current order the first time it opens in Book.
- New copies take the first free pocket, and removed copies leave a gap.
- "Close gaps" compacts the pockets, and the page size can be changed (4/9/12).
- Drag: a long press (350 ms) lifts the card.
  - Dropping on a pocket swaps or moves it; dragging to an edge turns the page.
  - It uses pointer events, with no library.
- "Move to…" sheet: page and pocket pickers, for VoiceOver and for precision.
- API: `GET/PUT /api/binders/{id}/slots`, as a whole-layout PUT with a version check.
- CSV export gains page and pocket columns. Import accepts them; they are optional.

**P6 Achievements (M).** After P4.
- A new registry in `services/achievements.py` re-exports the old 20, so `api/social.py` keeps working.
- New badges, a proposed list for the owner:
  - Pokédex milestones (10/50/100/250/500/1000 species, each generation complete);
  - a card of every type;
  - first holo, first illustration rare (exists), first full art;
  - first scan, first trade, first deck;
  - set master;
  - streaks (7/30/100);
  - Who's That Pokémon (7 right in a row).
- Tiers are bronze, silver and gold where a badge has steps.
- Unlock sheet: a one-shot holo badge sheet shown once (`seen_at`), queued if several unlock together. Optional push (category "badges").
- Single-user mode: the Achievements page and the gym badges work. Gym badges = 8 tracks, each lit by its highest tier.

**P7 Daily loop (L).** After P6.
- The Today card on Home replaces `TodayCard`'s position.
  - Pokémon of the day, with "You own N printings", or "cheapest print €x → wishlist".
  - Streak flame.
  - Three quests with ticks.
  - The Who's That Pokémon tile.
- Streak: consecutive local days in `user_daily_activity`. One freeze a week is spent automatically.
- Quests: 3 a day from a catalogue, chosen deterministically per user and date and checked by the evaluator. Examples:
  - review your scans;
  - add a card to a binder;
  - look at today's Pokémon;
  - play Who's That Pokémon;
  - add a missing card from your closest set.
- XP ledger (new table `user_xp_ledger`: source plus a unique source key):
  - XP comes from quests, streak days, badges and set completions;
  - level = a gentle curve;
  - shown on the trainer card and as a leaderboard column.
- Who's That Pokémon:
  - one deterministic species a day, the same for everyone, from the splash's species data and sprites;
  - a silhouette, four choices, one try;
  - fetched ahead with tomorrow's splash and playable offline, with the result sent on reconnect;
  - Wordle-style share text.
- Settings › Appearance: "Show streaks and quests" switch (default on).

**P8 Small delights (M).** After P7.
- On this day: a Home card, only when cards were acquired on this day in earlier years (`acquired_at` or else `added_at`).
- Showcase 6:
  - pick up to 6 owned copies (`user_settings` key `showcase`, list of collection item ids; missing ids are skipped);
  - shown on the trainer card and on the public profile when public profiles are on (values follow the public value setting).
- Collection DNA, a Profile row and page:
  - type wheel, top illustrators, eras by release year, most-collected Pokémon;
  - computed by `GET /api/analytics/dna`;
  - read-cached for offline.

### Milestone C — recap and goals (round 3, promotion 3, on `deploy` by 1 December)

**P9 Weekly recap and 2026 Wrapped (L).** After P8.
- Weekly recap from Monday to Sunday: cards added, value change, best pull, closest set, streak, badges. It is a Home card from Sunday 18:00 to Tuesday, with an optional Sunday push.
- Wrapped is a story of 8–10 tappable slides, from 1 December to 15 January, on Home and Profile. Its data:
  - collection `added_at` / `acquired_at` in the year;
  - `portfolio_snapshots`, trades and products;
  - `user_events` (from P1 on), `user_daily_activity`, and the DNA stats.
- Share images are drawn with Canvas 2D (no new library). Card images are same-origin through the image proxy, so the canvas isn't tainted. They are shared with `navigator.share({files})` (or downloaded where that's unsupported), respect hide-values, and are reused by DNA, Showcase and the recap.

**P10 Chase goals (M).** After P9.
- New table `user_goals`: kind (set, set_master, generation, family, artist, custom planned binder), params (JSON), pinned flag and timestamps.
- Progress is computed live, with the cost to finish at the user's price field and the cheapest missing cards with Cardmarket links.
- Add the missing cards to the wishlist; make a Planned Binder from a goal.
- A Home ring for pinned goals (next to Your sets).
- Milestone pushes at 50/75/90/100 % (category "goal milestones").
- Set detail also shows "Cost to complete".

### Milestone D — social (round 4, promotion 4; admin switch, off by default)

Social phases may be built during B and C, because the switch keeps them dormant on `deploy`.

**P11 Swap offers (L).** After P4.
- An offer is made from a Compare suggestion: card picker on both sides, cash optional, and the fair-trade meter from Trades.
- States: proposed → countered ↔ proposed → accepted → completed (both tapped "Swapped") / declined / cancelled / expired (14 days).
- On completion it re-checks every copy:
  - still owned and the quantity is available;
  - binder or deck allocations released;
  - product-linked copies handled like Trades does.
- Then it logs a `Trade` for each side through the existing trade engine, with `partner_name` filled and a link to the other trade.
- Push to the other trainer (category "swap offers"). The icon number counts offers waiting for you.

**P12 Activity feed and reactions (M).** After P6 and P11.
- A feed of other trainers' shareable events. Each trainer picks per kind what to share (default: set completions and badges); values are hidden unless they opt in.
- One-tap reactions (table `event_reactions`), no comments.
- It lives as a segment on Leaderboard.

**P13 Weekly challenge (M).** After P7 and P12.
- One shared goal a week from a catalogue, built on the quest engine.
- A progress board, a badge for everyone who finishes, and a top-3 podium.

**P14 Docs and cleanup (S).**
- README feature bullets and screenshots; `FRONTEND.md`, `BACKEND.md`, `PWA.md`.
- Remove dead code that the rollout replaced.
- An optional translation pass.

## 8. Definition of done (every phase)

- Single-user and multi-user mode both work, with roles respected.
- Hide-values masks every amount.
- Reduce Motion and VoiceOver work, with 44 pt targets.
- The offline behaviour is stated and tested where it matters.
- New tables are in a backup group and in user deletion. New columns have a migration line.
- Strings are in `en.js` only.
- Tests: unit tests for the logic, and specs for the UI that also run in WebKit for iPhone flows. Visual snapshots are regenerated in Docker on Linux only, when they change.
- iPhone-heavy UI (book, holo, Today card, Wrapped) is measured in WebKit, with about 30k cards in the card database and the CPU slowed down.
- Docs are updated for what changed.
- The PR is up to date with `nonprod`, CI is green, and there is no attribution.

## 9. Testing rounds

The tracker page holds each round's checks for the owner, on the nonprod Home Screen app:
- **A:** book view on a big set, holo patterns, notifications and the icon number.
- **B:** drag and drop, badges, the daily loop over two or more days including one offline, small delights.
- **C:** recap, Wrapped (with a date override for testing), goals.
- **D:** social, with a second trainer account on nonprod.

## 10. Risks

- **iPhone performance:** book pages and holo layers must stay light (§8), as in the offline rounds.
- **Notification fatigue:** a digest, quiet hours, per-category switches and conservative thresholds.
- **Upstream merges:** new files, and one-line hooks in upstream files.
- **Wrong foil guesses:** the per-copy override and tag override come first, and the rules table is easy to extend.
- **Wrapped accuracy:** cards removed before P1 leave no trace; Wrapped counts what is still known and says "since you started using PokéCollector" where history is short.
