# Nonprod test stack

`nonprod` is the integration branch for new features. Every phase PR goes into it, and each milestone is tested on a separate stack before it reaches `deploy`.

## Branch flow

- Phase branches are named `feature/np-pNN-<slug>`, are cut from `origin/nonprod`, and open their PR into `nonprod`.
- CI runs on every PR and on every push to `nonprod`. A green run on the `nonprod` head is the check before a promotion.
- After the owner's test round, `nonprod` is merged into `deploy` with the owner's OK. A fix that lands on `deploy` first is merged back into `nonprod`.

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

## Previewing Wrapped

`GET /api/progress/wrapped?year=2026` only answers from 1 December to 15 January (otherwise 404). To look at it on nonprod before then, set `WRAPPED_PREVIEW=1` in the backend's environment:

- With it set, the date window is skipped.
- `preview_date=YYYY-MM-DD` pretends it is that day (`/api/progress/wrapped?year=2026&preview_date=2026-12-05`) and still enforces the window for that date.
- Leave it unset on prod; the preview date is ignored there.
