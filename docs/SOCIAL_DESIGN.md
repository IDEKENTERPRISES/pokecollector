# Social (milestone D) — design for PokéCollector

Status: design for owner approval (2026-10-30). Mockups: the Design canvas, rows **"Wave 3 — Social"** (https://claude.ai/artifact/QNJ3UNo7XYj1ze96mkcFGF). The UI phases (P11b, P12b) and P13 start only after the owner approves them.

What this builds on:
- The plan of record is `docs/ENGAGEMENT_DESIGN.md` §7 milestone D, with owner positions 1 (the icon number counts only things to act on) and 5 (the weekly challenge rewards everyone who finishes, with a podium for bragging).
- Everything sits behind the admin switch (#112): the setting `social_features_enabled`, `require_social` on the backend, and `useSocialEnabled()` in `frontend/src/social/social.js`. With it off, trainers see nothing of this (§9).

The backend this UI is aligned with:
- **P12a feed**: #113, merged. `/api/feed`.
- **P11a swaps**: #114, merged. `/api/swaps`.

§5.9 and §6.6 give their contracts as built and list the few additions the screens need.

**How to build from this doc.** The artboards use the app's real tokens, type styles, radii and components (§4). An implementation ports them literally: the same component, the same class, the same number. Where an artboard and this doc disagree, ask; don't average them.

---

## 0. Decisions for the owner

Each has a recommendation, which the mockups show. "As built" means what #113 and #114 already do.

| # | Question | Recommended | Alternative |
|---|---|---|---|
| D1 | Where do swap offers live? | An **Offers** segment on Trades (Live trade · Offers · History), with a count on the Profile Trades tile and on the segment. Finished swaps also land in History as ordinary trades (each trade has `swap_offer_id`). | A separate "Swap offers" page with its own Profile tile. |
| D2 | Home to-do card "2 swap offers waiting"? | **Yes**, the same pattern as "3 scans need review". It shows only while an offer waits for your answer. | No Home card; the icon number and the Profile tile only. |
| D3 | Where does the weekly challenge show? | **Both**: a row in Home's Today card (under the daily quests) and the full board as a **Challenge** segment on Leaderboard. | Leaderboard only. |
| D4 | Who makes the podium? | The **first three to finish**. Spending more can't buy a place. | The highest count by Sunday night. |
| D5 | Reaction artwork. The four ids are fixed by P12a: `cheer`, `wow`, `fire`, `heart`. | `PartyPopper` "Cheer", `Sparkles` "Wow", `Flame` "Fire", `Heart` "Love it". As built, each trainer can give each one once. | Other glyphs; the ids stay. |
| D6 | Your own events | As built, the feed leaves them out and never says who reacted. **Recommended:** a small P12a follow-up adds your own shared events, marked "You", with their reaction **counts** (still never who), so you see that people reacted. | Keep as built: other trainers only. |
| D7 | Push wording | As built (#114), detailed pushes give counts: "Brock offered 1 card for 1 of yours". **Recommended:** name the cards, "Brock offered Charizard ex for your Greninja ex", with counts once a side has more than two. Never amounts: cash is "+ cash". | Keep the counts. |
| D8 | Push when an offer is declined or cancelled? | As built: no push. **Recommended:** push "Dawn declined your swap offer", without touching the icon number, so nobody waits 14 days for an answer that came. | Keep as built; the Offers list shows it. |
| D9 | The note on an offer (as built: optional, 140 characters, replaced by each counter) | **Show it**: one line in the composer, quoted on the offer ("Can bring it on Saturday"). It isn't a thread, so it stays inside the "no chat" non-goal. | Hide the field; the API allows `null`. |
| D10 | The challenge week | Monday 00:00 to Sunday 23:59 in the **server's** time zone: one deadline for everyone, shown in local time. | Each trainer's own time zone (unfair for a shared podium). |

---

## 1. What other products do

### 1.1 Trade and swap offers

| Product | What works | Take for us |
|---|---|---|
| **Steam trade offers** ([Steam Support](https://help.steampowered.com/en/faqs/view/1115-91C5-050C-1D60), [developer note on expiry](https://dev.doctormckay.com/topic/484-trade-offer-expire-time)) | Both inventories side by side in the composer. "Send counter offer" sends back a **new** offer. Offers expire after two weeks, with the date at the bottom. If an item is traded away or sold, the offer goes **inactive** and can't be accepted. | A counter is a new revision and the 14-day clock restarts (as built). Completion re-checks every card, and a swap whose card is gone says which card, instead of failing silently. |
| **Pokémon TCG Pocket** ([VGC guide](https://www.videogameschronicle.com/guide/pokemon-tcg-pocket-trading-how-to-get-trade-tokens/), [Nintendo Life](https://www.nintendolife.com/guides/pokemon-tcg-pocket-trading-explained-how-to-swap-cards)) | Trades only between friends. Fairness is a hard rule (same rarity, plus trade tokens). A failed trade gives the cards back. | Our trainers are friends, so fairness is a **hint**, not a rule: the meter. Nothing moves until both confirm, and a failed completion changes neither collection (as built: one transaction). |
| **Pokémon GO trading** ([Bulbapedia](https://bulbapedia.bulbagarden.net/wiki/Trade_(GO))) | Trades happen in person, between friends, after both see what's on offer and confirm. | Our swaps also happen in person. The app records the agreement; both tap **Swapped** after the meet-up, and only then do the cards move. |
| **Yahoo Fantasy trades** ([help](https://help.yahoo.com/kb/SLN6125.html)) | The recipient can "Evaluate trade" before accepting, rejecting or making a counter-offer. The proposer can cancel until it's accepted. A cap on pending offers, and a response window. | Accept · Counter · Decline for the trainer whose turn it is; Cancel for the trainer who started the offer. The meter is our "Evaluate". |
| **eBay Best Offer** ([developer guide](https://developer.ebay.com/api-docs/user-guides/static/trading-user-guide/best-offers-counter.html)) | Each counteroffer has its own expiry, and a new counteroffer declines the earlier ones. | One live revision at a time; a counter replaces the cards on the table. |
| **Panini sticker swaps** ([Panini blog](https://blog.paniniamerica.net/fifa-world-cup-sticker-swaps-a-collaborative-approach-to-completing-your-collection/), [Scanini on trade matching](https://scanini.app/trade-matching)) | The swap tool suggests only duplicates; your first copy of a sticker is never offered. | As built, you can only ask for another trainer's **spare** copies: they always keep one, and copies in binders aren't spare. Compare's suggestions use the same rule. |

### 1.2 Activity feeds and one-tap reactions

| Product | What works | Take for us |
|---|---|---|
| **Strava kudos** ([What is Kudos?](https://support.strava.com/en-us/articles/15402054-what-is-kudos)) | A thumbs-up from the feed, for activities, badges and challenge milestones. The icon turns orange once given; tap the count to see who gave it. | One tap, and your reaction is tinted in the accent. Unlike Strava, our counts stay anonymous (as built). |
| **GitHub reactions** ([GitHub blog, 2016](https://github.blog/2016-03-10-add-reactions-to-pull-requests-issues-and-comments/), [study of 2.5M issues](https://arxiv.org/pdf/1910.00188.pdf)) | A small, fixed set chosen to "reduce the noise in these threads". People can give several kinds. The study found reactions cut emoji-only comments. | Four fixed kinds, each once per trainer (as built), and **no comments**: nothing to moderate, nothing to answer. |
| **Duolingo friend updates** ([Duolingo blog](https://blog.duolingo.com/friends-social-features/), [Android Authority](https://androidauthority.com/duolingo-random-strangers-cluttering-social-feeds-3694884/)) | A "Celebrate" reaction on friends' milestones. Users complain when strangers' updates bury their friends'. | Our feed only ever shows the 5–7 trainers on this server. |
| **Apple Fitness sharing** ([Apple Support](https://support.apple.com/guide/iphone/share-your-activity-iph0b826155d/ios)) | Per friend: "Hide My Activity", or remove the friend. | Per kind: what you share is a switch, and switching a kind off hides what you shared before (as built). |
| **Strava privacy** ([Android Central](https://androidcentral.com/apps-software/how-to-control-your-privacy-settings-strava)) | An audience per activity; "Only You" keeps it off feeds and leaderboards. | Values are their own opt-in, off by default (as built). Leaving the challenge board is a switch. |

### 1.3 Weekly challenges, boards and podiums

| Product | What works | Take for us |
|---|---|---|
| **Strava challenges** ([support](https://support.strava.com/en-us/articles/15401916-strava-challenges), [trophy case](https://support.strava.com/en-us/articles/15402068-the-strava-trophy-case)) | Everyone who completes gets a badge in the trophy case; some challenges have a leaderboard. | A **finisher badge for everyone**; the podium is extra. |
| **Duolingo leagues** ([Deconstructor of Fun teardown](https://duolingo.deconstructoroffun.com/mechanics/leagues)) | A weekly reset, a top-3 podium with a reward, and a Monday results screen. Demotion and "you're out of the top 5" notifications make it stressful. | A weekly cycle with a Monday result, but **no demotion and no pressure pushes** (in the spirit of owner position 7). |
| **Duolingo Friends Quests** ([Duolingo blog](https://blog.duolingo.com/friends-quests/)) | A shared weekly goal with a friend, five days to finish, a reward chest. | One shared goal for the whole server each week, built like a quest. |
| **Apple Watch competitions** ([Apple Support](https://support.apple.com/guide/watch/apd68a69f5c7), [iDrop News critique](https://www.idropnews.com/news/apple-watch-activity-competitions-are-rigged-but-apple-can-fix-it/125310)) | Seven days, up to 600 points a day, a winner award. Critics note the scoring favours low goals. | The **same target for everyone**, and the podium goes by finishing order. |
| **Pokémon GO Global Challenges** ([pokemongo.com](https://pokemongo.com/en/news/strength-in-numbers-global-challenge-2025)) | Everyone's actions add up to one total that unlocks a bonus for all. | Kept as a later idea ("the server sorts 100 cards this week"). The first version is individual progress on a shared goal. |

Apple's guidance on the icon badge ([HIG, Notifications](https://developer.apple.com/design/human-interface-guidelines/notifications)) is to badge only what people still have to deal with, which is owner position 1.

### 1.4 What carries across

1. **Two confirmations, then the move.** Steam, Pokémon GO and Pocket all show both sides before anything changes hands. Our version: agree in the app, swap in person, both tap Swapped.
2. **A counter is a new revision**, and the clock restarts. The other side must be able to see what changed.
3. **Things go stale; say why.** Expired, declined, cancelled and "this card is gone" each get a plain sentence and a next step.
4. **Fixed, tiny reaction sets beat comments** for a group this size.
5. **Everyone can finish.** A badge for finishing, and a podium that rewards being quick, not spending.
6. **No pressure loops**: no demotion, no "you're losing" pushes, no badge number for social chatter.

## 2. Principles

1. **Quiet by default.** Social is a layer on the collection, not a new home. Only swap offers waiting for your answer make a number (icon, Profile tile, segment, Home card). Reactions, the feed and the challenge never push and never badge (as built for reactions).
2. **The app records; trainers swap.** Cards move between collections only after both trainers tap Swapped. Cash is something they settle in person; the app records the amount and never moves money (the "money between trainers" non-goal).
3. **Fair, from both sides.** Each trainer sees the fair-trade meter from their own side, at their own price setting (as built: `values.you` and `values.partner`). The podium rewards finishing first; the badge rewards finishing at all.
4. **Private about money.** Hide-values masks every amount on these screens. The feed shows no amount unless its trainer opted in (as built). Pushes never carry amounts.
5. **Consent you can see.** The first visit to the feed says what you share and links to the switches. Turning a kind off hides your past events of that kind too.
6. **No chat.** Structured counters, one optional 140-character note per offer (D9), and one-tap reactions instead of comments.
7. **iOS first, Pokémon flavour.** List sections, page sheets, segmented controls and capsule buttons from `components/ios/`; type colours, Poké Balls, medals and the podium for the moments worth celebrating.
8. **Every state has a next step.** A swap that can't finish can be tried again or cancelled; ended offers can be sent again.

## 3. Navigation and entry points

### 3.1 Routes

New patterns go into `navigation/navConfig.js` `ROUTES` explicitly (never by prefix). With social off, each redirects to its parent (`/trades`, `/leaderboard`).

| Route | Section | Kind | Back | Compact title | Notes |
|---|---|---|---|---|---|
| `/trades` | profile | pushed (exists) | `/profile` | Trades | Segments **Live trade · Offers · History**; Offers only with social on |
| `/trades/offers` (new) | profile | pushed | `/profile` | Trades | The same page on the Offers segment; the target of the Home card |
| `/trades/offers/:offerId` (new) | profile | pushed | `/trades/offers` | Swap offer | Offer detail; the target of swap pushes |
| `/leaderboard` | profile | pushed (exists) | `/profile` | Leaderboard | Segments **Ranking · Activity · Challenge** with social on; none with it off |
| `/leaderboard/activity` (new) | profile | pushed | `/profile` | Leaderboard | The feed |
| `/leaderboard/challenge` (new) | profile | pushed | `/profile` | Leaderboard | The weekly challenge |

Segments switch routes with `navigate(path, { replace: true })`, as Collection does, so they don't pile up history. The composer is a `PageSheet`, not a route.

Trades opens on **Offers** when an offer waits for your answer, otherwise on Live trade (today's default). Leaderboard opens on Ranking.

### 3.2 Entry points

| Feature | Entry points |
|---|---|
| Start a swap | Compare (`/leaderboard/compare/:userId`): **Offer a swap** on each trade suggestion, and **New offer** in the suggestions header. Offers segment: **New offer** → an action sheet of trainers. Offer detail: **Counter**, **Send a new offer**, **Send again**. |
| Answer a swap | Push → offer detail. Home to-do card (D2) → Offers. Profile Trades tile (count) → Trades, which opens on Offers. The Offers segment label carries the count. The app icon number. |
| Activity feed | Profile › Leaderboard › **Activity**. |
| What you share | The feed's first-visit card and its "What you share" row; Settings › Account › **Activity sharing** (new row, social on only). Both open the same sheet. |
| Weekly challenge | Home Today card row (D3) → board. Profile › Leaderboard › **Challenge**. |
| Swap pushes | Settings › Notifications: a "Swap offers" switch (category `swap_offers`, instant, default on). As built, the category is left out of `UI_CATEGORIES` until P11b adds this row; it shows only with social on. |

If an active offer with that trainer already exists, starting a new one asks first. As built, the API doesn't limit offers per pair; this is a UI nudge, so the same card isn't offered twice by accident. It is an `Alert`: "You already have a swap with Misty", with **Open it** (preferred) and **New offer**.

### 3.3 The icon number

As built in #114:
- `AppBadgeSync` sets the icon to `appIconNumber(scans, swapsWaiting, socialOn)`;
- the server's swap pushes carry `notifications.icon_number` (scans needing review plus `swaps.waiting_count`);
- an offer counts while it is open (proposed or countered), it's **your turn**, and it hasn't expired.

An accepted swap waiting for the meet-up isn't counted, and neither is a partner's Swapped tap. Both are in the Offers list under "Accepted". The same `GET /api/swaps/waiting` count feeds the Profile tile, the segment label and the Home card.

## 4. Shared pieces

### 4.1 Tokens the artboards use

All from `src/index.css` and `tailwind.config.js` on `nonprod`. No new tokens.

| Use | Value |
|---|---|
| Page | `--color-bg` #000000 |
| Cards, list sections | `--color-card` #1C1C1E; list sections `rounded-xl` = **16 px** (`tailwind.config.js` sets `xl` to 1rem) |
| Fills | `--color-fill-tertiary` rgba(118,118,128,0.24) for gray buttons, tracks, chips; `--color-fill` rgba(120,120,128,0.36) for the grabber |
| Text | primary #FFFFFF; secondary rgba(235,235,245,0.6); muted #8E8E93 (not on fills); tertiary rgba(235,235,245,0.3) (chevrons and placeholders only) |
| Accent | fill #E3000B (`--color-accent`), text and icons #FF4D4D (`--color-tint`), on-accent #FFFFFF |
| Semantic | green #30D158, red #FF453A, yellow #FFD60A, orange #FF9F0A, blue #0A84FF |
| Glass | `.glass`: rgba(28,28,30,0.72) with `blur(24px) saturate(180%)`, 0.5 px rgba(255,255,255,0.12) border, `inset 0 1px 0 rgba(255,255,255,0.08), 0 8px 32px rgba(0,0,0,0.45)`; nav bar buttons use `--glass-solid` rgba(44,44,46,0.92) with no blur |
| Type | the §7.6 scale of `IOS_UI_DESIGN.md`: Title 2 22/28, Title 3 20/25, Headline 17/22 semibold, Body 17/22, Callout 16/21, Subheadline 15/20, Footnote 13/18, Caption 1 12/16, Caption 2 11/13, tile number 30/34; titles and numbers in the display (rounded) font |
| Energy types | `TYPE_COLOURS` tile gradients (`top` → `bottom`, 150°) with their tile text colour; solids only for icons, rings and glows (white text on a solid fails 4.5:1) |
| Podium | `PODIUM_TYPES` from `pages/socialParts.jsx`: 1 lightning (text #1D1600), 2 metal (white), 3 fighting (white), drawn with the tile gradients |
| Shell | nav bar 44 px under `--safe-top` (47 px on a 390 × 844 iPhone); tab bar 64 px capsule, 12 px from the sides, its bottom 24 px above the screen edge (`max(8px, var(--safe-bottom) - 10px)`); `main` bottom padding `--content-bottom` 114 px; page sides 16 px |

Contrast was checked for every pair the artboards use (WCAG 2.x):
- white on the accent fill 4.9;
- tint on the card 5.2, and on the accent-20 % chip 4.7;
- yellow, green and red text on the card 12.1 / 8.4 / 5.0;
- secondary text on the card 6.0.

Pairs that **fail** and are avoided:
- tint or muted text on a gray fill inside a card (3.9);
- red text on a red-15 % fill inside a card (4.2);
- blue text on a blue-20 % fill inside a card (3.7);
- white on any type solid (2.4–4.1);
- white on the red count badge (3.4), which is why every new count badge here is the yellow one (black on #FFD60A, 14.9).

### 4.2 Existing components reused

`ListSection`, `ListRow`, `SegmentedControl` (≤ 4 options, `size="md"` on pages), `PageSheet` (with `leading`, `trailing`, `footer`, `isDirty`), `ActionSheet`, `Alert`, `Button`, `IconButton`, `Badge` (tone `yellow` for counts), `HideValuesToggle`, `Switch`, `SearchField`, `HpBar`, `BadgeMedal`, `GoalRing`, `PokeBall`, `EnergyIcon`, `StatTile`, `TrainerAvatar` and `countLabel` (`pages/socialParts.jsx`; move them to `social/` when P11b starts), Home's `TodoCard`, `MoneyInput`, and `UnlockSheetHost` (the finisher badge needs no new sheet).

Two small changes to existing pieces:
- `BadgeMedal` gains an optional `glyph` prop, so the challenge badges (track `daily`) draw a trophy instead of the daily flame.
- `TradeHealthBar` in `pages/Trades.jsx` becomes `FairTradeMeter` (below). Its rules move to a pure `tradeVerdict()` that Trades and swaps share, with the same thresholds and strings, so Live trade gets the new look too.

### 4.3 New components

All in `frontend/src/social/` (`swaps/`, `feed/`, `challenge/`), each with a unit-tested pure helper where there is logic.

| Component | Props | Notes |
|---|---|---|
| `FairTradeMeter` | `{ gives, gets, missingPrices = 0, variant: 'full' \| 'compact' }` | §5.6. Fed by `values.you` on an offer, or by the composer's own sums. Masks amounts with `maskValue` |
| `tradeVerdict()` | `({ gives, gets, sharedCash, missingPrices }) → { key: 'empty' \| 'missing' \| 'gain' \| 'fair' \| 'close' \| 'lose', delta, deltaPct, position }` | Pure. Today's thresholds: ≥ +15 % gain, ≥ −5 % fair, ≥ −15 % close, else lose. `position` (0–1) places the marker |
| `SwapCardRow` | `{ item, setCode, hint: 'wishlist' \| null, onRemove }` | Composer only: one card in a list section. 40 × 56 art, name (Body), "MEW 170 · Holo" (Footnote, secondary), a fairy-pink "On your wishlist" line when it applies, the value (Body, secondary), and an `IconButton variant="gray" size="sm"` ✕. `setCode` comes from the cached sets list (`ptcgo_code` or `abbreviation`, by `set_id`) |
| `SwapSide` | `{ title, items, addLabel, onAdd, onRemove }` | Composer only: a `ListSection` of `SwapCardRow`s and an "Add …" row |
| `SwapSides` | `{ items, cash, partnerName, marks, unavailable, past }` | Offer detail: the two sides as two columns (§5.5) |
| `SwapHeader` | `{ me, partner, status, meta, note }` | Two avatars facing, the title, the status chip with the dates beside it, and the note |
| `SwapStatusChip` | `{ offer, variant: 'capsule' \| 'dot' }` | Capsule on the page background, a dot and text inside list rows (§5.3); the wording comes from `swapStatus(offer)` |
| `swapStatus()` | `(offer) → { tone, label }` | Pure (§5.1 table) |
| `SwapOfferRow` | `{ offer, to }` | A row of the Offers segment |
| `SwapComposerSheet` | `{ isOpen, onClose, partner, mode: 'new' \| 'counter' \| 'again', offer, initial }` | §5.4 |
| `SwapCardPicker` | `{ owner: 'me' \| 'partner', partner, picked, onChange }` | A step inside the composer sheet, not a second sheet |
| `SwappedStep` | `{ partner, youConfirmed, partnerConfirmed, onSwapped, busy }` | §5.5.4 |
| `SwapProblemCard` | `{ unavailable, viewerId, partnerName, onRetry, onCancel }` | §5.5.6, from a 409's `unavailable` |
| `FeedEventRow` | `{ item, onReact, onOpen }` | §6.2 |
| `ReactionBar` | `{ counts, mine, own, onToggle, disabled }` | §6.3 |
| `SharingSheet` | `{ isOpen, onClose }` | §6.4 |
| `FeedIntroCard` | `{ onChange, onDismiss }` | §6.5 |
| `ChallengeTodayRow` | `{ challenge }` | Inside the Today card (§7.3) |
| `ChallengeHero` | `{ challenge, me }` | §7.4 |
| `Podium` | `{ places: [{ place, user, finishedAt }], size: 'md' \| 'lg' }` | §7.5 |
| `ChallengeBoard` | `{ board, viewerId, target }` | §7.4 |
| `ChallengeResultCard` | `{ result }` | §7.6 |

Avatars in the artboards are drawn placeholders (the trainer's initial). At runtime `TrainerAvatar` shows the trainer's sprite. Card art is drawn placeholders in the type colours; at runtime it is the card image from the image proxy, as everywhere else.

## 5. P11 Swap offers

### 5.1 Lifecycle (as built in #114)

**States** (`state`): `proposed`, `countered`, `accepted`, `completed`, `declined`, `cancelled`, `expired`.
- Each counter bumps `revision` and hands the turn (`turn_user_id`) to the other trainer.
- The state flips between `proposed` and `countered` with each counter, so the UI reads "changed by the other trainer" from `revision > 1` and `your_turn`, never from the state's name.

| From | Action (in `actions`) | Who | Then | Push (as built) |
|---|---|---|---|---|
| — | Send | A | `proposed`, revision 1, B's turn | to B: offer |
| proposed / countered | `accept` (with `revision`) | the trainer whose turn it is | `accepted`; re-checks the cards first (409 `unavailable`) | to the other: accepted |
| proposed / countered | `counter` (new cards, cash, note, `revision`) | the trainer whose turn it is | revision + 1, the other's turn; expiry restarts | to the other: counter |
| proposed / countered | `decline` | the trainer whose turn it is | `declined` | none (D8) |
| proposed / countered | `cancel` | the trainer who **started** the offer, at any turn | `cancelled` | none (D8) |
| accepted | `confirm` ("Swapped") | each trainer once | the first tap waits for the other | to the other: swapped |
| accepted, second tap | completion | server | `completed`; or 409 `unavailable` with nothing saved, still `accepted` | to both: completed |
| accepted | `cancel` | either trainer | `cancelled` | none |
| proposed / countered / accepted | 14 days after the last change (send, counter, accept, a Swapped tap) | scheduler | `expired` | none |

**Rules as built:**
- **What you can ask for.** You can ask only for the other trainer's **spare** copies: they keep at least one, and copies their binders hold aren't spare. You can give any copy you own, up to its quantity. Custom cards can't be swapped.
- **Limits.** At most 40 copies on the table, 99 of one copy, and at least one card (no cash-only offers). Cash is one amount with a payer (`cash_payer_user_id`), up to 100,000.
- **Accept and decline** carry the `revision` the trainer looked at. If the other trainer changed it meanwhile: 409 "This offer changed. Reload it first", and the screen reloads.
- **Completion** re-checks each copy. It frees binder pockets and deck slots that hold a copy being swapped, and handles product-linked copies like Trades does. Then it logs one `Trade` per trainer (`partner_name`, notes "Swap offer #41", `swap_offer_id`), all in one transaction.
- **Cancelling a counter.** The trainer who made a counter can't withdraw it. It waits for an answer, or it expires.

**The status wording** (`swapStatus()`), the same in the list, the header chip and VoiceOver:

| Condition | Tone | Label |
|---|---|---|
| open, your turn, revision 1 | yellow | Your turn |
| open, your turn, revision > 1 | yellow | Your turn · Misty countered |
| open, their turn | gray | Waiting for Misty |
| accepted, you haven't tapped | green | Accepted · swap in person |
| accepted, you tapped, they haven't | gray | Waiting for Brock to tap Swapped |
| completed | green | Swapped |
| declined / cancelled / expired | gray | Declined / Cancelled / Expired |
| a 409 `unavailable` on screen | red | Can't finish yet |

### 5.2 Compare: where a swap starts

Artboard `S3SwapCompare`. The existing Compare page, scrolled to **Trade Suggestions**. The rest of the page doesn't change.
- The suggestions become rows divided by hairlines instead of gray tiles. On the gray tile, `CardIdentity`'s muted subtext reads at 3.9:1; on the card it is 5.2:1, and the new button stands out.
- Each suggestion keeps its `CardIdentity` and gets a full-width `Button variant="gray" size="md"` under it: an `ArrowLeftRight` icon in the tint and the label **Offer a swap**. It's a separate control from the card, which still opens the card sheet.
  - The suggestion "Misty has duplicate · Ash wants this card" opens the composer with that card on the **You get** side.
  - "Ash has duplicate · Misty wants this card" puts it on the **You give** side.
- The section header gets a plain tint **New offer** button (44 px) on the right, for an empty composer.
- No suggestions: the existing dashed empty box, plus the same **New offer** button.

Data: the existing `trade_suggestions`, and a copy to put on the table. Suggestions carry only `card_id`, so the composer needs the candidates call (§5.9, an addition).

### 5.3 The Offers segment

Artboard `S3SwapOffers`. `/trades/offers`.
- **Nav bar:** Back · "Trades" · trailing `HideValuesToggle` (new on Trades; Live trade has amounts too).
- **Subtitle** (Footnote, secondary), per segment. Live trade and History keep today's line; Offers says "Swap cards with the trainers on this server".
- **Segmented control** (`md`): Live trade · **Offers** · History. The Offers label carries a yellow `Badge` with `waiting_count`.
- **Sections** (`ListSection className="!mx-0"`, because `main` already pads 16 px, as ScanQueue does), each listed only when it has rows. They are built from `GET /api/swaps` (`incoming`, `outgoing`, `history`):
  1. "Your turn · 2": open offers with `your_turn`. The newest change first.
  2. "Accepted · swap in person": accepted offers, yours to tap first.
  3. "Waiting for others": open offers on the other trainer's turn.
  4. "Finished": `history`, the 50 most recent. Footer: "Completed swaps are also in History as trades."
- **`SwapOfferRow`** (a link, min 76 px, `px-4 py-3`, the hairline inset past the avatar):
  - `TrainerAvatar` 40;
  - the partner's name (Headline) with the age of `updated_at` right-aligned (Footnote, secondary: "2 h", "3 d");
  - one line of what moves (Footnote, secondary, truncated): "Charizard ex for your Greninja ex", with "+ cash" when there is cash, and no amounts;
  - the status (`swapStatus`) as a dot and text (Caption 1 semibold);
  - a mini pair of card thumbnails (28 × 39, theirs over yours), then the chevron.
- **New offer:** `Button variant="gray" size="lg" full` at the end. It opens an `ActionSheet` "Swap with…" listing the other active trainers.
- **Empty:** a Poké Ball (56), "No swap offers yet" (Title 3), "Compare your collection with a trainer to find cards to swap." (Subheadline, secondary), and `Button variant="gray"` "Open Leaderboard".
- **Loading:** three `skeleton` rows 76 px. **Error:** the page's usual red text card.
- **Offline:** the read-cached list, read only; New offer is disabled with "Needs a connection".

### 5.4 The composer

Artboard `S3SwapComposer` (with a hide-values tweak), and `S3SwapPicker` for the card picker step.

A `PageSheet` (92 dvh, glass, grabber), over Compare, the Offers segment or an offer:
- **Header:** leading "Cancel", title "Swap with Misty" ("Counter offer" when countering), no trailing button. `isDirty` asks "Discard changes?" before closing.
- **Body** (16 px padding top and bottom, sections 16 px apart):
  1. `SwapSide` **You give**:
     - a `SwapCardRow` per copy, with the ✕ labelled "Remove Mew ex";
     - "Add from your cards" (`ListRow`, green 29 px square with a plus, chevron) opens the picker on your cards.
  2. `SwapSide` **You get from Misty**, the same, with "Add from Misty's spares".
  3. **Matches**: the header "Misty is looking for these. You have spares", then one row of chips that scrolls sideways and bleeds to the sheet's edges.
     - Each chip is a 44 px capsule button on `#1C1C1E`: a tint plus (18 px) and "Pikachu · MEW 173" (Subheadline semibold). Tapping it adds the card to You give.
     - The row shows only when Misty's wishlist is visible to you (her public profile and `wishlist_visibility`, the rule Compare uses).
  4. **Cash and note** (`ListSection`):
     - "Cash" (`ListRow`, orange square with `Wallet`, value "None", "You pay £2.00" or "Misty pays £2.00", chevron) opens an inline editor: a `MoneyInput` and a `SegmentedControl size="sm"` **You pay** | **Misty pays**;
     - a note field (one line, 140 characters, placeholder "Note: where or when to meet", D9).
     - Footer: "Values use your price setting. Cash is settled between you; the app only records it."
- **Footer (sticky):** `FairTradeMeter variant="compact"`, then `Button size="lg" full` **Send offer**. It is disabled until at least one card is on the table.

**Cash** is one amount with a payer, as built (`cash_amount`, `cash_payer_user_id`). That is why there is one Cash row, not one per side.

**The picker step** replaces the sheet's body; there is no second sheet:
- **Header:** leading "‹ Back" (tint, back to the composer), title "Misty's spares" or "Your cards", trailing **Done**.
- A `SearchField` ("Search Misty's spares").
- `SegmentedControl` (`sm`). It opens on the first segment that has cards.
  - On the partner's side: **On your wishlist · 2** | **All spares · 31**. Only spares can be asked for.
  - On your side: **On Misty's wishlist** | **Spares** | **All**.
- **A 3-column grid** of card tiles (gap 10 px, art 5:7, radius 8):
  - name (Caption 1 semibold, one line), "MEW 170" (Caption 2, secondary) and the value (Caption 1, secondary, masked);
  - a fairy-pink heart on cards on the wanted wishlist;
  - "×2" when more than one copy can be offered.
- **Selected:** a 3 px tint ring and a 24 px accent check badge (top right). Each tap adds one copy, up to what can be offered; the badge then shows the count. The tile's label reads "Squirtle, MEW 170, £14.20, selected".

Sending: `POST /api/swaps`; the sheet closes, a toast "Offer sent to Misty", and the new offer opens. Offline: Send is disabled with "Needs a connection" under it. Swaps don't go through the outbox.

### 5.5 Offer detail

`/trades/offers/:offerId`. Nav bar: Back · "Swap offer" · trailing `HideValuesToggle`. `main` is a column with 8 px on top and 12 px between blocks:
1. `SwapHeader` (centred):
   - `TrainerAvatar` 48 (partner), a 36 px fill circle with `ArrowLeftRight` 18 in the tint, then your avatar 48, 12 px apart;
   - the title "Swap with Brock" (Title 3), 8 px under;
   - 8 px under, one wrapping line: the status chip (a 24 px capsule, Footnote semibold, 10 px sides), then the dates (Footnote, secondary): "Sent 2 h ago · Expires in 14 days";
   - the note, when there is one, 6 px under (Footnote, secondary): "Misty's note: Pikachu makes it fair for me." It belongs to the current revision. Revisions alternate strictly, so odd ones are by the trainer who started the offer and even ones by the other ("Your note: …").
2. The state's card when it has one: What changed, Swapped, the problem, the success or the ended card (below).
3. **`SwapSides`**: two columns, 12 px apart, each a `rounded-xl bg-card p-3` column with 10 px between its parts:
   - its title (Footnote, secondary): "You get from Brock" / "You give";
   - a mini row per card (min 56 px): 40 × 56 art, then the name (Subheadline semibold), "OBF 125 · Holo" (Caption 1, secondary) and the value (Footnote, secondary, tabular). It opens the card sheet;
   - the cash, in the paying trainer's column: an orange 29 px square with `Wallet`, "Cash" (Subheadline semibold) over the amount.
4. `FairTradeMeter variant="full"` with `values.you`, only while the offer is open. Once it is accepted the deal is settled, and the meter goes.
5. The state's actions (below), from the offer's `actions`.

There is no history list: the API keeps only the current revision.

Every state below has its own artboard.

#### 5.5.1 Your turn, a new offer — `S3SwapIncoming` (hide-values tweak)
- Chip: yellow "Your turn".
- Actions (`accept`, `counter`, `decline`):
  - **Accept** (`Button size="lg" full`, filled);
  - a row of two `Button variant="gray" size="md"`: **Counter** (opens the composer prefilled) and **Decline** (red text);
  - Decline asks first, in an `Alert` "Decline Brock's offer?" with Decline (destructive) and Cancel.
- If Accept answers 409 `unavailable`, the problem card of 5.5.6 replaces the actions, with "Decline" as the way out.

#### 5.5.2 Waiting for them — `S3SwapOutgoing`
- Chip: gray "Waiting for Dawn".
- Dates: "Sent 2 d ago · Expires in 12 days". Your note shows as "Your note: …".
- One `Button variant="gray" size="lg" full`: **Cancel offer** (red text), confirmed in an `Alert`. It shows only for the trainer who started the offer (`cancel` in `actions`).
- No reminder button, so nobody gets nagged.

#### 5.5.3 Your turn, after a counter — `S3SwapCountered`
- Chip: yellow "Your turn · Misty countered".
- The header's dates read "Changed 40 min ago · Expires in 14 days" (the clock restarted).
- A **What changed** card (`rounded-xl bg-card`, 12 px × 16 px padding) above the sides:
  - a 29 px square (accent at 20 %) with `ArrowLeftRight` in the tint;
  - "Misty changed the offer" (Headline);
  - one Footnote line (secondary) per change: "Added Pikachu · MEW 173 to what you give."
- The added cards carry an "Added" capsule (Caption 2 semibold, tint on accent at 20 %) after their value.
- This needs the previous revision's cards, which the API doesn't keep yet (§5.9, an addition). Without it, the card says "Misty changed the offer. Check both sides before you answer." and the rows carry no marks.
- Actions as in 5.5.1 (`accept`, `counter`, `decline`). The trainer who started the offer also has `cancel`; with Decline on screen, it isn't shown.

#### 5.5.4 Accepted, with Swapped — `S3SwapAccepted`
- Chip: green "Accepted · swap in person". Dates: "Accepted yesterday · Expires in 13 days".
- `SwappedStep` card, above the sides, because it's the next thing to do:
  - "Swap the cards, then tap Swapped" (Headline);
  - "When you both have, Charizard ex moves into your collection and Greninja ex into Brock's. Each of you gets the trade in History." (Subheadline, secondary);
  - two status lines: your avatar with "You · Not yet", and Brock's with a green check and "Brock · Swapped" (no time: the API gives `partner_confirmed`, not when);
  - **Swapped** (`Button size="lg" full`, filled).
- After your tap (`you_confirmed`) the button becomes a disabled "Waiting for Brock". There is no undo (as built); Cancel swap stays.
- Under the sides: **Cancel swap** (`Button variant="gray"`, red text), confirmed in an `Alert`. To change the cards, cancel and send a new offer; the API has no counter after acceptance.

#### 5.5.5 Completed — `S3SwapCompleted`
- Chip: green "Swapped". Dates: "Today at 18:52".
- A success card instead of the actions:
  - a 64 px green circle with a check;
  - "Swapped on 30 Oct" (`completed_at`, Title 3);
  - "The cards have moved and the trade is in History." (Subheadline, secondary).
- Two `ListRow`s:
  - "Charizard ex is in your collection" → `/collection?cardId=…`;
  - "Open the trade in History" → `/trades?trade=<trade_id>` (History segment).
- The sides, titled "You got from Brock" and "You gave".
- `Button variant="gray" size="lg"` **Offer another swap with Brock**.
- Motion: the check circle scales in once (0.6 → 1, 300 ms, `--ease-ios`). Under Reduce Motion it fades in.

#### 5.5.6 Can't finish yet — `S3SwapBlocked`
The second Swapped tap (or Accept) answered 409 with `unavailable`. Nothing changed, and the offer is still accepted.
- Chip: red "Can't finish yet" (red on red at 15 %, on the page background). Dates: "Misty tapped Swapped · Expires in 14 days".
- `SwapProblemCard` (`rounded-xl bg-card p-4`, a 29 px red square with `AlertTriangle`):
  - title "This swap can't finish yet";
  - one sentence per `unavailable` entry (`card_name`, `giver_user_id`, `needed`, `available`):
    - yours, gone: "Pikachu · MEW 173 is no longer in your collection.";
    - yours, short: "You have 1 Pikachu · MEW 173; the swap needs 2.";
    - theirs: "Squirtle · MEW 170 is no longer in Misty's collection.";
  - a hint: "Add the card back and try again, or cancel and send a new offer without it.";
  - **Try again** (`Button variant="gray"`, which taps Swapped again) and **Cancel swap** (plain, red).
- The failing row in the sides shows the same sentence in red under its name.
- Binder pockets and deck slots never block a swap: completion frees them.

As built, the problem is known only from the 409. On a reload the offer looks accepted again until someone taps Swapped. The addition in §5.9 puts `unavailable` on the offer itself, so both trainers see it before they tap.

#### 5.5.7 Declined, cancelled, expired — `S3SwapEnded` (state tweak)

| State | Chip (gray) | Sentence | Action |
|---|---|---|---|
| declined | "Declined" | "Dawn declined this offer on 31 Oct." | **Send a new offer** (opens the composer with the same cards) |
| cancelled | "Cancelled" | "You cancelled this offer on 31 Oct." or "Dawn cancelled this offer on 31 Oct." | **Send a new offer** |
| expired | "Expired" | "This offer ended on 11 Nov after 14 days without an answer." | **Send again** |

The sentence and the button sit in one `rounded-xl bg-card p-4` card (Body, then a full-width `Button variant="gray" size="md"`). The sides stay visible, read only, without the meter. If a card has gone meanwhile, its row says so, and Send again leaves it out. The dates come from `updated_at`. The arrow between the avatars turns secondary instead of the tint.

### 5.6 The fair-trade meter

`FairTradeMeter`, a restyle of today's `TradeHealthBar` (same rules, same strings: `trades.fairTrade`, `closeTrade`, `youGain`, `youLose`, `missingPrices`, `emptyTrade`). Trades › Live trade uses it too.

**Full** (`rounded-xl bg-card p-4`):
- **Row 1:**
  - a 29 px square in the verdict colour with `ArrowLeftRight` in white;
  - the verdict (Headline): "Fair trade";
  - under it, "You give £13.90 · You get £14.20" (Footnote, secondary);
  - on the right, the delta (Headline, tabular): "+£0.30", green when ≥ 0 and red when < 0.
- **The balance track** (12 px under row 1):
  - an 8 px `HpBar`-style track (`bg-black/45`, 0.5 px inner hairline);
  - the four zones faintly tinted at 35 %: red (you lose, < −15 %), yellow (close, −15 to −5 %), green (fair, −5 to +15 %), blue (you gain, > +15 %);
  - the delta percentage is clamped to ±30 % and mapped across the width;
  - a 16 px white marker with a 3 px ring in the verdict colour sits at the delta, kept inside the track at the ends.
- **The ends** (6 px under the track, Footnote, secondary, tabular): "You give £13.90" on the left and "You get £14.20" on the right. They name the two sides of the track and carry the totals.

**Compact** (the composer footer): the verdict and the delta (Headline) on one row, the track 8 px under, and the ends 8 px under that. No square.

The meter never shows a score out of 100.

**States:**
- Empty: "No trade yet", a gray track, no marker.
- Missing prices (`missing_prices > 0`): "Missing prices" (yellow square) and "Some cards have no price", no marker.
- Hide-values: the totals and the delta read "••••". The verdict, the zones and the marker stay, because they show no amount.

On an offer, the inputs are `values.you`: `gives`, `gets`, `delta` and `missing_prices`, at the viewer's own price field and today's prices (as built). So Brock can see "Close trade" where Ash sees "Fair trade". The label says whose side it is ("You give …").

### 5.7 Push texts

Category `swap_offers` (instant, default on; quiet hours apply). Each push carries `app_badge` (the icon number). A push for an offer that moved on while it waited is skipped (as built).

**As built (#114):**

| Kind | Title | Body, details on | Body, details off ("Show card names and prices") |
|---|---|---|---|
| offer | Swap offer | Brock offered 1 card for 1 of yours | You have a new swap offer |
| counter | Swap counter-offer | Misty countered with 1 card for 2 of yours | A swap offer was updated |
| accepted | Swap accepted | Dawn accepted your swap | Your swap offer was accepted |
| swapped | Confirm your swap | Brock tapped Swapped. Tap yours once you have the cards | Your swap partner tapped Swapped |
| completed (both) | Swap complete | Your swap with Brock is complete | Your swap is complete |

**Recommended changes:**
- **D7:** with details on, name the cards. Cards read "Name (SET 123)"; lists are fitted to 300 characters with "and N more"; never amounts, and cash is "+ cash". With details off, keep the texts above.
  - offer: "Brock offered Charizard ex (OBF 125) for your Greninja ex (TWM 106)";
  - counter: "Misty countered: Squirtle (MEW 170) for your Mew ex (MEW 151) and Pikachu (MEW 173)";
  - accepted: "Dawn accepted: Gardevoir ex (SVI 245) for your Magikarp (PAL 203) + cash. Meet up, then both tap Swapped.";
  - swapped: "Brock tapped Swapped. Tap yours once you have Charizard ex (OBF 125).";
  - completed: "Charizard ex (OBF 125) is in your collection.".
- **D8:** a declined push: title "Swap declined", body "Dawn declined your swap offer" (details off: "A swap offer was declined"), with no icon number change.
- **Navigation:** swap pushes should open `/trades/offers/<id>`. As built, the category navigates to `/`.

There are no pushes for expiry, reactions, the feed or the challenge. A finisher badge pushes through the existing "badges" category.

### 5.8 Profile tile, Home card, icon

- **Profile** (artboard `S3SwapProfile`): the Trades `StatTile` (grass) shows the waiting count as its value and "offers waiting" ("offer waiting" for 1) as its detail, like the Products tile. At 0 it keeps the `ArrowLeftRight` icon.
- **Home** (artboard `S3HomeTodo`, D2): a `TodoCard`:
  - type **dragon** (the trader badge track's colour, white text 5.3:1), icon `ArrowLeftRight`;
  - title "2 swap offers waiting" ("1 swap offer waiting");
  - detail "Accept, counter or decline";
  - action "Open" → `/trades/offers`.
  It sits after the scans card in `todoCards()` order.
- **Icon:** §3.3, as built.

### 5.9 Data (P11a, #114)

**As built.** These are already in `frontend/src/api/client.js`: `getSwaps`, `getSwapsWaiting`, `getSwap`, `createSwap`, `counterSwap`, `acceptSwap`, `declineSwap`, `cancelSwap`, `confirmSwapped`, plus `SWAPS_QUERY_KEY` and `SWAPS_WAITING_QUERY_KEY` in `social/social.js`.

| Call | Body | Answer |
|---|---|---|
| `GET /api/swaps` | — | `{ incoming, outgoing, history, waiting_count }`; `history` is the 50 most recent finished |
| `GET /api/swaps/waiting` | — | `{ count }` |
| `GET /api/swaps/{id}` | — | an offer |
| `POST /api/swaps` | `{ to_user_id, items: [{ collection_item_id, quantity }], cash_amount, cash_payer_user_id, note }` | an offer |
| `POST /api/swaps/{id}/counter` | the same without `to_user_id`, plus `revision` | an offer |
| `POST /api/swaps/{id}/accept`, `/decline` | `{ revision }` | an offer; 409 when stale; accept may give 409 `unavailable` |
| `POST /api/swaps/{id}/cancel` | — | an offer |
| `POST /api/swaps/{id}/confirm-swapped` | — | an offer; the second tap may give 409 with `unavailable: [{ item_id, card_id, card_name, giver_user_id, needed, available }]` |

The offer, from the viewer's side:

```jsonc
{
  "id": 41, "state": "countered", "revision": 2, "role": "proposer",       // proposer | recipient
  "from_user": { "id": 1, "username": "Ash", "avatar_id": 25 }, "to_user": { }, "partner": { },
  "turn_user_id": 1, "your_turn": true,
  "actions": ["accept", "decline", "counter", "cancel"],                    // what the viewer may do now
  "note": "Can bring it on Saturday",
  "cash": { "amount": 0, "payer_user_id": null },                           // EUR
  "items": [{ "id": 7, "giver_user_id": 1, "gives": true, "collection_item_id": 812,
              "card_id": "sv03.5-151", "card_name": "Mew ex", "set_id": "sv03.5", "card_number": "151",
              "variant": "Holo", "condition": "NM", "lang": "en", "quantity": 1,
              "value_per_card": 3.8, "images_small": "…" }],
  "values": { "you":     { "price_field": "price_trend", "gives": 13.9, "gets": 14.2, "delta": 0.3, "missing_prices": 0 },
              "partner": { } },
  "you_confirmed": false, "partner_confirmed": false,
  "expires_at": "…", "completed_at": null, "created_at": "…", "updated_at": "…",
  "trade_id": null                                                           // the viewer's own Trade once completed
}
```

**Additions the screens need** (small; for P11a follow-up or P11b):

| Addition | Why | Shape |
|---|---|---|
| `GET /api/swaps/candidates?partner_id=&side=give\|get&filter=wishlist\|spares\|all&q=` | The picker (§5.4) and Compare's "Offer a swap" need copies that `build_items` will accept, with their wishlist match | `[{ collection_item_id, card_id, card_name, set_id, card_number, variant, condition, lang, images_small, types, offerable, on_wishlist, spare, value }]`, plus a count per filter. `offerable` is the spare count on the partner's side and the quantity on yours. `on_wishlist` is only set when that wishlist is visible to the viewer (Compare's rule) |
| `changes` on an offer after a counter | "What changed" (§5.5.3) | `[{ "change": "added" \| "removed" \| "quantity" \| "cash" \| "note", "gives": true, "card_name", "set_id", "card_number", "from", "to" }]`, computed when the counter is saved |
| `unavailable` on accepted offers in `GET` | Both trainers see the problem before they tap (§5.5.6) | the 409's list, computed by `find_unavailable` |
| `images_small` is enough for rows; `types` on items | The card placeholders and glows use the card's type | `types` from the card |
| Push wording and navigation | D7, D8, §5.7 | as listed there |

### 5.10 Offline and errors

- The list and the details are read-cached, so they show offline, read only. `swaps` isn't on `READ_CACHE_DENY`: it holds only the viewer's own offers.
- Every action needs a connection. Its button is disabled with "Needs a connection" under it. Swaps don't use the outbox: an offer queued for later could go stale.
- If an action fails, a toast with the server's `detail`, and the offer reloads. A 409 `unavailable` shows the problem card instead of a toast.

## 6. P12 Activity feed

### 6.1 Leaderboard segments

Artboards `S3FeedRanking` (social on) and `S3LeaderboardOff` (social off, as today).
- With social on, a `SegmentedControl size="md"` is the first thing under the nav bar: **Ranking · Activity · Challenge**.
- Ranking is today's page: the header card, the sort, the rows.
- With social off there is no segmented control at all.

**A row fix that applies either way.** Today a row's header holds the rank, the avatar, the name, the level chip, the streak chip, the value and the chevron in one line. At 390 px, a trainer with a streak and a four-digit value overflows by about 30 px. P12b changes the header to:
- the rank and the avatar, as today;
- then a column: the name (Headline) with the value (Body semibold, yellow) on the right, and under them the level and streak chips (Caption 1 semibold, `px-1.5`);
- the chevron.

The role line goes; it said "user" or "admin". The artboards show the rows without their best-card and Showcase blocks, which don't change.

### 6.2 Event rows

Artboard `S3Feed` (with a hide-values tweak). `/leaderboard/activity`.

The newest first, `GET /api/feed` 20 at a time, loading more near the end with `before = next_before`. Day headers group the rows: "Today", "Yesterday", "Mon 26 Oct" (Footnote, secondary, `px-1`). The first header has **What you share** on its right (Footnote semibold, tint, 44 px tall), which opens the sheet of §6.4. Artboards `S3Feed` and `S3FeedMore` (scrolled).

**The row** (`FeedEventRow`, one per `items[]` entry): `rounded-xl bg-card`, padding 16 px 16 px 4 px.
- **Header:** `TrainerAvatar` 40 (`trainer.avatar_id`), then:
  - the sentence (Subheadline, the name semibold): "**Misty** completed a set";
  - the age of `occurred_at` (Caption 1, secondary): "2 h ago".
- **Body** (12 px under the header, indented 52 px to the text), from `display` by `kind`:

| `kind` | `display` (as built) | Body |
|---|---|---|
| `set_completed` | `{ set_key, set_name, lang, total }` | A set seal: a 48 px round stamp in `colourFor(set_key)`'s tile gradient with a white check. The set name (Headline), "191 of 191 · complete" (Footnote, secondary) and a full `HpBar`. Tapping opens the set (`set_key` without its `_lang` suffix) |
| `achievement_unlocked` | `{ achievement_id, name, name_key, tier, track, art }` | `BadgeMedal` 48 (holo) with `track` and `tier`, `t(name_key)` (Headline) and "Silver · Pokédex" (Footnote, secondary). Tapping opens that trainer's Achievements |
| `big_pull` | `{ card: { id, name, number, set_id, lang, rarity, images_small, images_large, … }, variant, set_name, amount? }` | The card art, 72 × 100 with radius 6. The name (Headline), "Prismatic Evolutions · 161" (Footnote, secondary) and, only when `amount` is present, the value (Footnote semibold, yellow; "••••" under hide-values). Tapping opens the card sheet |
| `goal_completed` | `{ goal_id, goal_kind, title }` | `GoalRing` 48 at 100 % (green), the title (Headline) and "Goal complete" |
| `challenge_finished` (P13 adds) | `{ week, challenge_id, title_key, place }` | A 48 px podium medal (the place's tile gradient and number) or a finisher medal, then "Finished first in the weekly challenge" or "Finished the weekly challenge" and the challenge title |

- **Reactions:** a `ReactionBar`, then 4 px.

**As built:**
- Only other active trainers' events, only the kinds they share now, and never backfilled unlocks.
- Badges about money (portfolio value) only when that trainer shares values.

**D6 (recommended):** your own shared events, marked "You", with their counts drawn as capsules that aren't buttons. You can't react to them (as built: 400).

### 6.3 Reactions

The four kinds of P12a (`reaction_kinds`), in this order. The ids are fixed; the app owns the artwork and labels (D5).

| `kind` | Glyph | VoiceOver |
|---|---|---|
| `cheer` | `PartyPopper` | "Cheer" |
| `wow` | `Sparkles` | "Wow" |
| `fire` | `Flame` | "Fire" |
| `heart` | `Heart` | "Love it" |

As built, a trainer can give each kind once per event: `PUT /api/feed/{event_id}/reactions/{kind}` adds it, `DELETE` removes it. Both answer `{ counts, mine }` for the event. Who reacted is never exposed.

`ReactionBar`:
- a row of four buttons, 44 px tall, each holding a 36 px capsule (`px-3`, gap 6 px): the 18 px glyph, then the count (Footnote semibold, tabular) when it's above 0;
- **not yours:** `bg-fill-tertiary`, the glyph in secondary and the count in white;
- **yours** (in `mine`): accent at 20 % (`bg-accent/20`), the glyph and count in the tint (4.7:1 on the card);
- each button is `aria-pressed`, with the label "Cheer, 2, you reacted";
- tapping is optimistic, and the answer's `{ counts, mine }` replaces the guess; a failure rolls back with a toast;
- offline the buttons are disabled.

Reactions never push and never make a number (as built: no notification is queued).

### 6.4 What you share

Artboard `S3FeedSharing`. A `PageSheet`, title "What you share", leading empty, trailing **Done**. Each switch saves at once with `updateSettings({ [key]: 'true' | 'false' })`: the per-user settings P12a added, defaults merged into `GET /api/settings`.

1. `ListSection` "Show in the activity feed", rows with a `Switch`:
   - **Sets you complete** (`feed_share_set_completed`, on);
   - **Badges you earn** (`feed_share_achievement_unlocked`, on);
   - **Big pulls** (`feed_share_big_pull`, off), subtitle "Cards worth £17.40 or more when you add them" (`formatPrice(BIG_PULL_EUR)`);
   - **Goals you complete** (`feed_share_goal_completed`, off);
   - **Weekly challenge results** (`feed_share_challenge_finished`, on; P13 adds the key).
2. `ListSection` "Amounts": **Show card values** (`feed_share_values`, off). Footer: "Off: trainers see the card, never what it's worth. Badges about your collection's value also need this."
3. `ListSection` "Weekly challenge": **Show me on the board** (`challenge_on_board`, on; P13). Footer: "Off: you still play and earn the badge; others don't see your progress."
4. Footer: "Only the trainers on this server see your activity. Switching a kind off hides what you shared before, too."

### 6.5 First visit, empty and offline

Artboard `S3FeedEmpty`.
- **First visit** (until dismissed; a per-user setting `feed_intro_seen`): `FeedIntroCard` (`rounded-xl bg-card p-4`):
  - an `Eye` in a 29 px blue square;
  - "You share completed sets and badges" (Headline);
  - "Trainers on this server see them here and can react. Values stay hidden." (Subheadline, secondary);
  - two buttons: **Change** (gray) opens the sheet; **OK** (tinted) dismisses.
- **Empty** (`items` is empty):
  - a `PokeBall` 56;
  - "Nothing here yet" (Title 3);
  - "When trainers complete sets, earn badges or pull big cards, it shows up here." (Subheadline, secondary);
  - `Button variant="gray"` **What you share**.
- **Offline:** the feed is never read-cached (as built: `feed` is on `READ_CACHE_DENY`, so nothing outlives a trainer hiding it). The segment shows the sleeping Poké Ball of `OfflineUnavailable` and "The activity feed needs a connection."

### 6.6 Data (P12a, #113, merged)

```jsonc
// GET /api/feed?before=<event id>&limit=20&price_field=<the viewer's>   (limit ≤ 50)
{
  "items": [{
    "id": 9001, "kind": "big_pull", "occurred_at": "…",
    "trainer": { "id": 2, "username": "Brock", "avatar_id": 74 },
    "display": { "card": { "id": "…", "name": "Umbreon ex", "number": "161", "set_id": "…", "lang": "en",
                           "rarity": "…", "images_small": "…", "images_large": "…" },
                 "variant": "Holo", "set_name": "Prismatic Evolutions", "amount": 182.4 },   // amount only if shared
    "reactions": { "counts": { "cheer": 1, "wow": 3, "fire": 0, "heart": 0 }, "mine": ["wow"] }
  }],
  "next_before": 8950,
  "reaction_kinds": ["cheer", "wow", "fire", "heart"]
}
```

**Additions the screens need:**
- D6: own events, with `"mine": true` on the item.
- P13: the `challenge_finished` kind in `FEED_KINDS`, default on.
- The `feed_intro_seen` setting (any per-user key outside the `feed_share_` prefix is stored as is).
- `display.set_code` on `set_completed` and big pulls would let the rows show "PRE 161" like the rest of the app. Until then they use the set name.

## 7. P13 Weekly challenge

### 7.1 Rules

- One goal a week for everyone, picked from a catalogue by a hash of the ISO week, never repeating the last four weeks.
- The week runs Monday 00:00 to Sunday 23:59 in the server's time zone (D10), shown in local time.
- Progress is counted by the progress evaluator with the quest engine's checks (`services/progress/quests.py`), turned into counts over the week window. It updates within one dirty cycle (about 30 seconds).
- **Everyone who reaches the target** earns the finisher XP (50, the same for all) and progress toward the badge family below.
- **The podium** is the first three to finish, by `finished_at` (D4). It's for bragging: no extra XP.
- Trainers can leave the board (`challenge_on_board` off): they still play and earn, but only they see their progress.

The catalogue, which the owner can trim. Each item is one quest-style check with a target:

| id | Title | Target | Counts |
|---|---|---|---|
| `binder_cards` | Sort 20 cards into binders | 20 | binder cards added this week |
| `add_cards` | Add 15 cards to your collection | 15 | collection rows added (not imports older than 2 days) |
| `wtp_days` | Play Who's That Pokémon on 5 days | 5 | days played |
| `wtp_wins` | Get 3 Who's That Pokémon right | 3 | correct answers |
| `quests` | Finish 12 daily quests | 12 | quests done |
| `streak_days` | Open the app on 6 days | 6 | days with a check-in |
| `types` | Add cards of 6 different types | 6 | distinct first types of the cards added |
| `closest_set` | Add 5 cards to your closest set | 5 | `missing_closest` hits |
| `wishlist_got` | Get 3 cards off your wishlist | 3 | wishlist cards added to the collection |
| `swap` | Finish a swap with a trainer | 1 | completed swaps (`trades.swap_offer_id`) |
| `scans` | Review 10 scanned cards | 10 | scan items resolved |

**Badges** (family `challenge`, track `daily`, the trophy glyph):
- **Weekly Challenger** (bronze): finish 1 challenge;
- **Challenge Regular** (silver): finish 5;
- **Challenge Legend** (gold): finish 20.

They unlock through the existing evaluator and `UnlockSheetHost` (artboard `S3ChallengeBadge`) and push through the "badges" category.

### 7.2 Where it shows (D3)

- Home's Today card: a row (§7.3), only while "Show streaks and quests" is on.
- Leaderboard › Challenge: the board (§7.4), with the result on Monday and Tuesday (§7.6).
- The feed: `challenge_finished` events (§6.2).

### 7.3 Today card row

Artboard `S3HomeChallenge`. In `progress/TodayCard.jsx`, after the daily quests and before Who's That Pokémon. It uses the same section style as the quests: `border-t-[0.5px] border-border px-4 py-3`.
- **Header line:** "Weekly challenge" (Subheadline semibold) and, on the right, "2 days left" (Footnote, secondary, tabular).
- **A link row** (min 44 px, gap 12 px) to `/leaderboard/challenge`:
  - a 40 px circle in the challenge's type tile gradient with a white `Trophy` 22;
  - the title (Body) with "14 of 20" under it (Footnote, secondary);
  - the chevron.
- **Progress:** `HpBar` value 14, max 20, 8 px under the row.
- **Finishers line:** up to three 20 px avatars of finishers and "Brock and Dawn finished" (Footnote, secondary), or "Be the first to finish".
- **Finished:** the bar is full, and the title line reads "Finished · 2nd" when you made the podium, otherwise "Finished".

### 7.4 The board

Artboard `S3Challenge`. `/leaderboard/challenge`.
1. Segmented control: Challenge.
2. **`ChallengeHero`** (`rounded-[22px] p-4`, the challenge's type tile gradient at 150°, the `StatTile` shadow, the type's `EnergyIcon` 84 at 20 % as a watermark, bottom right):
   - "Week 44 · ends Sunday 23:59 · 2 days left" (Footnote semibold);
   - the title "Sort 20 cards into binders" (Title 2), 4 px under;
   - 12 px under, your progress: "14" (tile number) and "/ 20" (Headline), with "6 more to finish" (Footnote) on the right;
   - a white bar on `bg-black/25`, 8 px under (like `XpBar tone="onAccent"`).
   All text on the gradient is full white (4.7–5.5:1 on the stops).
3. **Podium** (Title 3 "Podium", Footnote "First three to finish"): `Podium size="md"`.
   - Three columns, 2nd, 1st, 3rd. Each has a `TrainerAvatar` 44, the name (Footnote semibold), the finish time (Caption 1, secondary: "Tue 21:14") and a block with radius 12 at the top.
   - Block heights: 1st 88, 2nd 64, 3rd 48, in the `PODIUM_TYPES` tile gradients, with the place in Title 2 in the tile text colour.
   - A place nobody has taken is a dashed outline (fill-tertiary border) with "Open" (Caption 1, secondary).
4. **`ChallengeBoard`** (`ListSection` "Trainers"). One row per trainer on the board, finishers first by time, then by progress:
   - a place disc (24 px, the podium gradient, or a fill circle);
   - `TrainerAvatar` 32;
   - the name (Body) or "You" (semibold);
   - a status line (Footnote, secondary): "Finished Tue 21:14" or "18 of 20";
   - on the right, a 64 px `HpBar` and the count (Footnote, tabular).
   Your own row gets `bg-elevated`.
5. Footer: "Counts cards you add to a binder or deck this week. Everyone who finishes earns the Weekly Challenger badge and 50 XP." The first sentence comes from the challenge's catalogue entry.

### 7.5 Podium

`Podium` is shared by the board and the result card; the feed's challenge medal is a 48 px disc in the same gradient.
- `size="md"` (the board): 40 px avatars, blocks 72, 56 and 44, the place in Title 2.
- `size="lg"` (the result): 48 px avatars, blocks 104, 76 and 56, the place in Title 1.
- The columns are an ordered list in place order; CSS `order` draws 2nd, 1st, 3rd. On the first view of a finished podium the blocks rise once (500 ms, `--ease-ios`). Under Reduce Motion they are static.

### 7.6 End of the week

Artboard `S3ChallengeResult`. From Monday 00:00 to Tuesday 23:59, the Challenge segment opens with **`ChallengeResultCard`** (`rounded-[22px] bg-card p-4`) above the new week's hero:
- "Week 44 results" (Footnote semibold, secondary), the challenge title (Title 3);
- `Podium size="lg"`;
- "3 of 4 trainers finished" (Footnote, secondary);
- your line in a 29 px green square row: "You finished 3rd · Sun 20:41", or "You finished", or "You reached 14 of 20";
- if a badge tier unlocked: a `ListRow` with a `BadgeMedal` 29, "Challenge Regular · Silver", "5 challenges finished" → Achievements.

The badge itself celebrates through the existing unlock sheet (`S3ChallengeBadge`), once.

### 7.7 Data (proposed for P13)

```jsonc
// GET /api/challenge   (require_social)
{
  "week": "2026-W44", "starts_at": "…", "ends_at": "…", "time_zone": "Europe/London",
  "challenge": { "id": "binder_cards", "title_key": "challenge.binder_cards", "target": 20, "type": "water" },
  "me": { "progress": 14, "finished_at": null, "place": null, "on_board": true },
  "board": [{ "user": { "id": 2, "username": "Brock", "avatar_id": 74 }, "progress": 20,
              "finished_at": "…", "place": 1 }],
  "finished_count": 2, "trainer_count": 4,
  "last": {            // from Monday 00:00 to Tuesday 23:59, else null
    "week": "2026-W43", "challenge": { }, "podium": [ ], "me": { "progress": 20, "finished_at": "…", "place": 3 },
    "finished_count": 3, "trainer_count": 4, "badge": { "id": "challenge_5", "tier": "silver" }
  }
}
```

- Tables: `challenge_weeks (week, challenge_id, closed_at)` and `challenge_progress (week, user_id, progress, finished_at, place)`, the latter in user deletion and `BACKUP_GROUPS["users"]`.
- The week closes in a scheduler job at 00:05 on Monday. It stores the places and writes `challenge_finished` events.

## 8. Accessibility, hide-values, motion and safe areas

**Hide-values** (`useHideValues`, `maskValue` → "••••") masks:
- card values in the composer, the picker, the offer sides and the matches;
- the cash rows and the cash field (it shows the number only while it's being edited);
- the meter's totals and delta;
- big-pull amounts in the feed.

Lists and pushes carry no amounts at all. The meter keeps its verdict, zones and marker. Each artboard with amounts has a `hideValues` tweak.

**VoiceOver**:
- **An offer row** reads "Swap with Brock. You get Charizard ex. You give Greninja ex. Your turn. 2 hours ago." Amounts are left out, as on screen.
- **The meter** is one `role="img"` with the verdict and totals, or "values hidden".
- **`SwappedStep`** announces each trainer's state; after a Swapped tap, `aria-live="polite"` reads "Waiting for Brock".
- **Reactions:** `aria-pressed`, with the count and "you reacted".
- **Feed rows** are articles with the sentence as their name.
- **The podium** is an ordered list: "1st, Brock, finished Tuesday 21:14". An open place reads "3rd place, open".
- **Progress bars** are `role="progressbar"` with labels ("Weekly challenge, 14 of 20").
- Avatars are decorative; the name is always written next to them.

**Reduce Motion**: no confetti anywhere. The swap's card cross, the podium rise, bar fills and the reaction tap (a 1.0 → 1.15 → 1.0 scale) all become instant or a 150 ms fade. Nothing loops.

**Targets**: every control is at least 44 × 44. The reaction capsules (36 px) and the 32 px `IconButton`s sit inside 44 px hit areas, as `IconButton size="sm"` already does. Rows are at least 44 px; card rows are 76 px.

**Safe areas**: pages keep the shell's nav bar under `--safe-top` and `--content-bottom` above the tab bar. The composer sheet's footer pads with `max(12px, var(--safe-bottom))`. Toasts stay top-centre. Nothing is fixed to the bottom of a page: the actions scroll with it, as on the artboards.

**Contrast**: §4.1. The status chips are capsules only on the page background; inside cards they become a dot and text.

One existing exception shows on `S3SwapProfile`: the trainer card's 80–90 % white lines ("ID No.", the XP caption) fall under 4.5:1 on the lighter, top-left part of its red gradient. It is drawn as it is today and isn't part of this work.

## 9. When social is off

Trainers see nothing of this, and nothing of today's screens moves:
- Trades: Live trade · History, as today. No Offers segment and no eye change.
- Compare: no Offer a swap or New offer buttons.
- Leaderboard: no segmented control.
- Profile: the Trades tile keeps its icon. Home: no swap card, and no challenge row in the Today card.
- Settings: no "Activity sharing" row and no "Swap offers" notification switch.
- The icon number counts scans only (as built: `appIconNumber` and `swap_offers_waiting` both check the switch).
- `/trades/offers*`, `/leaderboard/activity` and `/leaderboard/challenge` redirect to their parents. The API answers 404 (`require_social`, as built). Queued swap pushes are skipped (as built).

**Single-user mode** never shows social: `social_enabled` requires multi-user mode.

**Switching it off** keeps the data. If it comes back on, offers that passed their 14 days show as expired.

## 10. The artboards

Canvas: https://claude.ai/artifact/QNJ3UNo7XYj1ze96mkcFGF, under the Wave 2b rows. All are 390 × 844, except the push board. The sample data: you are Ash; the other trainers are Misty, Brock and Dawn.

| Row | Artboard | Shows |
|---|---|---|
| Swap offers (P11): start and answer | `S3SwapCompare.dc.html` | Compare › trade suggestions with Offer a swap |
| | `S3SwapComposer.dc.html` | The composer over Compare, the meter, the matches, the note (hide-values tweak) |
| | `S3SwapPicker.dc.html` | The picker step: Misty's spares |
| | `S3SwapOffers.dc.html` | Trades › Offers |
| | `S3SwapIncoming.dc.html` | Your turn, a new offer from Brock (hide-values tweak) |
| | `S3SwapOutgoing.dc.html` | Waiting for Dawn |
| | `S3SwapCountered.dc.html` | Your turn after Misty's counter: what changed |
| Swap offers (P11): finish | `S3SwapAccepted.dc.html` | Accepted: Brock tapped Swapped, your turn |
| | `S3SwapCompleted.dc.html` | Completed |
| | `S3SwapBlocked.dc.html` | Can't finish yet: a card is gone |
| | `S3SwapEnded.dc.html` | Expired, declined or cancelled (state tweak) |
| | `S3SwapProfile.dc.html` | Profile: the Trades tile count |
| | `S3HomeTodo.dc.html` | Home: the swap to-do card |
| | `S3SwapPush.dc.html` | Push texts: as built, recommended, details off; the icon number (1180 × 1000) |
| Activity feed (P12) | `S3FeedRanking.dc.html` | Leaderboard › Ranking with the segments and the row fix |
| | `S3Feed.dc.html` | Leaderboard › Activity: a set, a big pull, a badge, reactions (hide-values tweak) |
| | `S3FeedMore.dc.html` | The feed scrolled: your own goal (D6), a challenge finish, a pull without a value |
| | `S3FeedEmpty.dc.html` | First visit and the empty state |
| | `S3FeedSharing.dc.html` | What you share |
| | `S3LeaderboardOff.dc.html` | Social off: Leaderboard as today |
| Weekly challenge (P13) | `S3HomeChallenge.dc.html` | Home's Today card with the challenge row |
| | `S3Challenge.dc.html` | Leaderboard › Challenge mid-week |
| | `S3ChallengeResult.dc.html` | Monday: last week's podium and result |
| | `S3ChallengeBadge.dc.html` | The finisher badge sheet |

## 11. Phases after approval

These follow the engagement doc's phase rules (§4, §8):
- **P11a** (#114) and **P12a** (#113) are the backend. The additions in §5.9 and §6.6 are small follow-ups, in those phases or at the start of the UI phases.
- **P11b** builds the swap UI: Compare, the Offers segment, the composer and picker, the detail and its states, the meter restyle, the tile, the Home card and the Settings row.
- **P12b** builds the feed UI: the Leaderboard segments, the feed, the reactions and the sharing sheet.
- **P13** builds the challenge, API and UI.

Strings go in `en.js` only, under `swaps.*`, `feed.*` and `challenge.*`. Visual specs cover each artboard, with values shown and hidden.
