# Deployment and releases

PokéCollector's normal Docker installation uses published container images. A
source checkout and local image build are optional development tools, not
installation requirements.

## Published images

Each release publishes two public multi-platform images to GitHub Container
Registry:

| Service | Image |
| --- | --- |
| Backend | `ghcr.io/git-romer/pokecollector-backend` |
| Frontend | `ghcr.io/git-romer/pokecollector-frontend` |

Both images support `linux/amd64` and `linux/arm64`. PostgreSQL continues to use
the official `postgres:18-alpine` image.

Every application release has a stable version tag such as `1.51.6`. The
Compose file downloaded from that release defaults both application services to
that exact version. A `latest` alias is also published for discovery, but it is
not the default: two separate repository tags cannot be promoted atomically, so
an interrupted promotion could briefly leave frontend and backend `latest`
pointing at different releases.

Set `POKECOLLECTOR_VERSION` in `.env` to pin or override both application
images together:

```env
POKECOLLECTOR_VERSION=1.51.6
```

## Install without cloning the repository

```bash
mkdir pokecollector
cd pokecollector
curl -fsSL -o docker-compose.yml.new https://github.com/Git-Romer/pokecollector/releases/latest/download/docker-compose.yml
mv docker-compose.yml.new docker-compose.yml
curl -fsSL -o .env.new https://github.com/Git-Romer/pokecollector/releases/latest/download/pokecollector.env.example
mv .env.new .env
```

Set a secure `POSTGRES_PASSWORD` in `.env`. `JWT_SECRET_KEY` may be set
explicitly or left empty so the backend creates a strong key under
`./data/auth`. Then start the stack:

```bash
mkdir -p data/pokedex-images backups
docker compose pull
docker compose up -d
```

The published frontend image applies `PUBLIC_MODE` when the container starts,
so public/private SEO behavior does not require a different frontend build.

### Service worker flags, headers and rollback

The frontend image also applies `PWA_ENABLED` and `OFFLINE_QUEUE_ENABLED` at
start (both are enabled by default; set either to `false` to disable; see [`PWA.md`](PWA.md)). Entry-point scripts in
`/docker-entrypoint.d/` run in name order: `40-configure-public-mode.sh` resets
`index.html` from its template, then `45-configure-pwa.sh` selects `/sw.js` and
adds the flags meta tag, so restarts never accumulate edits.

nginx sends `Cache-Control: no-cache` for `/sw.js`, `/sw.real.js`, `/sw.kill.js`,
`/index.html`, `/manifest.json` and SPA routes, and a one-year `immutable` header for
hashed assets. A reverse proxy in front must not cache `/sw.js`; with Nginx Proxy
Manager turn **Cache Assets** off for the host.

To roll back a bad service worker (the kill switch), set `PWA_ENABLED=false` and recreate the
frontend container: phones replace the worker with a kill worker on their next
update check. Reverting to the previous image tag also works.

### Default currency

`DEFAULT_CURRENCY` (for example `GBP`) sets the display currency for new users and for users
who have not picked one. It is case-insensitive; an unsupported code logs a warning and falls
back to `EUR`. A currency someone chose in Settings is never changed. Set it as a variable in
the Portainer stack's environment: `docker-compose.portainer.yml` passes it to the backend
(`DEFAULT_CURRENCY: ${DEFAULT_CURRENCY:-EUR}`), and a stack variable the compose file does not
list never reaches the container. Recreate the backend after changing it.
`PUSH_FOREGROUND_WINDOW_SECONDS` (default `60`) is passed through the same way.

### Push notification key

Web push (see [`PWA.md`](PWA.md)) signs with a private key stored at
`./data/auth/vapid_private.pem` (or `VAPID_PRIVATE_KEY`). It is a file, not a database
row, so SQL dumps and the backups in `./backups` do not contain it: include
`./data/auth` in your file backups. If it is lost, a new key is created and everyone
turns notifications on again. `VAPID_SUBJECT` can set a contact URL or `mailto:`.

## Update

First create and retain a manual database backup:

```bash
backup_file="backup_$(date +%Y%m%d_%H%M%S).sql"
umask 077
docker compose exec -T postgres pg_dump -U pokemon pokemon_tcg --clean --if-exists > "$backup_file"
test -s "$backup_file"
```

Do not continue if the final check fails. Full SQL dumps can contain user
settings and scanner API credentials, so keep the restrictive permissions and
store the file securely.

For a no-clone installation, download the newest Compose definition safely:

```bash
curl -fsSL -o docker-compose.yml.new https://github.com/Git-Romer/pokecollector/releases/latest/download/docker-compose.yml
mv docker-compose.yml.new docker-compose.yml
docker compose pull
docker compose up -d
```

Confirm that the services are running and the backend responds. Replace port
`8000` if `BACKEND_PORT` is customized:

```bash
docker compose ps
curl -fsS http://localhost:8000/api/health
```

For an installation backed by a Git checkout, run `git pull` before the two
Compose commands. Existing PostgreSQL 15 installations must first follow the
one-time procedure in `scripts/upgrade-postgres-15-to-18.sh`, as described in
the README.

Before startup migrations run for a new application version, the backend also
creates a full automatic SQL dump in `./backups`. Startup stops before migration
when that safety backup fails unless `PRE_UPGRADE_BACKUP_REQUIRED=false` was
explicitly selected.

## Roll back

1. Retain the failed/current database state for diagnosis, then stop frontend
   and backend writes while leaving PostgreSQL running.
2. Set `POKECOLLECTOR_VERSION` to the previous release version.
3. Restore the matching pre-upgrade/full SQL backup when the newer version ran
   database migrations.
4. Pull and restart both application services together.

```bash
docker compose stop frontend backend
docker compose exec -T postgres psql --set ON_ERROR_STOP=on --single-transaction -U pokemon -d pokemon_tcg < backup.sql
docker compose pull backend frontend
docker compose up -d
```

The Settings restore action accepts `.sql` files, streams the upload into a
temporary file, and executes it with PostgreSQL `ON_ERROR_STOP` in a single
transaction. Any statement failure rolls back the complete restore, and the
temporary upload is deleted afterward. The restore runs as a background job: the
upload is answered at once (HTTP 202) and Settings polls
`GET /api/backup/restore/status` every 3 seconds (`idle`, `running`, `done` or
`failed`, with the error). Only one restore runs at a time. The status survives a
page reload and is kept in `restore_status.json` next to the backups.

`RESTORE_TIMEOUT_SECONDS` (default `3600`) is how long one restore may run. A
large database can need more than the old 120 seconds; when the limit is hit,
`psql` is stopped, PostgreSQL rolls the transaction back, nothing is restored and
the status says so. Raise the value in the stack's environment if your restore
legitimately needs longer.

For a very large dump, or when you would rather not depend on the web request at
all, restore from the server instead (this is the same command the app runs):

```bash
docker exec -i <postgres container> psql -U pokemon -d pokemon_tcg --single-transaction -v ON_ERROR_STOP=1 < backup.sql
```

After a successful restore the app also
clears its stored idempotency keys; after a manual `psql` restore, run
`DELETE FROM idempotency_keys;` yourself so a retried request cannot be
mistaken for one that was already applied.

Selective backup groups are useful for targeted exports, but they may depend on
rows outside their group and do not currently include every newer feature
table. Full backups are the recovery and upgrade format.

## Wiping user data

Settings > Administrator > Danger zone > **Wipe all user data** deletes every
user and everything they made, then creates one administrator again from the
stack's environment. Use it to reset a test stack, or to start a fresh
installation without touching the server's own configuration.

**Before you can run it**, both `ADMIN_USERNAME` and `ADMIN_PASSWORD` must be set
in the stack's environment. The wipe is refused (and the panel says why) when
either is missing: the new administrator gets exactly that password, so without
it nobody could sign in. Nothing else is needed; after the wipe sign in as that
user.

**What goes**

- every account and session, invites, push subscriptions, idempotency keys;
- collections, wishlists, collection card photos, binders, products, trades,
  swaps, portfolio snapshots, printing-detail labels;
- XP, achievements, goals, daily activity, feed events, reactions, comments,
  notifications, weekly challenge results, admin notifications and banners;
- every user's preferences (`user_settings`);
- custom cards that trainers created (rows in `cards` with `is_custom` or an
  owner) with their price rows, and the `custom_card_matches` that point at them;
- files in the scan upload folder (`SCAN_UPLOAD_DIR`, `/app/data/scan-uploads`).

**What stays**

- the server settings (`settings`: picture match first, price sync, languages,
  the `scanner_global.*` keys, debug mode and so on) and the stored data epoch;
- the card catalogue (`sets`, TCGdex `cards`), `price_history`, `image_cache`,
  `sync_log`, the Gemini and provider limit state, and the **audit log**;
- `/app/data/card-match` (picture indexes, the chosen option set, admin
  corrections, custom models), `/app/data/pokedex-images`, the card picture
  packs, `/app/backups` and `/app/data/auth` (the JWT secret and VAPID keys);
- the **scanner connection settings**. They are stored per user, so the wipe
  reads the running administrator's scanner rows first (`scanner_provider`,
  model, custom model, timeout and capability rows for both providers,
  `scanner_gemini_fallback`, `gemini_api_key`, `openai_api_key`,
  `scan_diagnostics_enabled`) and writes them onto the new administrator. The
  endpoint itself (`OPENAI_BASE_URL`) is an environment value and is unchanged.
  If the administrator had no scanner settings and `GEMINI_API_KEY` is set, it
  seeds the new account, as on a first start;
- **scan photos and diagnostics, always** (`SCAN_TRACE_DIR`: the traces, their
  photos, admin corrections, misses and held-back marks that make up the
  matcher's real-photo test set, and `/app/data/card-match`). The wipe never
  deletes or rewrites them, apart from the detach step below, and there is no
  option to delete them. Scanning and diagnostics keep working for the new
  accounts as before (diagnostics consent is per user, so it starts fresh).

**Safety checks.** To run it the administrator types `WIPE ALL DATA` and
re-enters their password (no password is asked when the instance has no login
screen). It is refused while a restore, a matcher or Scanner lab job, or a scan
job is running, and for anyone who is not an administrator.

**Order of operations.** (1) checks, (2) the administrator's scanner settings are
read, (3) a `pre-wipe-<UTC>.sql` backup is written to the backups folder with
`pg_dump`; if that fails the wipe stops and **nothing is deleted**, (4) the scan
traces are detached (below); if that fails for any trace the wipe stops and
nothing is deleted, (5) one database transaction under a lock deletes the rows,
recreates the administrator, writes the scanner settings back, stores a new data
epoch and writes the audit entry (who ran it, when, the backup file and the row
counts per table); a failure rolls all of it back, (6) only then the scan upload
folder is emptied.

**Detaching the scan traces.** A local scan trace names its scan only by
`item_id`, and the Scanner lab's card finder reads the scan's whole review photo
through the database (`ScanJobItem.image_path`) from the scan upload folder,
both of which the wipe deletes. So before deleting anything, every local trace
with an `item_id` gets a copy of its review photo next to it
(`<trace>.review.jpg`, written atomically), recorded in the trace JSON as
`review_photo_file`, and is stamped with the `data_epoch` it was made in
(`data_epoch`, also written into every new trace). It is idempotent: a trace
that is already done is skipped. The finder reads the trace's own copy first and
goes to the database only for a trace of the current epoch, so an old trace can
never fetch a new trainer's scan, even though ids are not reused. These are the
only changes to the trace folder: files are added and the two keys are added to
trace JSON files; nothing is removed.
 Rows are
deleted, not truncated, so ids are never reused.

**Devices.** Every session ends. `GET /api/health` carries `data_epoch`; each
device stores the one it last saw, and when it differs (including a phone that
was offline during the wipe and returns days later) it drops its queued changes
without sending them, clears saved pages, caches and local preferences, and goes
to the login screen. The downloaded card database stays. `/api/health` also carries
`data_wiped_at` (when the last wipe finished; null if there never was one). A
device with no stored epoch (it last ran before this feature, or was never opened
between a deploy and the wipe) that holds anything user-specific (a stored
sign-in, queued changes, saved pages) is treated as wiped when the server reports
`data_wiped_at`: it resets and signs out, so its old queue can never be replayed
into a new account. A device that holds nothing just stores the epoch. Every
queued change is also stamped with the epoch it was queued in, and the outbox
never sends an item stamped with a different epoch (or an unstamped one once the
server has been wiped); it deletes it instead.

**Restore from the pre-wipe backup.** The file is a plain dump (without image
cache rows) that the restore's SQL guard accepts (tested). It is listed under
Settings > Data & sync > **Server backups**, where an administrator can download
it or restore it (see below). From the server instead:

```bash
docker exec -i <postgres container> psql -U pokemon -d pokemon_tcg --single-transaction -v ON_ERROR_STOP=1 < /app/backups/pre-wipe-<UTC>.sql
```

Restoring brings the old accounts back and also the old data epoch, so phones
that already reset themselves will keep their reset state and simply sign in
again. The scan upload folder is not in the backup; the scan traces were never deleted.

## Server backups

Settings > Data & sync > **Server backups** (administrators only) lists the `.sql`
files in the backups folder (`/app/backups`), newest first, with name, kind, date
and size: the `pre-wipe-<UTC>.sql` made by a wipe of all user data, the
`pre_upgrade_*` files made before an upgrade, and earlier downloads. Hidden and
temporary files, `restore_status.json` and anything that is not a `.sql` file are
not listed.

- **Download** streams the file.
- **Restore this backup** needs the file name typed back (and the administrator's
  password when logins are on) and then runs the same restore as an upload: the
  same SQL guard, `RESTORE_TIMEOUT_SECONDS`, status polling and one-restore-at-a-time
  lock. The file is copied first and the copy is what the job deletes, so the
  backup itself stays.

Only a bare file name is accepted: no path separators or `..`, the file must be a
regular file directly inside the backups folder after resolving, and symlinks are
refused. Download and restore are written to the audit log (a full restore then
replaces the audit log with the backup's own copy).

A restore also brings back the backup's `data_epoch`. Phones that had already seen
a wipe (and reset) will see a changed epoch and reset again, which is intended;
they only need to sign in again.

## Test stack (nonprod)

New features are tested on a second stack built from the `nonprod` branch before
they reach `deploy`. Its overrides are in `docker-compose.nonprod.yml`, and the
setup is described in [`NONPROD.md`](NONPROD.md).

## Local development images

Contributors can build from source with the checked-in override:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Use both `-f` arguments for later lifecycle commands. A plain
`docker compose up` returns to the published GHCR images. See
[`CONTRIBUTING.md`](../CONTRIBUTING.md) for the development workflow.

## Automated release flow

`.github/workflows/release.yml` starts when `VERSION` changes on `main` and may
also be dispatched manually. It:

1. validates that the repository version sources agree;
2. creates or reuses a recoverable draft release;
3. builds frontend and backend for `amd64` and `arm64` in parallel;
4. publishes exact-version images and verifies anonymous access;
5. promotes the current version to `latest`;
6. uploads `docker-compose.yml` and `pokecollector.env.example`; and
7. publishes the GitHub release only after the images and assets succeed.

The workflow uses one release-wide concurrency group. A rerun can reuse valid
versioned images, repair assets with `--clobber`, and finish an incomplete draft.
If the default branch has already advanced to a newer version, recovery of the
older release does not replace the mutable `latest` pointers.

Normal future releases require no package-visibility interaction. Repository
Actions permissions and public GHCR package visibility are persistent settings.
Intervention is only expected after a build/release failure, a change to the
external Actions allowlist, or another explicit infrastructure change.
