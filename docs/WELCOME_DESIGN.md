# Welcome and What's new — design for PokéCollector

Status: build started 3 November 2026 at the owner's request (P15, P16). Mockups: the Design canvas, row **"Wave 4 — Welcome and what's new"** (https://claude.ai/artifact/QNJ3UNo7XYj1ze96mkcFGF). The owner's review of the mockups (a6) and the release notes (a7) is still open; any changes from it are folded into this doc and the build.

What this builds on:
- The plan of record is `docs/ENGAGEMENT_DESIGN.md` §7 milestone E, including both "Owner's answers" blocks (2 November 2026), which override its bullets.
- Both phases are for every trainer in multi-user mode. The tour is not shown in single-user mode. Social steps appear only while `useSocialEnabled()` (`frontend/src/social/social.js`) is true.

**How to build from this doc.** The artboards use the app's real tokens, type styles, radii and components (§4). An implementation ports them literally: the same component, the same class, the same number. Where an artboard and this doc disagree, ask; don't average them.

---

## 0. Owner's answers (3 November 2026)

The owner reviewed the first version of the mockups. The answers below are built into this doc and the canvas.

| # | Question | Answer |
|---|---|---|
| — | **Shape of the tour** | **Hands-on.** The trainer taps the real controls and goes into the real menus; each hint points at one specific control with everything else dimmed, and says what it is and where it is. Taps outside the highlighted control do nothing (apart from Skip). A sequence of artboards per section (§3). |
| E1 | Should Skip ask first? | **Yes, once.** |
| E2 | Where does the Home Screen step sit? | **Right after the welcome.** |
| E3 | Do the weekly challenge and swapping get their own steps (social on)? | **Yes.** |
| E4 | Past releases | **Four entries** (§8). |
| E5 | Wrapped | **Left out of Chikorita's highlights** (and of its details). A separate change sends a "Your Wrapped is ready" push on 1 December. |
| E6 | Squirtle's three highlights | **OK as drafted.** |
| E7 | Other browsers | **Yes**: an Install step where the browser supports it. |
| E8 | Dismissing the Take the tour card | **A quiet "Not now" link.** |

The release notes in §8 are still drafts: the owner has not yet commented on their content.

---

## 1. What good apps do

Principles only; no branded artwork is copied.

### 1.1 Onboarding and coach marks

| Source | What works | Take for us |
|---|---|---|
| [Apple HIG — Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding) | Keep any onboarding "fast, fun, and optional"; teach by letting people use the app; put a permission request where its reason is clear. | Under a minute, always skippable; the notification ask lives in the Scan step, next to the reason. |
| [Apple HIG — Offering help](https://developer.apple.com/design/human-interface-guidelines/offering-help) | Help that people can find again later, not only once. | "Show the tour again" in Settings › About. |
| Appcues and NN/g write-ups (general, not linked) | A spotlight on the real control beats a screenshot; one idea per step; show progress; skippable. Front-loaded tutorials are rarely remembered; contextual hints work better. | Hints point at the real tab or tile with the rest dimmed, one idea per step, a five-part progress bar, and a Skip on every step. |
| Common platform guidance (not linked) | Ask for permissions in context and let people carry on if they say no. | Declining notifications leaves a plain sentence and a pointer to Settings; the tour carries on. |

### 1.2 What's new

| Source | What works | Take for us |
|---|---|---|
| [Carbon Design System — Show what's new](https://preview.carbondesignsystem.com/building-experiences/onboard/tutorials/show-whats-new-to-maintain-user-engagement) (principles) | Show it once per version, let people revisit it, give a next step. | Once per account per update, "See everything" links to the history, and the history stays in Settings. |
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

1. **Quiet and short.** About a minute, one idea per hint, a sentence or two each.
2. **Do the real thing.** The trainer taps the real tab, tile or button, and the next hint points at what is on the real screen they land on.
3. **Honest about the browser.** A trainer in Safari is told plainly what they miss, twice asked, and then left free.
4. **Done means done.** The tour is marked complete only when it is fully finished or skipped; anything else starts over.
5. **Friendly words.** Highlights have no technical terms, no PR numbers and no code names.
6. **Works offline.** The tour, the sheet and the history all ship inside the app.

---

## 3. The tour (P15)

The tour is **hands-on**. The trainer does the real thing: taps the real tab, the app navigates for real, and the next hint points at the specific control on the new screen, with everything else dimmed. Nothing is a picture of the app, and a hint never just talks over a dimmed bottom bar.

### 3.1 When it shows

| Case | Behaviour |
|---|---|
| New account, multi-user mode | Starts by itself on the first Home visit after sign-in. |
| Existing account | A **Take the tour** card on Home (§3.9). Starting it or dismissing it counts as done. |
| Single-user mode | No tour, no card, no Settings row. |
| Tour finished or skipped | Never shows again by itself; **Settings › About › Show the tour again** replays it. |
| Tour left part-way (app closed, or left to add the Home Screen app) | Starts again from the welcome next time, on any device, until finished. |
| Finished in the browser | Counts. The Home Screen app won't show it again. |

Only reaching the end screen, or a confirmed Skip, writes `tutorial_completed_at`.

### 3.2 How a step works

Every step is one of two kinds, shown in the mockups:

- **Tap** — the dimmed screen has one hole, around the real control, with a red tap badge on its corner. The hint card says what the control is and ends with "Tap {control}" instead of a button. The real tap goes through to the app (it opens the real screen); the tour sees it and moves to the next step. Any tap outside the hole does nothing, except **Skip**.
- **Info** — the hole shows a control or area without a tap (for a risky control like the shutter, or an area like the Today card). The hint card has a **Next** button. Taps in the hole are swallowed, so the shutter never takes a photo.

The hint card carries: the section name, a five-segment progress bar (Home · Collection · Scan · Search · Profile), the title (Title 3), the body (Callout, secondary), and either a tap line or **Next**. **Skip** sits at the top right (44 × 44). There is no Back button: the trainer's own navigation is the way through.

### 3.3 The steps

Social **on** is shown; social-off differences are in the last column. Numbers are the artboard numbers on the canvas.

| Section | # | Screen | Hole (target) | Kind | Title and body | Social off / empty |
|---|---|---|---|---|---|---|
| Home | 006 | Home | `today` (top of the Today card) | info | **Your day starts here** — The Today card shows your Pokémon of the day, your streak and three daily quests. Finish them to earn XP. | same |
| Home | 007 | Home | `challenge-row` | tap | **A challenge for everyone** — Each week sets one goal for every trainer on this server. Tap the challenge to see how everyone is doing. | left out |
| Home | 008 | Challenge board | `challenge-hero` | info | **Finish it for a badge** — Your progress is here. Everyone who finishes earns a badge, and the quickest finishers make the podium. | left out |
| Collection | 009 | Home / board | `tab-collection` | tap | **Everything you own** — Cards, binders and your wishlist live under Collection. | same |
| Collection | 010 | Collection | `collection-segments` | tap | **Cards, Card Lists, Wishlist** — Cards is every card you own. Card Lists holds your binders and decks. Wishlist is what you want next. Tap **Card Lists**. | same |
| Collection | 011 | Card Lists | `first-binder` | tap | **Binders and decks** — Each binder keeps cards in order, like the real thing. Open one to see inside. | no binder: 012 |
| Collection | 012 | Card Lists, empty | `new-list` (+) | info | **Make your first binder here** — Tap + any time to start a binder or a deck. We'll move on to Scan. | only when empty |
| Collection | 013 | Binder | `view-switch` | tap | **Grid or Book** — Grid shows your cards in rows. Book shows pockets, like a real binder — you can even drag cards between them. Tap **Book**. | skipped after 012 |
| Scan | 014 | any | `tab-scan` | tap | **Scan your cards** — The red-and-white button opens the camera. Point it at a card and PokéCollector finds it. | same |
| Scan | 015 | Scanner | `shutter` | info | **This is the shutter** — Fit one card in the frame and tap it. You can take several photos in a row and send them together. | same |
| Scan | 016–018 | Scanner | `scan-queue` | tap | **Scans take a little while** — Recognising a card can take a minute, so you can leave and come back. Tap the queue to see your scans. Plus the notifications ask (§3.7). | same |
| Scan | 019 | Scan queue | `queue-list` | info | **Photos wait here** — Each photo shows as recognising, then ready to review. Review a scan to add it to your collection. Even offline, photos wait here and are recognised once you're back online. | empty queue: the page header |
| Search | 020 | any | `tab-search` | tap | **Find any card or set** — Search is where you look things up, in sets or the Pokédex. | same |
| Search | 021 | Search | `search-field` | info | **Type it any way you like** — Name, set and number in any order — "umbreon 161" works. Small typos get corrected for you. | same |
| Search | 022 | Search | `browse-sets` | tap | **Browse by set** — Sets lists every set by language and series, with how many cards you own. The Pokédex beside it shows which Pokémon you've caught. | same |
| Search | 023 | Sets | `sets-language` | info | **Language first** — Pick a language, then a series, then a set. Each set shows a checklist of the cards you own. | same |
| Profile | 024 | any | `tab-profile` | tap | **Your trainer page** — Everything about you lives under Profile. | same |
| Profile | 025 | Profile | `tile-trades` | tap | **Swap cards with friends** — Trades is where you compare collections and offer swaps. The number shows offers waiting for you. | 026: **Trade cards in person** — Trades helps you work out a fair swap when you meet another collector. |
| Profile | 027 | Trades | `trades-offers` | info | **Swap offers live here** — Offers waiting for you show up in Offers. Nothing moves until you both tap Swapped after you meet. | 028: **Live trade and History** — Live trade compares two collections. History keeps the trades you've done. |
| Profile | 029 | Trades | `back` | tap | **Back to your page** — The Back button always takes you one step back. | same |
| Profile | 030 | Profile | `tile-goals` | tap | **Chase goals** — Goals follow a set, a generation, an evolution family or an artist. Badges and the leaderboard sit beside it. | same |
| Profile | 031 | Goals | `first-goal` | info | **Watch the ring fill** — Each goal shows how far you are and what's left. Tap + to start another. | no goal: 032 |
| Profile | 032 | Goals, empty | `new-goal` (+) | info | **Start your first goal** — Tap + when you're ready. We'll finish with how PokéCollector works offline. | only when empty |
| Profile | 033 | Profile | `row-offline` | tap | **Works without a signal** — Your collection, binders and card pages are saved on this phone. Sync & offline shows what's saved. | skipped when offline features are off |
| Profile | 034 | Sync & offline | `offline-card` | info, **Finish** | **Everything stays with you** — Browse your collection, binders and card pages from the saved copy. Scan anywhere: the photo waits on your phone and is recognised once you're back online. Changes wait their turn and are sent when you're back online. Fresh prices and other trainers need a connection. | same |

The welcome (001), the Skip alert (002), the Home Screen step with its two alerts (003–005) and the end screen (§3.8) are centre cards, not holes. The tour does not open the leaderboard; its tile is seen next to Goals in step 030.

### 3.4 Finding targets: `data-tour` hooks

The hint layer never guesses from text or layout. It finds a target by a stable attribute:

```html
<button data-tour="shutter" …>
```

- **Hooks live in the real components**, one attribute each, no styling: `today` (Today card wrapper), `challenge-row`, `challenge-hero`, `tab-collection`, `tab-scan`, `tab-search`, `tab-profile` (TabBar and SidebarNav links, so it works on iPad and desktop), `collection-segments`, `first-binder`, `new-list`, `view-switch` (BookViewSwitch), `shutter`, `scan-queue` (the scanner's inbox button), `queue-list`, `search-field`, `browse-sets`, `sets-language`, `tile-trades`, `tile-goals`, `trades-offers`, `back` (the NavBar's back button), `first-goal`, `new-goal`, `row-offline`, `offline-card`. A unit test lists every id the tour uses and checks it exists in the source, so a refactor can't silently drop one.
- **A step names its route and its hook.** The step table is data (`tourSteps()`), for example `{ id: 'binder-view', route: /^\/binders\/\d+$/, target: 'view-switch', kind: 'tap' }`.
- **Waiting for a screen.** After a tap the route changes. `TourSpotlight` waits for the hook with a `MutationObserver` for up to 1.5 s (the page may be a lazy chunk); the screen stays dimmed and the hint hidden until then.
- **Measuring.** The hole is the target's `getBoundingClientRect()` plus 6 px padding, re-measured on resize, orientation change, `document.fonts.ready`, scroll end and each animation frame while the page is sliding in (the shell's slide transition). If the target is off screen, the page is scrolled until it is centred, with the scrim up so nothing is tappable meanwhile.
- **Blocking.** The scrim is four fixed panels around the hole with `pointer-events: auto`, so the real control gets the real tap. For an info step a fifth transparent panel covers the hole too.
- **Detecting the tap.** A capture-phase `click` listener on the target advances the tour after the app has handled the tap, so the app's navigation always runs.
- **Layers.** The tour layer is `z-index: 59`: above the scanner (58) so it can sit on the camera, below the update banner (60/70).

### 3.5 If the trainer leaves the path

- **They went somewhere else** (edge-swipe back, a deep link, a push opening the app): if the route matches neither the step's route nor the next step's route, the tour calls `navigate(step.route, { replace: true })` once to bring them back. If that route can't be resolved (a binder deleted), it skips to the next section's first step.
- **They left the app** (switch, lock): the tour state is in memory only. A backgrounded app resumes where it was; a closed app starts over (owner's rule).
- **Orientation, Dynamic Type, keyboard:** the layer re-measures and the card scrolls inside itself.
- **Update ready mid-tour:** the update banner (z 60) sits above the tour; Update is a normal tap. After the update, the tour starts over.

### 3.6 Empty and missing screens

A new account has no binders, no goals and an empty scan queue. The tour never needs data to exist:

| Step | If there is nothing to point at |
|---|---|
| 011 first binder | Replaced by 012: the **+** button, info, "Make your first binder here"; step 013 (Book) is skipped. |
| 013 view switch | Skipped if there is no binder to open. |
| 019 queue list | Points at the page header; the body is the same. |
| 031 first goal | Replaced by 032: the **+** button. |
| 033 Sync & offline | Skipped when the offline features are off (`readPwaFlags()`); the offline body moves to the end card. |
| Any hook missing after 1.5 s (a flag hid it, a layout changed) | The step is skipped and logged to the console. The tour never blocks. |
| The scan-queue step in the browser, or where push is unsupported | No ask button (§3.7). |

### 3.7 Skip, the Home Screen push and notifications

**Skip.** On the welcome and on every step, **Skip** opens an `Alert` (the existing component), once (owner's answer E1):
- Title: **Skip the tour?**
- Message: You can replay it any time from Settings › About › Show the tour again.
- Buttons: **Keep going** (preferred) · **Skip** (plain).
- Confirming writes `tutorial_completed_at` with outcome `skipped`.

**Home Screen push (iPhone Safari, not the Home Screen app).** The step comes right after the welcome (E2):
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
- After "Yes, carry on" the tour continues; the scan-queue step shows the browser variant.

**Other browsers (E7, yes).** When the browser has offered an install (`beforeinstallprompt` was captured), the step reads **Install PokéCollector** with one **Install** button that calls the saved prompt; the two confirmations are the same. If the browser offers nothing, the step is left out.

**Notifications ask (scan-queue step, 016–018).**
- In the Home Screen app: a paragraph "Want a nudge when scans are ready?" and a tinted **Turn on notifications** button that runs `enablePush()` (`pwa/push.js`) and asks iOS. Tapping the queue button is still the way on.
- States: *Declined* — "No problem. You can turn them on later in Settings › Notifications." *On* — "Notifications are on." *Unsupported or offline* — the button is left out.
- In the browser: no button; "Notifications need the Home Screen app. Add it later and turn them on in Settings › Notifications."

### 3.8 The end

Centre card with a Poké Ball, the title "You're ready", the sentence "That's the tour. Replay it any time from Settings › About.", then two buttons: **Scan your first card** (filled, `lg`) opens the scanner; **Explore on my own** (plain) closes the tour. Both mark the tour done. The last info step's **Finish** goes to this card.

### 3.9 "Take the tour" card on Home

For existing accounts that have not finished or skipped.
- It is Home's existing `TodoCard` (`pages/HomeScreen.jsx`): type `water` (gradient #236BB4 → #123F8C, white text, 5.5:1 at the lighter end), 64 px minimum, 18 px radius, an icon in a black/20 circle (`Compass`), title **Take the tour**, detail **A one-minute look around PokéCollector**, action pill **Start**.
- It sits at the top of the to-do cards, above the Today card.
- Under it a quiet **Not now** link (E8): a 44 px-high text button in the secondary text colour. It counts as done and the card never returns.
- Starting the tour from it behaves as a new account's tour.

### 3.10 Data

| Field | Where | Notes |
|---|---|---|
| `tutorial_completed_at` | users table, `DateTime` nullable | Set when the tour is finished, skipped or the card is dismissed. |
| `tutorial_outcome` | users table, `String(12)` nullable | `finished`, `skipped` or `dismissed`; for tests and the owner's curiosity. |
| Part-way state | not stored on the server | Held in memory only, so a closed app starts over (owner's rule). |
| `pc.tour.done.<userId>` | `localStorage` | Written with the server call; stops the tour repeating on this device while offline. Wrapped in try/catch. |

The client reads both through the user object it already loads (`useAuth().user`, as it does `avatar_id`), and writes with one small `PATCH` next to the existing profile calls. "Show the tour again" clears `tutorial_completed_at` and starts the tour.

New accounts are created with `tutorial_completed_at = null`. Existing accounts get `null` from the migration as well, which is what makes the Home card appear.

**Side effects of a hands-on tour.** The trainer's real taps do real things, so the tour keeps them harmless: it never taps for them, the shutter is blocked (an info step), the scanner opens without staging anything, and opening Book view only changes the saved view preference, which the trainer can flip back in the same place. It never creates, edits or deletes data.

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
| Layers | nav bar 30, tab bar 40, sheet 50, menu 55, scanner 58, **tour 59**, update banner 60/70 |

Contrast pairs used (WCAG 2.x, measured):
- white on the accent fill 4.9;
- tint on the card 5.2;
- secondary text on the card 6.0, on black 6.4;
- white on the `water` gradient, lighter end #236BB4: 5.5;
- black on the yellow count badge 14.9;
- green #30D158 on the card 8.4.

Pairs that **fail** and are avoided: tint or muted text on a gray fill inside a card (3.9); white on any type solid (2.4–4.1); white on the red count badge (3.4).

### 4.2 Existing components reused

`Button`, `Alert`, `PageSheet`, `ListSection`, `ListRow`, `Badge`, `PokeBall`, `BadgeMedal`, Home's `TodoCard`, the tab bar and nav bar as drawn by the shell, `InstallHint`, `NotificationsCard` and `pwa/push.js`, and Settings' `SettingsRow` / `SettingsCard`.

### 4.3 New components

All in `frontend/src/welcome/`.

| Component | Props | Notes |
|---|---|---|
| `TourHost` | none | Mounted once in `App.jsx` under the router. Decides whether to show the tour or the card, owns the step machine and the route guard (§3.5). |
| `tourSteps()` | `({ social, standalone, ios, flags, empty }) → step[]` | Pure; builds the step list of §3.3 (route, hook, kind, copy keys, fallbacks) so the counts and the social/empty variants are tested. |
| `TourSpotlight` | `{ step, onTap, onNext, onSkip }` | Finds the hook (§3.4), measures it, draws the four-panel scrim, the ring and the tap badge. |
| `GuideCard` | `{ section, title, body, kind, extra }` | The glass hint card: section name, five-segment progress, title, body, tap line or Next, Skip. |
| `CenterCard` | `{ children }` | The welcome, Home Screen and end cards. |
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
| Goals and the weekly recap | **Chikorita** | 30 Oct | major |
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

- **VoiceOver.** The hint card is a modal `role="dialog"` with `aria-labelledby` on the title and `aria-describedby` on the body. Focus moves to the card at each step and the live announcement reads the section, the title and the instruction ("Collection. Everything you own. Tap the Collection tab, at the bottom of the screen."). The app behind is `inert` **except the highlighted control**, so a VoiceOver user can double-tap the very control the hint names and nothing else; on an info step the whole app is inert and Next is the way on. The card names where the control is, because the ring is decoration. The progress bar and the ring are `aria-hidden`; the progress is also in the card as text ("Collection, step 2 of 5"). The What's new sheet is a `PageSheet` dialog and its release blocks are headings (`h3`) with the date inside the heading text.
- **Reduce Motion.** With `prefers-reduced-motion: reduce` the scrim doesn't fade, the card doesn't slide, the ring doesn't pulse and steps change instantly. Without it the ring does one 250 ms ease-out (`--ease-ios`) move between targets.
- **44 pt.** Every button, link, tab and chip is at least 44 × 44. The Skip button is a 44 × 44 target with text only.
- **Safe areas.** The card keeps `max(16px, var(--safe-top))` from the top, `var(--safe-bottom)` plus the 88 px the tab bar takes from the bottom (unless centered), and 16 px from the sides. The sheet uses `PageSheet`'s own handling.
- **Text size.** The card scrolls inside itself if Dynamic Type makes it taller than the screen; the buttons stay pinned to its bottom.
- **Contrast.** 4.5:1 for all text (§4.1). Colour never carries meaning alone: the step counter is text, the declined state has words.
- **Keyboard** (iPad with a keyboard): Tab order Skip, Back, Next; Escape opens the Skip alert.

## 7. Offline behaviour

| Thing | Offline |
|---|---|
| The tour (copy, steps, spotlight) | Fully works: all strings are bundled, and every page the tour visits opens offline. |
| Completing, skipping, dismissing | Written to `localStorage` at once and sent to the server through the outbox (or at next sign-in). The tour won't repeat on this device meanwhile. |
| Notification ask | Needs the push service; the button is hidden offline with "Connect to turn on notifications." |
| What's new sheet | Works from the bundled file and the local seen id. |
| Version history | Works from the bundled file. |
| Two devices offline | Each may show the tour once; the server keeps the earliest completion. |

---

## 8. Draft release notes (for the owner to approve)

Written from the merge history of `origin/deploy` since `8f5acbf` (23 deploy merges, 18–30 October 2026, grouped into the owner's four named releases). Highlights are the first block of each; the details follow. Admin-only changes are left out. PR numbers and code names are left out.

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

### Chikorita — 30 Oct 2026 · "Goals and the weekly recap"

**Highlights**
- **Chase goals.** Pick a set, a generation, an evolution family or an artist, and watch the ring fill as you collect.
- **Your weekly recap.** On Sunday evening Home shows how your week went.
- **Goals at a glance.** A Goals tile on your Profile, and your goals next to your sets on Home.

**Everything**
- *New:* Goals, with a Goals tile on your Profile. Family goals count every card in an evolution family. A weekly recap card on Home from Sunday evening.
- *Better:* Your goals show on Home next to your sets.
- *Under the hood:* Your weekly numbers are now kept so they can be looked back on.

(The 2026 Wrapped story is on `deploy` but hidden until December, so it is left out of these notes; a separate push on 1 December announces it.)

---

## 9. Mockups (the canvas row)

Row **"Wave 4 — Welcome and what's new"**, 390 × 844 unless noted, in the real shell. The tour is drawn as a sequence per section, each step on the real screen with the one hole lit (tap steps carry the red tap badge):

- **Begin:** 001 Welcome · 002 Skip confirmation · 003 Home Screen step (browser) · 004 "Are you sure?" · 005 "Really carry on?"
- **Home:** 006 Today card · 007 tap the weekly challenge (social on) · 008 the challenge board (social on)
- **Collection:** 009 tap Collection · 010 the three segments, tap Card Lists · 011 tap a binder · 012 empty Card Lists (+) · 013 Grid | Book, tap Book
- **Scan:** 014 tap Scan · 015 the shutter · 016 the scan queue with the notifications ask · 017 notifications declined · 018 browser variant · 019 the scan queue page
- **Search:** 020 tap Search · 021 the search field · 022 tap Sets · 023 Sets by language
- **Profile:** 024 tap Profile · 025 tap Trades (social on) · 026 tap Trades (social off) · 027 Offers segment (social on) · 028 Trades with social off · 029 tap Back · 030 tap Goals · 031 a goal · 032 empty Goals (+) · 033 tap Sync & offline · 034 Sync & offline (Finish)
- **After:** End · Home with the "Take the tour" card
- **What's new:** What's new with one release · with three missed releases · Settings › About · Version history list · Release detail · Nonprod "Coming next"
- **Names** (1180 × 520): how the starters and evolutions run

The Home Screen, Skip and "are you sure?" screens are centre cards over the dimmed Home. Social-off differences are the two Trades artboards (026, 028); the social-on Home and board steps (007, 008, 027) are simply absent.

---

## 10. Risks

- **Targets that move or vanish.** Hooks are stable ids with a test (§3.4); the hole is re-measured on resize, font load, scroll end and during page slides; a missing hook after 1.5 s skips that step instead of blocking.
- **Z-order.** The update banner (60/70) must stay above the tour. A test asserts the order of the z-index values (tour 59, scanner 58, banner 60).
- **Two layers.** The tour and What's new never show together: What's new waits for the tour.
- **Release file discipline.** The only guard is the test in §5.5 plus the promotion step. A forgotten entry means the sheet says nothing, which is safe.
