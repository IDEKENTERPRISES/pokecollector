# 2026 Wrapped — visual redesign (P9c direction)

Status: direction for owner approval (2026-10-29). Mockups: the Design canvas, row **"Wave 2b — Wrapped redesign"** (https://claude.ai/artifact/QNJ3UNo7XYj1ze96mkcFGF). Implementation is a separate worker after approval. Deadline unchanged: Wrapped on `deploy` by 1 December 2026.

**What changes:** only the look and the layout of the ten slides and the share picture.

**What stays:**
- the API, `GET /api/progress/wrapped`, with the same fields;
- `selectSlides()` and its rules for skipping empty slides;
- tap forward and back, and the 6 s timer;
- hide-values masking every amount;
- Reduce Motion, VoiceOver labels and 44 pt targets.

The owner's verdict on v1, which this answers:
- text sat at the bottom of the screen, which left a big empty middle;
- the share picture was "just a bunch of text with no proper layout";
- it should be "really cool, Pokémon themed and appealing".

---

## 1. What other year-in-review products do

| Product | What makes it work | Take for us |
|---|---|---|
| **Spotify Wrapped** ([2024 design notes](https://alexjimenezdesign.substack.com/p/three-design-elements-that-made-spotify), [It's Nice That interview](https://www.itsnicethat.com/features/spotify-wrapped-2024-graphic-design-041224), [2025 coverage](https://betanews.com/2025/12/03/spotify-wrapped-2025-is-here-and-this-time-its-interactive-and-competitive/)) | **Type as form:** the numbers are blown up until they become the artwork. Text sits on flat colour so it stays legible. Each theme gets 2–3 related looks: intro panel, data screen, then a share layout. The share card is a *derived* layout, not a screenshot of the slide. 2025 went tactile (mixtape and scrapbook textures) and let people go back and revisit, not only autoplay. | Hero numbers as artwork. One recurring motif, varied per slide. A share layout composed for sharing, separate from the slide. |
| **YouTube Recap** ([how the personality cards were made](https://blog.youtube/culture-and-trends/unpacking-youtube-recap-2025-personality/)) | Viewing habits treated as "a vibe more than data points": 14 personality characters, each with its own motion style and a **rarity percentage**. These became the most-shared part. | A **trainer type** persona from the top energy type, with a rarity mark. |
| **Duolingo Year in Review** ([behind the scenes](https://blog.duolingo.com/year-in-review-behind-the-scenes), [2020 write-up](https://blog.duolingo.com/duolingo-2020-year-in-review), [UX Collective](https://newsletter.uxdesign.cc/p/has-duolingos-year-in-review-outshone)) | Chose a compact card that behaves like an image over a scrolling page, so friends read it at a glance. Adding a **second share format** (the learner-style card) "significantly boosted share rates", because it gives everyone something to share, not only the top 10 %. | A second share picture that isn't about volume: the trainer card works for a 40-card year as well as a 4,000-card one. |
| **Strava Year in Sport** ([help: sharing](https://support.strava.com/hc/en-us/articles/22067973274509-Your-Year-in-Sport), [9to5Mac](https://9to5mac.com/2023/12/15/stravas-personalized-year-in-sport-now-available/), [2018 film](https://www.stinkstudios.com/work/strava-year-in-sport-2018)) | Every scene has its own share, and the end has a customisable summary image. 2022 was built on one geometric motif, the circle, repeated everywhere. | One shape language throughout: **the card**. A per-slide share for the hero slide, and a summary poster. |
| **Reddit Recap 2022** ([TechCrunch](https://techcrunch.com/2022/12/08/reddits-end-of-year-recap-experience-rolls-out-with-personalized-shareable-cards/)) | Ended on a downloadable **trading card**: avatar, top communities, persona, and a Rare / Epic / Legendary tier. It had a privacy option (generic name and avatar). | A trading card is what our users already love. The summary becomes *your* card of the year, with a hide-values version as the privacy option. |
| **Apple Music Replay** ([PhoneArena](https://www.phonearena.com/news/apple-music-replay-finally-stops-acting-like-a-separate-app-in-ios-26_id171321), [BGR](https://www.bgr.com/2041453/apple-music-replay-2025-now-available-how-to-find)) | Native, calm, image-led: a highlight reel, then big artwork and month-by-month views. | Card images as heroes, large and sharp. Let artwork carry the screen. |
| **Goodreads / Letterboxd / StoryGraph** ([Goodreads](https://www.goodreads.com/blog/show/595-see-your-year-in-books), [Letterboxd YIR by Cactuslab](https://cactuslab.com/work/letterboxd-year-in-review), [StoryGraph request](https://roadmap.thestorygraph.com/requests-ideas/posts/more-visually-appealing-interesting-wrap-up-designs)) | Cover walls and large-format imagery. The complaint about Goodreads: covers get illegible for heavy readers, so people screenshot instead. | Use a few large cards, never a tiny wall. Our API gives two images (first card, top pull), which is just right. |
| **Steam Replay** ([GamingOnLinux](https://gamingonlinux.com/2022/12/steam-replay-gives-you-an-overview-of-your-2022-gaming-habits/page=4)) / **GitHub-style wraps** ([example](https://dev.to/middleware/an-open-source-spotify-like-yearly-recap-using-your-github-contributions-43p)) | Phone-first stat stories: a collage of what you played, a **streak**, and a heat-map grid that turns activity into texture. | A streak drawn as a punch-card of filled pips: the count made visible. |

Trading-card apps: I found no published year-in-review from Collectr, TCGplayer or TCG Live, so card-collecting gets nothing copied. That leaves the theme open for us.

Across all of them:
1. **One idea per screen, and the idea is the art.** A number, a cover or a character fills the middle of the screen; the words frame it.
2. **A system with variation.** One motif (Spotify's loops, Strava's circle) recurs with 2–3 looks, so it reads as one story.
3. **Identity beats volume.** Personas and rarity get shared more than raw totals, and they flatter small collections too.
4. **The share picture is designed, not captured.** It is composed for 9:16, legible as a thumbnail, and there is more than one.
5. **Pacing:** intro beat, then reveal, then detail; motion only where it carries meaning (count-ups, reveals).

## 2. Design principles for v2

1. **Fill the screen; put the hero in the middle.** Each slide has three zones:
   - **header** (y 104–230): an eyebrow and a headline;
   - **hero** (y 230–620): a card image, a giant number, or a chart;
   - **detail** (y 620–790): two or three facts, attached to the hero.

   The whole group is vertically balanced. There is no `flex-1` spacer that throws text to the bottom (that was v1's problem). Nothing sits below y 790; the home indicator needs 34 px.
2. **The card is the shape language.** Rounded 5:7 rectangles, foil edges, art windows, and collector numbers ("004/010") appear on every slide. The story is framed as **"your 2026 set"**: each slide is a card in it, and the last one is your trainer card.
3. **Numbers are artwork.** Hero numbers are 120–170 px in a condensed heavy face, with a foil fill or a type colour.
4. **Energy types colour the story.** Each slide takes an energy type, the same one as v1 so the code mapping holds. The favourites slide and the share poster take the collection's own top type.
5. **Alive, not busy.** Bars grow, numbers count up, the top pull flips in with a sparkle burst, and the foil shimmers with tilt (`useTilt`). With Reduce Motion all of this becomes a plain cross-fade, and the final frame is identical.
6. **Original everything.** No Pokémon Company artwork, logos, energy symbols or card scans. Card images come only from the app's image proxy at runtime. Type glyphs, card backs, badges and the set mark are drawn shapes made for this app.

## 3. Pokémon theming system

### 3.1 Type palette

Use the existing `TYPE_COLOURS` from `components/ios/pokemon.js`; no new hexes are needed for backgrounds. Each slide background is three layers:
- **base:** the type gradient, `top` → `bottom`, 160°;
- **light:** a radial glow of `solid` at 35–55 % behind the hero;
- **texture:** fine diagonal foil lines, white at 6 %, plus 3–5 four-point sparkles.

Text is white, or `#1D1600` on lightning and colorless, exactly as `TYPE_COLOURS.text`, so it passes 4.5:1 on both gradient stops (`pokemon.test.js` already checks this). Secondary text uses white at 85 % or more, never less. Any coloured text sits on a dark scrim.

### 3.2 Type glyphs (original)

These are simple 24-grid stroke and fill icons, drawn for this app. They are *not* the TCG energy symbols.

| Type | Glyph |
|---|---|
| grass | a leaf |
| fire | a flame |
| water | a drop |
| lightning | a bolt |
| psychic | an eye in a spiral |
| fighting | a fist |
| darkness | a crescent |
| metal | a hex nut |
| dragon | a fang |
| fairy | a four-point star |
| colorless | a ring |

They sit in a round medallion, which is the "energy coin".

### 3.3 Foil

The holo sheen is a linear gradient at 115° running pink, cyan, yellow, pink at 30–40 % opacity, with `mix-blend-mode: soft-light`. Use it for:
- edges, which are 2 px foil borders;
- the trainer card frame;
- the giant numerals, as a background-clip fill over white.

On the phone it moves with `useTilt`, reused from P3. Under Reduce Motion it is static.

### 3.4 Collector strip

Every slide shows a small pill in its header: `◆ 004/010` and the slide's name. It reads like a card's set number, and it doubles as the VoiceOver "slide 4 of 10" label. The total is the number of slides `selectSlides` kept, so a 7-slide story reads 001/007 to 007/007.

### 3.5 Trainer type (persona)

The persona comes from `top_type`, and needs at least 10 cards in the year; otherwise there is no persona. Copy is new i18n strings only, and the API doesn't change.

| Type | Trainer type | Line |
|---|---|---|
| grass | Evergreen | "Slow and steady, your binder kept growing." |
| fire | Blazer | "You chased the hot pulls." |
| water | Tidecaller | "Calm collecting, deep binders." |
| lightning | Spark Chaser | "Quick hands, bright cards." |
| psychic | Mystic | "You see the art others miss." |
| fighting | Brawler | "Every set was a challenge to win." |
| darkness | Night Owl | "Your best pulls came after dark." *(playful, not a data claim)* |
| metal | Ironclad | "Built to last, sleeved and safe." |
| dragon | Wyrmkeeper | "Rare beasts only." |
| fairy | Charmer | "Pretty cards, prettier binder." |
| colorless | All-Rounder | "A bit of everything, and proud of it." |

### 3.6 Rarity mark

The trainer card carries a rarity mark from the year's card count.

| Cards in the year | Mark | Rarity |
|---|---|---|
| 1–49 | ● | Common |
| 50–199 | ◆ | Uncommon |
| 200–749 | ★ | Rare |
| 750–1,999 | ★★ | Double Rare |
| 2,000+ | ★★★ | Ultra Rare |

This flatters without lying: it is a tier label, not a percentile. **Owner to confirm** whether to show it at all.

### 3.7 Gym-badge awards

Badges earned are drawn as rows of small octagonal medallions, a "badge case", one per badge up to 24, then "+N". Each medallion is tinted through the type palette in order. The award shapes are original: an octagon with a faceted inner star.

### 3.8 Type

- **Display:** **Archivo**, a variable font under the SIL OFL, used condensed (`wdth` 62–75) and heavy (`wght` 800–900) for hero numerals and headlines. Self-host one subset woff2 of about 40 KB in `frontend/public/fonts/`, so it works offline and the share picture's Canvas can draw it after `document.fonts.load()`.
- **Body:** stays the system font (SF Pro on iPhone).

## 4. The slides

Every slide is 390 × 844 pt.

**Story chrome**, unchanged in behaviour:
- progress segments at y 56;
- close button, 44 × 44, top right at y 66;
- the tap zones;
- the header pill sits under it from y 112.

**Content** fills y 150–790. The hero centre sits near y 420.

| # | Slide (`id`) | Type | Header | Hero (middle) | Detail (attached under the hero) |
|---|---|---|---|---|---|
| 001 | **Cover** (`cover`) | darkness, with a foil set mark | "Ash's" / "2026 set" | A fan of three **original card backs** (drawn pattern, no logo) behind a round foil **2026 set mark**. Sparkles drift. | If history is partial: a stamp-style chip "Collected since 12 March". Then a **"Tap to open"** chip with an arrow, at y 720 and centred. It is the call to action, not stranded text. |
| 002 | **Cards** (`cards`) | fire | "This year you added" | **486** at 168 px, condensed, with a foil fill and "cards" beside it. Below it, a 12-bar **month chart**, 200 px tall and full width. Bars are rounded, and the top month glows yellow with a callout "Jun · 88". | Two stat chips: "312 unique", "41 sets touched". |
| 003 | **First card** (`first`) | grass | "Your first card of 2026" | The card image at 236 × 330, tilted −4°, on a radial light burst, with a "№ 001" stamp on its corner. | Name (28 px), set and number, and an "Added 12 March" chip. |
| 004 | **Top pull** (`pull`) | lightning (dark text) | "Your top pull" | The card at 250 × 350 in a **holo frame**, with a 12-ray sparkle burst behind it. A gold **price plate** overlaps the card's bottom edge. | Name, set · date. Masked: the plate reads £•••. |
| 005 | **Favourites** (`favourites`) | the top type (psychic for Ash) | "Your trainer type" / "**Mystic**" | A 220 px **energy coin**: a donut ring filled to the type's % with the glyph in the centre and "31 % Psychic" under it. | Two tiles side by side: **Pokémon of the year** "Eevee · 23 cards" and **Top illustrator** "Mitsuhiro Arita · 31 cards". With no `top_type`, the coin becomes the Pokémon-of-the-year name hero. |
| 006 | **Sets** (`sets`) | water | "You completed" | **6** "sets" at 150 px beside a 2 × 3 grid of **set seals** (round stamps with a check and the set name, up to 6, then "+N more"). | **Closest to done:** "Surging Sparks · 20 to go". A progress ring plus a bar at 171 / 191. With no completed sets, the ring becomes the hero. |
| 007 | **Value** (`value`) | dark (`#101418`) with a green glow | "Your collection is worth" | £1.4k at 96 px. A **full-width area chart**, 280 px tall, with a foil-green line, the gradient area, month ticks and the **peak** pin with its bubble "Peak £1.52k · Oct". | A change pill "+£512 since March" (orange if down). Masked: every amount reads £•••, the chart shape stays, and there are no axis amounts. |
| 008 | **Streak** (`streak`) | fire (deep) | "You kept coming back" | **41** "day streak", with a **punch card** of 41 filled flame pips in rows of 10, so the count is visible at a glance (capped at 60, then "+N"). | A 3-up tile row: Who's That Pokémon wins 112, Quests 260, Level 14. Tiles reflow to 2 or 1 as data allows. |
| 009 | **Badges** (`badges`) | darkness (with gold) | "You earned" | **18** "badges", over a **badge case** of 18 octagonal medallions (6 × 3). | A stat rail: 4 trades · 2 products opened · Lv 14. With no badges, the rail tiles become the hero at double size. |
| 010 | **Summary** (`summary`) | the top type | "Your 2026 trainer card" | **The trainer card**, 330 × 462 (5:7): a foil frame, then a name bar ("Ash", the persona "Mystic" and the type coin), the top-pull art window, a stat block (cards, sets, Pokémon of the year, streak), and the rarity mark with "010/010". | Buttons: **Share** (white, 52 pt) and **Watch again** (44 pt+). They sit right under the card at y ≈ 670–780, not floating. |

## 5. Share pictures

All share pictures are 1080 × 1920 (9:16 story), drawn with Canvas 2D in `progress/shareImage.js`. They get a new `layout` spec instead of `blocksSpec`'s stacked lines.

**A. Trainer card poster** (summary; recommended default)
- **Background:** the top type's gradient, with foil lines and sparkles.
- **Top:** "Ash's 2026 set" in 64 px Archivo.
- **Middle:** the trainer card itself, 900 × 1260, so it fills the frame.
- **Bottom:** the app mark and "PokéCollector Wrapped" at 36 px.

It reads as a collectible at thumbnail size.

**B. Stat poster** (summary; alternative)
- A 2-column **bento grid**: a giant "486 cards" tile, the top-pull card tile with its price plate, a month-chart tile, the persona tile, and a streak and sets pair.
- It is denser, more like Strava's or Spotify's summary.

**C. Top-pull card** (per-slide share; optional)
- From the top-pull slide: the card image very large, with the sparkle burst, "Ash's top pull of 2026" and the price plate.

It adds a small share button (44 pt) to that slide's header. Strava and Spotify both let you share single scenes; this is the one slide worth it.

**Hide-values:**
- every amount is drawn as `£•••`: the price plate, the value tile and any money in the stat block;
- the chart keeps its shape;
- the file name and alt text carry no amounts.

**Images:**
- card art comes through the image proxy, as `blocksSpec` does now;
- if an image fails, draw the original card-back pattern with the card's name on it, never an empty box.

**Owner to choose:**
- **A or B** as the summary picture (or both, as a two-page picker in the share sheet);
- whether **C** ships.

## 6. Short history and thin data

`selectSlides` still decides what plays.

- **Partial history** (`partial_history`):
  - the cover shows "Collected since 12 March";
  - in the month chart, the months before the start are drawn as dashed outlines labelled "not tracked yet", not as zero bars;
  - the value change reads "since March".
- **Few cards** (fewer than 12 in the year): the month chart is replaced by a row of one pip per card, grouped by month, so small numbers still look made.
- **No persona** (fewer than 10 cards, or no `top_type`): the favourites slide leads with whichever of Pokémon of the year and illustrator exists, as the hero. The trainer card shows "Trainer" and a colorless ring.
- **No top pull image:** the original card back is drawn with the name.
- **No top pull at all:** the trainer card's art window shows the first card instead; with neither, it shows the set mark.
- **Sets:** with no completed sets, the closest-set ring is the hero. With neither, the slide is skipped (current rule).
- **Streak and badges:** tiles reflow from 3 to 2 to 1. With one tile, it grows into the hero (big number with its icon), so the middle is never empty.
- **Summary card rows:** the stat block shows 2–4 rows; with 2, the art window grows taller.
- **Hide-values:** applies everywhere money appears: slides 004, 007 and 010, and pictures A, B and C.

## 7. Implementation notes for the worker

- Keep `wrapped.js`, `WrappedStory.jsx` behaviour and the tests' data hooks: `data-testid` on `wrapped-share`, `wrapped-restart`, `wrapped-value` and `wrapped-pull-value`. The rewrite is in `WrappedSlides.jsx`, plus a new share layout in `shareImage.js`.
- Shared pieces:
  - `<SlideFrame type header>` (the three zones and the collector pill);
  - `<HeroNumber>`;
  - `<CardHero>` (with holo and burst);
  - `<TypeCoin>`;
  - `<BadgeCase>`;
  - `<TrainerCard>`, also rendered off-screen for the share picture so the two stay identical.
- Motion runs on CSS transforms and opacity only. Count-ups use `requestAnimationFrame` and are skipped under Reduce Motion.
- Visual specs (`frontend/tests/visual/wrapped.spec.js`): update the baselines in CI (not locally) for each slide, values on and hidden.
