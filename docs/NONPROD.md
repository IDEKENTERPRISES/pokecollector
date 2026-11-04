# Nonprod test stack

`nonprod` is the integration branch for new features. Every phase PR goes into it, and each milestone is tested on a separate stack before it reaches `deploy`.

## Branch flow

- Phase branches are named `feature/np-pNN-<slug>`, are cut from `origin/nonprod`, and open their PR into `nonprod`.
- CI runs on every PR and on every push to `nonprod`. A green run on the `nonprod` head is the check before a promotion.
- After the owner's test round, `nonprod` is merged into `deploy` with the owner's OK. A fix that lands on `deploy` first is merged back into `nonprod`.
- **Before merging into `deploy`, add the release entry:** in `frontend/src/welcome/releases.json`, move the `next` draft into `releases` as the first entry, with its `id` (the release date), `from`, `date`, `kind` and `nameDate`, and write the next draft (or drop `next`). The owner approves the notes first. The entry's `id` is what What's new shows trainers and what the service worker's build id carries, so a promotion without it shows no sheet. The file's test checks the rules.

## Set up the stack (once)

1. **Folders** on garage-server:

   ```bash
   mkdir -p /home/rage/Documents/docker/pokelocal-nonprod/{backups,data/auth,data/pokedex-images,data/scan-uploads,data/scan-traces}
   ```

   Optional: copy prod's `data/pokedex-images` into the new folder so the sprites don't download again.

2. **Portainer:** Stacks › Add stack › Repository.
   - Use the same repository as prod, with reference `refs/heads/nonprod` and compose path `docker-compose.yml`.
   - Add these paths, in this order: `docker-compose.build.yml`, `docker-compose.portainer.yml`, `docker-compose.nonprod.yml`.
   - Give the stack a different name from prod, for example `pokelocal-nonprod`.
   - Automatic updates (polling) are handy here, so merges into `nonprod` deploy themselves. Keep them off for prod.

3. **Environment variables:** start from prod's. Leave `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` empty, and set `CORS_ORIGINS` to the nonprod address if prod sets it.

4. **Nginx Proxy Manager:** add a proxy host for the nonprod hostname.
   - Forward it to `pokemonlocal-nonprod-frontend`, port 80, with an SSL certificate. Push notifications and offline start need HTTPS.
   - Turn Cache Assets off (see [PWA.md](PWA.md)).

5. **Data:**
   - On prod, go to Settings › Data & sync › Download Backup and choose a full backup.
   - On nonprod, sign in as the admin from `ADMIN_USERNAME` / `ADMIN_PASSWORD`, then use Settings › Data & sync › Import Backup.
   - The restore runs in the background and Settings shows "Restoring… this can take several minutes" until it ends. Keep the page open or come back later; the status survives a reload.
   - `RESTORE_TIMEOUT_SECONDS` (default `3600`, set it in the stack's environment) is how long a restore may run. If a big database hits it, nothing is restored and the status says "timed out".
   - Server-side alternative that does not depend on the web request: `docker exec -i <postgres container> psql -U pokemon -d pokemon_tcg --single-transaction -v ON_ERROR_STOP=1 < backup.sql`.
   - Nonprod then has prod's users and passwords.

6. **iPhone:** open the nonprod address in Safari, then Share › Add to Home Screen. It is a separate app with its own offline data and its own notification switch.

## What stays separate from prod

- **Data:** the database, data folders, sign-in key and push key.
- **Telegram:** `TELEGRAM_ENABLED=false` in `docker-compose.nonprod.yml` stops every message, including bot settings that a restore brings along.
- **Push:**
  - Subscriptions restored from prod belong to prod's key. Nonprod's own key can't reach them, and nonprod deletes them after they fail.
  - Enable notifications again in the nonprod app.
- **Push diagnosis:** the backend log says what happened to each notification (`docker logs <backend> | grep "Notification "`): `queued` or `not queued` (category off, duplicate, nothing to review), `deferred` (quiet hours, with the end time), `skipped` (category off, already reviewed, badge sheet already seen) and `flushed` with `sent=`/`removed=` counts (`sent=0` means no device received it). Any non-2xx answer from a push service (403, 429, 410 …) is logged as a warning. Payloads and push endpoints are never logged.
- **Scanner:** per-user scanner keys come with the restore and share the provider's quota with prod.
- **Syncs:** nonprod runs its own scheduled syncs against TCGdex. You can lengthen the intervals in nonprod's Settings.

## Scanner diagnostics (collecting confirmed scans)

`docker-compose.nonprod.yml` sets `SCAN_TRACE_DIR=/app/data/scan-traces`, so the switch is available on nonprod. Nothing is collected until a trainer turns it on for their own account:

1. Open Settings › Scanner and switch on **Share scanner diagnostics**. It is off by default and per user, so each trainer who takes part does it on their own phone or login.
2. Scan as usual and, in the scan review, **add or confirm the right card** for each photo. Confirming is what labels the stored attempt with the correct card; photos you never confirm are kept but unlabelled.
3. Each attempt stores the sanitized photo, the model's answer, the candidates and the matching decision under `/home/rage/Documents/docker/pokelocal-nonprod/data/scan-traces/user-<id>/`.
4. Aim for 300-400 confirmed scans between the owner and one more trainer. Summarise them with `python scripts/analyse_scan_traces.py <trace_dir> [--failures] [--field-nulls]` (run inside the backend container).
5. Switching it off stops future collection and keeps what exists; **Delete data** next to the switch removes that trainer's traces.

## Scanner waiting state

When the scanner endpoint does not answer (for example the machine running the model is off) scans show **Waiting for the scanner** instead of a retry countdown. They do not use up retries, and the backend checks the endpoint about once a minute and releases every waiting scan as soon as it answers. **Try now** on a waiting scan checks at once. While scans wait, their 14-day expiry is held at least two days ahead, so nothing unrecognised is deleted.

## "Coming next" in the version history

Settings › About › Version history shows the draft notes of the release being tested (`next` in `frontend/src/welcome/releases.json`) at the top, under a yellow "Coming next" chip, **on nonprod only**.

- The gate is the **build channel**. `docker-compose.nonprod.yml` passes the build argument `RELEASE_CHANNEL: nonprod` to the frontend image, and `frontend/Dockerfile` hands it to Vite as `VITE_RELEASE_CHANNEL`. The base build file (`docker-compose.build.yml`, which `deploy` uses) defaults it to `production`.
- A build for any other channel **drops `next` from the bundle** (a Vite plugin in `vite.config.js`), so a `deploy` build holds no draft at all, even though the branch's file has one. `frontend/scripts/releases-build.test.mjs` checks this.
- In the app, `isNonprod()` (`frontend/src/welcome/channel.js`) reads the channel, and the history shows the block and the `/settings/about/versions/next` page only when it is `nonprod`. The draft is not part of the What's new sheet.
- **Testing the What's new sheet.** Your account is on the running release, so the sheet would never open. Under the Coming next block, a "Test What's new" section lists "As if I last had Squirtle / Charmander / Bulbasaur" and "As if I'm on a build before Bulbasaur". A tap stores `pc.whatsNew.test.<userId>` in this browser and reloads the app; at start `WhatsNewHost` uses it instead of both seen values, once, and clears it, so the real sheet opens with the releases newer than the choice. Closing it saves the running id as usual (the server only moves forward). The section, the override and its code are built for nonprod only and are left out of every other build; the strip test checks a built `dist/`.
- Running `npm run dev` locally keeps the draft in the file, with the channel on `production`; start it with `VITE_RELEASE_CHANNEL=nonprod npm run dev` to see the block.

## Previewing Wrapped

`GET /api/progress/wrapped?year=2026` only answers from 1 December to 15 January (otherwise 404). To look at it on nonprod before then, set `WRAPPED_PREVIEW=1` in the backend's environment. `docker-compose.nonprod.yml` already sets it for the nonprod stack:

- With it set, the date window is skipped.
- `preview_date=YYYY-MM-DD` pretends it is that day (`/api/progress/wrapped?year=2026&preview_date=2026-12-05`) and still enforces the window for that date.
- Leave it unset on prod; the preview date is ignored there.

### Trying the "Your Wrapped is ready" push

- On prod it goes out once per trainer per year: from 10:00 on 1 December in the trainer's own time zone, or at the next scheduler tick after that (up to 15 January). It needs at least one card added in the year, honours the "Wrapped" switch in Settings › Notifications (on by default), quiet hours and "Show card names and prices" (the detailed text names the card count, never an amount), and tapping it opens `/wrapped/<year>`.
- With `WRAPPED_PREVIEW=1` (set on nonprod) the date and 10:00 gate are skipped: each trainer's first scheduler tick after the deploy sends it once (the subject is `wrapped:<year>`, so it does not repeat).
- To try it again, delete that trainer's `wrapped:2026` row from `notification_queue` (or use a trainer who has not had it yet). Without the preview, nothing sends before 1 December.
- The check runs on the first tick and then every 10 minutes. Look for `category=wrapped` in `docker logs <backend> | grep "Notification "`.

## Testing the tour on nonprod

The hands-on tour (docs/WELCOME_DESIGN.md §3) runs in multi-user mode only.

- **Replay it:** Settings › About › Show the tour again clears your completion on the server and on this device, goes to Home and starts the welcome. Nothing else is needed.
- **A fresh account:** create a new trainer (Settings › Users, or an invite). An account made in the last two days starts the tour by itself on its first Home visit. Older accounts get the "Take the tour" card on Home instead; "Not now" counts as done.
- **Reset by hand:** `UPDATE users SET tutorial_completed_at = NULL, tutorial_outcome = NULL WHERE username = '...';` and clear `pc.tour.done.<userId>` in the browser's local storage.
- **Home Screen step:** it shows in iPhone Safari (not the Home Screen app) and in other browsers that offered an install. In the installed app it is skipped, and the scan step offers the notifications button.
- Leaving it part-way (closing the app, "I'll add it now") writes nothing: it starts over from the welcome. Only Finish, a confirmed Skip or "Not now" is stored (`tutorial_outcome`: `finished`, `skipped`, `dismissed`).
