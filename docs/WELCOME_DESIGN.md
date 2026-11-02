# Welcome and What's new — design for PokéCollector

Status: design for owner approval (2026-11-02). Mockups: the Design canvas, row **"Wave 4 — Welcome and what's new"** (https://claude.ai/artifact/QNJ3UNo7XYj1ze96mkcFGF). The build (P15, P16) starts only after the owner approves them.

What this builds on:
- The plan of record is `docs/ENGAGEMENT_DESIGN.md` §7 milestone E, including both "Owner's answers" blocks (2 November 2026), which override its bullets.
- Both phases are for every trainer in multi-user mode. The tour is not shown in single-user mode. Social steps appear only while `useSocialEnabled()` (`frontend/src/social/social.js`) is true.

**How to build from this doc.** The artboards use the app's real tokens, type styles, radii and components (§4). An implementation ports them literally: the same component, the same class, the same number. Where an artboard and this doc disagree, ask; don't average them.

---

## 0. Decisions for the owner

Each has a recommendation, which the mockups show.

| # | Question | Recommended | Alternative |
|---|---|---|---|
| E1 | Should **Skip** ask first? It ends the tour for good. | **One** quiet confirmation ("Skip the tour?" with where to find it again), so a stray tap doesn't lose it. | Skip at once; Settings replays it. |
| E2 | Where does the **Home Screen** step sit? | Right after the welcome, so a trainer who leaves to add the app loses almost nothing. | Just before the scan step, where notifications need it. |
| E3 | Do the **weekly challenge** and **swapping** each get their own step (social on)? | **Yes, two short steps**, as you asked: 8 steps with social on, 6 with it off. | Fold both into the Home and Profile steps (7 and 6). |
| E4 | **Past releases.** The 23 deploys since `8f5acbf` | Four entries, one per named release (§8). | One entry per deploy day, with evolutions (Ivysaur, Venusaur…) for the in-between days. |
| E5 | **Chikorita** and Wrapped. Wrapped is hidden on `deploy` until December. | Mention it as "arrives in December" in the third highlight. | Leave it out until it opens. |
| E6 | **Squirtle** has more than three headline features (daily loop, badges, binder pockets, Book view, holo cards, notifications). | Highlights: daily loop, badges, binder pockets and Book view; holo cards and notifications in the details. | Swap in holo cards for badges. |
| E7 | **Other browsers** (not iPhone). The Home Screen push is about iPhone. | On Android/desktop Chrome the same step says "Install the app" when the browser offers it, and is skipped otherwise. | iPhone only. |
| E8 | **Take the tour card**: how a trainer dismisses it. | A quiet "Not now" line under the card; dismissing counts as done, like Skip. | An ✕ on the card. |

---

## 1. What good apps do

Principles only; no branded artwork is copied.

### 1.1 Onboarding and coach marks

| Source | What works | Take for us |
|---|---|---|
| [Apple HIG — Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding) | Keep any onboarding "fast, fun, and optional"; teach by letting people use the app; put a permission request where its reason is clear. | Under a minute, always skippable; the notification ask lives in the Scan step, next to the reason. |
| [Apple HIG — Offering help](https://developer.apple.com/design/human-interface-guidelines/offering-help) | Help that people can find again later, not only once. | "Show the tour again" in Settings › About. |
| [Appcues — user onboarding UX](https://www.appcues.com/blog/user-onboarding-ui-ux-patterns) and [NN/g on onboarding tutorials](https://www.nngroup.com/articles/mobile-tutorials/) | A spotlight on the real control beats a screenshot; one idea per step; show progress; skippable. NN/g found that front-loaded tutorials are rarely remembered, and contextual hints work better. | Hints point at the real tab or tile with the rest dimmed, one idea per step, "3 of 8" progress, and a Skip on every step. |
| [Material Design — Onboarding](https://m3.material.io/foundations/designing/onboarding) (principles) | Ask for permissions in context and let people carry on if they say no. | Declining notifications leaves a plain sentence and a pointer to Settings; the tour carries on. |

### 1.2 What's new

| Source | What works | Take for us |
|---|---|---|
| [Carbon Design System — Show what's new](https://carbondesignsystem.com/guidelines/onboarding/) (principles) | Show it once per version, let people revisit it, give a next step. | Once per account per update, "See everything" links to the history, and the history stays in Settings. |
| [UX Collective — better release notes](https://uxdesign.cc/as-a-designer-i-want-better-release-notes-3e8c8c785231) | Lead with a short summary, then the detail. Write for the reader, not as a changelog. | Two levels: ≤ 3 friendly highlights, then the full list in the history. |
| [Yellowhead — "What's new" section](https://www.yellowhead.com/blog/whats-new-section-in-your-app/) | Short, visual, not blocking the task; group by version and date. | A sheet that dismisses with a swipe; the history groups by release with the date under the name. |

### 1.3 What carries across

1. Hints point at the **real** control, with everything else dimmed.
2. One idea per step, two buttons at most per step.
3. Progress is visible, Skip is always there, and nothing is a trap.
4. Permission asks sit beside their reason, and "no" is a fine answer.
5. A What's new sheet appears once, is short, and the long version is findable later.

---

## 2. Principles

1. **Quiet and short.** Under a minute. Eight steps at most, one sentence or two each.
2. **Point at the real thing.** The spotlight ring sits on the real tab, tile or button, never on a picture of it.
3. **Honest about the browser.** A trainer in Safari is told plainly what they miss, twice asked, and then left free.
4. **Done means done.** The tour is marked complete only when it is fully finished or skipped; anything else starts over.
5. **Friendly words.** Highlights have no technical terms, no PR numbers and no code names.
6. **Works offline.** The tour, the sheet and the history all ship inside the app.

---

## 3. The tour (P15)

### 3.1 When it shows

| Case | Behaviour |
|---|---|
| New account, multi-user mode | Starts by itself on the first Home visit after sign-in. |
| Existing account | A **Take the tour** card on Home (§3.7). Starting it or dismissing it counts as done. |
| Single-user mode | No tour, no card, no Settings row. |
| Tour finished or skipped | Never shows again by itself; **Settings › About › Show the tour again** replays it. |
| Tour left part-way (app closed, or left to add the Home Screen app) | Starts again from the welcome next time, on any device, until finished. |
| Finished in the browser | Counts. The Home Screen app won't show it. |

Skip, "Explore on my own" and "Scan your first card" all mark the tour done. Only reaching the end screen, or a confirmed Skip, writes `tutorial_completed_at`.

### 3.2 The steps

Social **on** has 8 numbered steps, social **off** has 6 (the challenge and swap steps are left out and the numbers close up). The welcome, the Home Screen step and the end screen are not numbered.

| # | Step | Target | Title | Body |
|---|---|---|---|---|
| — | Welcome | centre card | Welcome to PokéCollector, {name} | A one-minute tour of where everything lives. |
| — | Home Screen (browser only) | centre card | Add PokéCollector to your Home Screen | It opens full screen like any app, tells you when scans are ready, and keeps your collection ready offline. |
| 1 | Today | the **Today card** | Your day starts here | The Today card has your Pokémon of the day, your streak and three daily quests. Finish them to earn XP. |
| 2 | Weekly challenge (social on) | the challenge row in the Today card | A challenge for everyone | Each week sets one goal for every trainer on this server. Finish it for a badge; the quickest finishers make the podium. |
| 3 | Collection | the **Collection** tab | Everything you own | Cards, binders and your wishlist live here. Switch between Grid, List and Book to browse your way. |
| 4 | Scan | the **Scan** button | Scan your cards | Point your camera at a card and PokéCollector finds it. Recognising a card can take a little while, so you can leave and come back. |
| 5 | Search | the **Search** tab | Find any card or set | Search every set and card, or open the Pokédex to see which Pokémon you've caught. |
| 6 | Profile | the **Profile** tab | Your trainer page | Analytics, trades, goals, badges and the leaderboard live here, with Settings too. |
| 7 | Swapping (social on) | the **Profile** tab | Swap cards with friends | Offer a swap from Trades › Offers. Nothing moves until you both tap Swapped after you meet. |
| 8 | Offline | centre card | Works without a signal | See §3.5. |
| — | End | centre card | You're ready | That's the tour. Replay it any time from Settings › About. |

Numbers above are social-on numbers; with social off, Profile is 5 and Offline is 6. The counter reads "{n} of {total}".

Buttons: every numbered step has **Next** (filled, `md`) on the right, **Back** (plain) on the left from step 2 on, and **Skip** in the card's top-right corner (plain, 44 × 44 target). The last numbered step's Next reads **Finish**.

### 3.3 The coach card and spotlight

- **Scrim:** a fixed layer at `z-index: 56` (above `--z-menu` 55, below the update banner's 60/70 and not over the scanner at 58 because the tour never runs while it is open), painted as one ring element with `box-shadow: 0 0 0 9999px rgba(0,0,0,0.72)` around the target's rect. The ring is the target's rect plus 6 px padding, fully rounded for tabs and the Scan button, 22 px for the Today card, with a 2 px `--color-tint` outline. The target is visible and untappable during the tour (the ring layer takes the taps).
- **Card:** `.glass`, `rounded-xl` (16 px), 16 px padding, full width minus 16 px side margins, max width 440 px. A 10 px arrow notch points at the target. It sits above the target for tab-bar targets and below it for Home targets, never under the safe areas.
- **Contents:** step counter (Caption 1, secondary), title (Title 3, display font), body (Callout, secondary), then the buttons row.
- **Progress:** "3 of 8" text, plus dots (6 px, 5 px gap; filled = `--color-tint`, empty = `--color-fill`). The dots are decoration for sighted users and `aria-hidden`.
- **Centre cards** (welcome, Home Screen, offline, end) sit over the dimmed app with no ring.

### 3.4 Skip and "are you sure?"

**Skip (E1).** On the welcome and on every step, **Skip** opens an `Alert` (the existing component):
- Title: **Skip the tour?**
- Message: You can replay it any time from Settings › About › Show the tour again.
- Buttons: **Keep going** (preferred) · **Skip** (destructive-free, plain).
- Confirming writes `tutorial_completed_at` with outcome `skipped`.

**Browser — Home Screen push (iPhone Safari, not the Home Screen app).** The step comes right after the welcome:
- Instructions, as numbered rows: 1 Tap **Share** (the Share glyph) in Safari's toolbar. 2 Choose **Add to Home Screen**. 3 Tap **Add**, then open PokéCollector from your Home Screen. The tour starts again there.
- Primary button **I'll add it now** closes the tour (state: part-way, so it starts over) and leaves the existing install hint on Home. A line at the top of Home says "Open PokéCollector from your Home Screen to take the tour."
- Secondary **Carry on in the browser** opens confirmation one:
  - Title: **Are you sure?**
  - Message: Without the Home Screen app you won't be told when scans are ready, and iPhone may clear your offline collection when you haven't visited for a while.
  - Buttons (stacked): **Add it first** (preferred) · **Carry on in the browser**
- Confirming that opens confirmation two:
  - Title: **Really carry on?**
  - Message: The tour will skip the notifications step. You can add the app any time: tap Share, then Add to Home Screen.
  - Buttons (stacked): **Add it first** (preferred) · **Yes, carry on**
- After "Yes, carry on" the tour continues; the scan step shows the browser variant (§3.5). The install hint (`InstallHint`) stays on Home as today.

On non-iPhone browsers (E7) the step reads "Install PokéCollector" with the browser's install button when `beforeinstallprompt` was captured, and is left out otherwise.

### 3.5 Scan, notifications and offline steps

**Scan step, in the Home Screen app.**
- Body as the table, then a second paragraph: **Want a nudge when scans are ready?**
- Button **Turn on notifications** (filled, `md`) runs `enablePush()` from `pwa/push.js`, which asks iOS for permission. The tour's **Next** stays available at all times.
- States:
  - *Asked* (before): the button above.
  - *On*: a green check line, "Notifications are on."
  - *Declined*: "No problem. You can turn them on later in Settings › Notifications." (`pwa.pushDenied` is the matching Settings hint.)
  - *Unsupported or no HTTPS*: the button is left out.

**Scan step, in the browser (after "Carry on in the browser").** No button. Footnote line: "Notifications need the Home Screen app. Add it later and turn them on in Settings › Notifications."

**Offline step** (a centre card, social on or off):

| Title | Works without a signal |
|---|---|
| Rows (icon + text) | **Browse** your collection, binders and card pages from the saved copy.<br>**Scan anywhere.** The photo waits on your phone and is recognised once you're back online.<br>**Changes wait their turn** and are sent when you're back online. |
| Footnote | Fresh prices and other trainers need a connection. Sync & offline in Profile shows what's saved. |

### 3.6 The end

Centre card with a Poké Ball, the title "You're ready", the sentence "That's the tour. Replay it any time from Settings › About.", then two buttons: **Scan your first card** (filled, `lg`) opens the scanner; **Explore on my own** (plain) closes the tour. Both mark the tour done.

### 3.7 "Take the tour" card on Home

For existing accounts that have not finished or skipped.
- It is Home's existing `TodoCard` (`pages/HomeScreen.jsx`): type `water` (gradient #236BB4 → #123F8C, white text, 6.8:1 at the lighter end), 64 px minimum, 18 px radius, an icon in a black/20 circle (`Compass`), title **Take the tour**, detail **A one-minute look around PokéCollector**, action pill **Start**.
- It sits at the top of the to-do cards, above the Today card.
- Under it a quiet line, **Not now**, as a 44 px-high text button in the secondary text colour. It counts as done (E8) and the card never returns.
- Starting the tour from it behaves as a new account's tour, but with the welcome shortened to a single title ("Here's a quick look around").

### 3.8 When social is off

Only the challenge step and the swap step are dropped. The scan, Profile and offline copy is unchanged. There is no mention of friends, swaps or the podium anywhere in the tour.

### 3.9 Data

| Field | Where | Notes |
|---|---|---|
| `tutorial_completed_at` | users table, `DateTime` nullable | Set when the tour is finished, skipped or the card is dismissed. |
| `tutorial_outcome` | users table, `String(12)` nullable | `finished`, `skipped` or `dismissed`; for the owner's curiosity and for tests. |
| Part-way state | not stored on the server | Held in memory only, so a closed app starts over (owner's rule). |
| `pc.tour.done.<userId>` | `localStorage` | Written with the server call; stops the tour repeating on this device while offline. Wrapped in try/catch. |

The client reads both through the user object it already loads (`useAuth().user`, as it does `avatar_id`), and writes with one small `PATCH` next to the existing profile calls. "Show the tour again" clears `tutorial_completed_at` and starts the tour.

New accounts: created with `tutorial_completed_at = null`. Existing accounts: the migration sets it to `null` as well, which is what makes the Home card appear; the card is the only prompt for them.

---

## 4. Shared pieces

### 4.1 Tokens the artboards use

All from `src/index.css` and `tailwind.config.js` on `nonprod`. No new tokens. Same table as `docs/SOCIAL_DESIGN.md` §4.1; the ones this milestone leans on:

| Use | Value |
|---|---|
| Page | `--color-bg` #000000 |
| Cards, list sections | `--color-card` #1C1C1E; list sections `rounded-xl` = 16 px |
| Fills | `--color-fill-tertiary` rgba(118,118,128,0.24) for gray buttons and chips; `--color-fill` rgba(120,120,128,0.36) for the grabber |
| Text | primary #FFFFFF; secondary rgba(235,235,245,0.6); muted #8E8E93; tertiary rgba(235,235,245,0.3) (chevrons only) |
| Accent | fill #E3000B, text and icons #FF4D4D (`--color-tint`), on-accent #FFFFFF |
| Semantic | green #30D158, red #FF453A, yellow #FFD60A, orange #FF9F0A, blue #0A84FF |
| Glass | `.glass`: rgba(28,28,30,0.72), `blur(24px) saturate(180%)`, 0.5 px rgba(255,255,255,0.12) border; nav bar buttons use `--glass-solid` rgba(44,44,46,0.92) |
| Type | Title 3 20/25 (display font), Headline 17/22 semibold, Body 17/22, Callout 16/21, Subheadline 15/20, Footnote 13/18, Caption 1 12/16, Caption 2 11/13 |
| Buttons | `Button`: `md` min 44 px, `lg` min 50 px, full radius; `filled` bg accent, text on-accent; `gray` bg `--color-fill-tertiary`, text white; `plain` text tint |
| Alert | `Alert`: 270 px wide, `.glass`, 14 px radius, buttons stacked when long |
| Sheet | `PageSheet`: `.glass`, 16 px top corners, up to 92 dvh, 5 × 36 grabber, 44 px header, trailing "Done" |
| Shell | nav bar 44 px under `--safe-top` (47 px on a 390 × 844 iPhone); tab bar 64 px capsule, 12 px from the sides, bottom 24 px above the edge; `main` bottom padding 114 px; page sides 16 px |
| Layers | nav bar 30, tab bar 40, sheet 50, menu 55, **tour 56**, scanner 58, update banner 60/70 |

Contrast pairs used (WCAG 2.x, measured):
- white on the accent fill 4.9;
- tint on the card 5.2;
- secondary text on the card 6.0, on black 8.4;
- white on the `water` gradient, lighter end #236BB4: 6.0;
- black on the yellow count badge 14.9;
- green #30D158 on the card 8.4.

Pairs that **fail** and are avoided: tint or muted text on a gray fill inside a card (3.9); white on any type solid (2.4–4.1); white on the red count badge (3.4).

### 4.2 Existing components reused

`Button`, `Alert`, `PageSheet`, `ListSection`, `ListRow`, `Badge`, `PokeBall`, `BadgeMedal`, Home's `TodoCard`, the tab bar and nav bar as drawn by the shell, `InstallHint`, `NotificationsCard` and `pwa/push.js`, and Settings' `SettingsRow` / `SettingsCard`.

### 4.3 New components

All in `frontend/src/welcome/`.

| Component | Props | Notes |
|---|---|---|
| `TourHost` | none | Mounted once in `App.jsx` under the router. Decides whether to show the tour or the card, and owns the step machine. |
| `tourSteps()` | `({ social, standalone, ios }) → step[]` | Pure; builds the list in §3.2 so the counts are tested. |
| `TourSpotlight` | `{ targetSelector, shape, onNext, onBack, onSkip }` | The ring and scrim. Finds the target by `data-tour="today"`, `"challenge"`, `"tab-collection"`, `"scan"`, `"tab-search"`, `"tab-profile"`. Re-measures on resize, on orientation change and when fonts load. |
| `CoachCard` | `{ step, index, total, children }` | The glass card, counter, dots, title, body, buttons. |
| `CenterCard` | `{ children }` | The welcome, Home Screen, offline and end cards. |
| `TakeTourCard` | none | The Home card (§3.7). |
| `WhatsNewHost` | none | Mounted next to `TourHost`; opens the sheet (§5.2). |
| `WhatsNewSheet` | `{ isOpen, onClose, releases }` | `PageSheet` with a list of release blocks. |
| `ReleaseBlock` | `{ release, level: 'highlights' \| 'details' }` | Shared by the sheet and the history. |
| `VersionHistory` | none | Route `/settings/about/versions` (§5.3) and the detail route `/settings/about/versions/:id`. |
| `releases()` | none | Reads `releases.json`; pure helpers `newerThan(seenId)`, `current()`. |

---

## 5. What's new and the version history (P16)

### 5.1 Release names (E-names)

- A **major** release (a milestone or big feature drop) takes the next starter: Bulbasaur, Charmander, Squirtle; then Chikorita, Cyndaquil, Totodile; Treecko, Torchic, Mudkip… in Pokédex order. After the last starter, naming continues from Caterpie.
- A **smaller** release before the next major takes one of that major's **evolutions**: Bulbasaur → Ivysaur → Venusaur. After the final form, the name gains the date: "Venusaur · 4 Nov".
- The **date sits under every name** in the history. A release spanning days shows "18–19 Oct 2026".
- A release's `name` and `date` are written in the file by hand. Nothing is computed.

| Release | Name | Dates | Kind |
|---|---|---|---|
| Home Screen app and offline | **Bulbasaur** | 18–19 Oct | major |
| The iPhone redesign | **Charmander** | 20–23 Oct | major |
| Badges, the daily loop and binder pockets | **Squirtle** | 29 Oct | major |
| Wrapped and goals | **Chikorita** | 30 Oct | major |
| Milestone D (social) | **Cyndaquil** | draft, "Coming next" | major |

Between Chikorita and Cyndaquil, a small fix release would be **Bayleef**, then **Meganium**, then "Meganium · 4 Nov".

### 5.2 The What's new sheet

- **When:** on the first open after the app has updated (the update button, or iOS updating on its own), once the trainer is signed in and no tour is open. If a tour is showing, the sheet waits until it ends.
- **What:** a `PageSheet` titled **What's new**, with **Done** at the right and no Cancel. It opens at most 92 dvh and scrolls.
- **One missed release:** the release name (Title 2, display font), the date under it (Footnote, secondary), then up to three highlights as rows: a 40 px circular icon in a type tint, the title (Headline) and one sentence (Footnote, secondary). A footer link **See everything** opens the history.
- **Several missed releases:** one block per release, **newest first**, each with name, date and up to three highlights, separated by hairlines. Blocks are never collapsed. The footer link is the same, and the sheet scrolls. If more than five are missed, the oldest are folded into one line, "…and 3 earlier releases", that opens the history.
- **Footer:** a single `Button` gray `lg` full-width, **See everything**. The header's **Done** closes.
- **Dismissing:** Done, swipe down or the backdrop all count as seen. Opening the history from the sheet also counts.
- **New accounts** get nothing: `whats_new_seen` is set to the running release when the account is created.
- **No admin notes:** admin-only changes never appear.

### 5.3 Version history

- **Entry:** Settings › About gets two rows above the version row: **Version history** (chevron, opens the list) and, on devices where the tour applies, **Show the tour again**. The existing `v1.51.6` row stays as the upstream version.
- **List:** a `ListSection` per release, newest first. Each row: the name (Headline), the date (Footnote, secondary) under it, a one-line summary (Subheadline, secondary), a chevron. The release the trainer is on carries a small gray "You have this" chip (`Badge`, neutral). On nonprod the top of the list is the **Coming next** block (§5.4).
- **Detail page** (pushed, compact title "Version history"): the name as a large title, the date under it, the summary, then groups with a footnote header each:
  - **New**: things that did not exist before;
  - **Better**: changes to things that did;
  - **Fixed**: problems that are gone;
  - **Under the hood**: a short list in smaller type (Footnote, secondary) for the curious, 5 items at most, no PR numbers.
  Any group with nothing in it is left out.
- **Offline:** both pages read from the bundled file and need no network.

### 5.4 Coming next (nonprod only)

`releases.json` has an optional `next` object: the draft of the release being tested, in the same shape without `id` or `date`. Nonprod builds show it as the first block of the version history, under a yellow "Coming next" chip (black on #FFD60A, 14.9) with the line "Draft — not released yet." It is not part of What's new, and the deploy build leaves `next` out (the production build strips it, and a test checks that).

### 5.5 Data

**The release file** is `frontend/src/welcome/releases.json`, newest first, shipped with the app (precached by the service worker, so it works offline).

```json
{
  "next": { "name": "Cyndaquil", "summary": "…", "highlights": [], "details": { "new": [], "better": [], "fixed": [] }, "underTheHood": [] },
  "releases": [
    {
      "id": "2026-10-30",
      "name": "Chikorita",
      "nameDate": false,
      "from": "2026-10-30",
      "date": "2026-10-30",
      "kind": "major",
      "summary": "One line for the history list.",
      "highlights": [
        { "icon": "target", "title": "Chase goals", "text": "One friendly sentence." }
      ],
      "details": { "new": ["…"], "better": ["…"], "fixed": ["…"] },
      "underTheHood": ["…"]
    }
  ]
}
```

- `id` is the date, `YYYY-MM-DD`, with `.2`, `.3` if two releases share a day. It sorts as text.
- `highlights` has at most three entries; `icon` is a lucide name from a short allow-list.
- A test checks: ids unique and descending; dates descending; ≤ 3 highlights; no `#123`, no `PR`, no backticks; every `icon` allowed.
- **Promotion procedure** gains a step: add the release entry before merging into `deploy`.

**The build stamp.** `vite.config.js` reads the file and defines `__RELEASE_ID__` as the first entry's `id`, next to `__APP_VERSION__`. `VERSION` stays upstream's. The value is also written into the service worker's build id, so an update always changes it.

**Per account.**

| Field | Where | Notes |
|---|---|---|
| `whats_new_seen` | users table, `String(16)` nullable | The last release id the trainer has seen. `null` is treated as "set it now, show nothing". |
| `pc.whatsNew.seen.<userId>` | `localStorage` | Offline copy. The newer of the two (by position in the file) wins. |

Rules:
- On start, signed in: if `whats_new_seen` is `null`, set it to `__RELEASE_ID__` and show nothing.
- If it names a release newer than this build (a device not yet updated), show nothing.
- Otherwise the sheet lists every release newer than `whats_new_seen`, up to the running one.
- On dismissal, write the running id. Offline, the write goes through the outbox when it is on and is retried at the next sign-in otherwise.
- A trainer last on a very old build sees everything since, back to the first release.

---

## 6. Accessibility

- **VoiceOver.** The tour is a modal `role="dialog"` with `aria-labelledby` on the title and `aria-describedby` on the body. Focus moves to the card at each step; the live announcement is "Step 3 of 8. Everything you own." The app behind is `inert`, so VoiceOver can't wander off. The card says what the ring points at ("the Collection tab at the bottom of the screen"), because the ring itself is decoration. Dots and the ring are `aria-hidden`. The What's new sheet is a `PageSheet` dialog and its release blocks are headings (`h3`) with the date inside the heading text.
- **Reduce Motion.** With `prefers-reduced-motion: reduce` the scrim doesn't fade, the card doesn't slide, the ring doesn't pulse and steps change instantly. Without it the ring does one 250 ms ease-out (`--ease-ios`) move between targets.
- **44 pt.** Every button, link, tab and chip is at least 44 × 44. The Skip button is a 44 × 44 target with text only.
- **Safe areas.** The card keeps `max(16px, var(--safe-top))` from the top, `var(--safe-bottom)` plus the 88 px the tab bar takes from the bottom (unless centered), and 16 px from the sides. The sheet uses `PageSheet`'s own handling.
- **Text size.** The card scrolls inside itself if Dynamic Type makes it taller than the screen; the buttons stay pinned to its bottom.
- **Contrast.** 4.5:1 for all text (§4.1). Colour never carries meaning alone: the step counter is text, the declined state has words.
- **Keyboard** (iPad with a keyboard): Tab order Skip, Back, Next; Escape opens the Skip alert.

## 7. Offline behaviour

| Thing | Offline |
|---|---|
| The tour (copy, steps, spotlight) | Fully works: all strings are bundled. |
| Completing, skipping, dismissing | Written to `localStorage` at once and sent to the server through the outbox (or at next sign-in). The tour won't repeat on this device meanwhile. |
| Notification ask | Needs the push service; the button is hidden offline with "Connect to turn on notifications." |
| What's new sheet | Works from the bundled file and the local seen id. |
| Version history | Works from the bundled file. |
| Two devices offline | Each may show the tour once; the server keeps the earliest completion. |

---

## 8. Draft release notes (for the owner to approve)

Written from the merge history of `origin/deploy` since `8f5acbf` (23 deploy merges, 18–30 October 2026, grouped by the owner's named releases). Highlights are the first block of each; the details follow. Admin-only changes are left out. PR numbers and code names are left out.

### Bulbasaur — 18–19 Oct 2026 · "PokéCollector on your Home Screen"

**Highlights**
- **Add it to your Home Screen.** PokéCollector now opens full screen like any other app.
- **Works without a signal.** Browse your collection even when you're offline, and scan cards anywhere: the photo waits on your phone and is sent when you're back.
- **Price alerts on your phone.** Get a notification when a card on your wishlist changes price.

**Everything**
- *New:* Add PokéCollector to your Home Screen. A Sync & offline page shows what's saved and what is waiting to send. An offline banner tells you when you have no connection. Pages you've opened before work offline. Scan photos taken offline are kept and uploaded later. Price alerts arrive as notifications on your phone. You stay signed in while offline. Settings and exchange rates are kept for offline use. When a new version is ready, a bar at the top lets you update, with an "Updating…" screen while it installs.
- *Better:* Offline features are on for everyone. If a large card picture isn't saved, the small one shows instead.
- *Fixed:* The app no longer hangs at start-up when your connection is poor. The offline banner now sits below the iPhone's status bar and shows up reliably.
- *Under the hood:* A service worker keeps the app and your data on the phone. Updates wait for you to tap Update. Offline scans are queued in a local outbox.

### Charmander — 20–23 Oct 2026 · "The iPhone redesign"

**Highlights**
- **A new look made for iPhone.** A tab bar at the bottom, big titles and sheets that slide up like the apps you already know.
- **Scan starts with the camera.** Open Scan and you're ready to take the photo.
- **Your whole card list offline.** Download the card database and pictures, and Search and Sets work without a signal.

**Everything**
- *New:* A new Home, Collection, Search, Sets, Pokédex, Analytics and Settings. A launch screen with your Pokémon of the day (you can skip it). Pull down to refresh on any page. Browse Sets by language, then series. Search finds cards by name, set and number in any order and corrects typos. A Scan inbox to review what you've scanned. Download the card database and card pictures for offline use. Choose which languages to sync and see the progress.
- *Better:* The Profile page opens faster. Prices fit on the tiles. Every page opens offline. The app launches faster when pictures are saved on your phone. Offline settings are clearer, with a true storage breakdown.
- *Fixed:* Settings no longer crashes on the Account page. Pull to refresh no longer spins forever. Japanese sets show their own cards. Back from a large set no longer freezes. Series logos stay after a sync.
- *Under the hood:* Scanner settings can be set for the whole server. Faster automated tests.

### Squirtle — 29 Oct 2026 · "Badges, the daily loop and binder pockets"

**Highlights**
- **A reason to open the app every day.** The Today card shows your Pokémon of the day, your streak, daily quests, XP and your trainer level, plus a game of Who's That Pokémon.
- **Badges to earn.** Unlock gym-style badges as your collection grows, with a moment of celebration each time.
- **Binders that match the real thing.** Drag cards into pockets just like a physical binder, and flip through sets and binders in Book view.

**Everything**
- *New:* The Today card, with a streak you can protect with a freeze. Daily quests, XP and a trainer level. Who's That Pokémon. Achievements and gym-badge tracks. Book view for sets and binders. Binder pockets with drag and drop (press and hold to pick a card up). Holo cards shine and tilt with your phone, with their own foil patterns. Notifications by category and a number on the app icon. Detailed notifications that name the cards, prices and badges. On this day. Showcase 6 on the leaderboard, and each trainer's streak. Collection DNA. Share your daily progress as a picture.
- *Better:* Tap the most expensive print on the Today card to open it. Prints on offer match your sync languages. Foil is smoother on iPhone and matches in the zoom.
- *Fixed:* Restoring an older backup into a newer app works. Background restore, CSV pocket sizes and the "scans ready" notification are fixed.
- *Under the hood:* Your history (cards, streaks, quests) is recorded from now on. Badge and notification checks run every 30 seconds.

### Chikorita — 30 Oct 2026 · "Wrapped and goals"

**Highlights**
- **Chase goals.** Pick a set, a generation, an evolution family or an artist, and watch the ring fill as you collect.
- **Your weekly recap.** On Sunday evening Home shows how your week went.
- **2026 Wrapped is coming.** Your year as a story arrives in December.

**Everything**
- *New:* Goals, with a Goals tile on your Profile. Family goals count every card in an evolution family. A weekly recap card on Home from Sunday evening. The 2026 Wrapped story is ready for December, with pictures you can share.
- *Better:* Your goals show on Home next to your sets.
- *Under the hood:* Weekly recap data is stored for Wrapped.

---

## 9. Mockups (the canvas row)

Row **"Wave 4 — Welcome and what's new"**, 390 × 844 unless noted, in the real shell:

1. Welcome
2. Skip confirmation
3. Home Screen step (browser)
4. Are you sure? (1)
5. Really carry on? (2)
6. Step 1 Today
7. Step 2 Weekly challenge (social on)
8. Step 3 Collection
9. Step 4 Scan, Home Screen app (the ask)
10. Step 4 Scan, notifications declined
11. Step 4 Scan, browser variant
12. Step 5 Search
13. Step 6 Profile (social on)
14. Step 7 Swapping (social on)
15. Step 6 Profile, social off ("5 of 6")
16. Step 8 Offline
17. End
18. Home with the "Take the tour" card
19. What's new, one release
20. What's new, several releases
21. Settings › About
22. Version history, list
23. Release detail
24. Version history on nonprod with "Coming next"
25. Release names (1180 × 520): how the starters and evolutions run

## 10. Risks

- **Spotlight position drift.** Rotation, Dynamic Type and late font loads move targets. `TourSpotlight` re-measures on resize, orientation change and `document.fonts.ready`, and falls back to a centred card if the target is missing (a tab hidden by a feature flag), so the tour never blocks.
- **Z-order.** The update banner (60/70) must stay above the tour. A test asserts the order of the z-index variables.
- **Two layers.** The tour and What's new never show together: What's new waits for the tour.
- **Release file discipline.** The only guard is the test in §5.5 plus the promotion step. A forgotten entry means the sheet says nothing, which is safe.
