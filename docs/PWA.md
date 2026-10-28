# Installable app and offline start (PWA)

PokéCollector can be added to an iPhone Home Screen, and, when you switch it on, saves its own app files on the device so the app can start without a network. This page describes the behaviour that is shipped today. The design rationale and the later phases (offline scan queue, cached data, push) are in [`PWA_OFFLINE_DESIGN.md`](PWA_OFFLINE_DESIGN.md).

## Install on iPhone

1. Open your PokéCollector address in **Safari** (not an in-app browser).
2. Tap **Share**, then **Add to Home Screen**, then **Add**.
3. Start it from the new icon. It opens in its own window without browser bars.

Installing needs no server setting. Offline start (below) is a separate, opt-in feature.

## HTTPS is required for offline start

Browsers only allow service workers on **secure origins**: `https://` with a trusted certificate, or `http://localhost`. On a plain `http://192.168.x.x` address the app still works and can still be added to the Home Screen, but the service worker never registers, so there is no offline start. Options:

- Put the app behind a reverse proxy with a real certificate (Nginx Proxy Manager, Caddy, Traefik, a Cloudflare Tunnel, or Tailscale `serve`), or
- Use a hostname with a certificate your devices trust. A self-signed certificate that the phone does not trust does not work.

## Reverse proxies must not cache `/sw.js`

The service worker script must always be fetched fresh, otherwise updates and the kill switch reach phones late.

- PokéCollector's own nginx sends `Cache-Control: no-cache` for `/sw.js`, `/sw.real.js` and `/sw.kill.js`. Keep any proxy in front of it from overriding that header.
- **Nginx Proxy Manager:** turn the **Cache Assets** option **off** for the PokéCollector proxy host. When it is on, NPM caches every path ending in `.js`, `.css` or an image extension (including `/sw.js`) for 30 minutes, ignores the app's `Cache-Control` and may serve a stale copy when the app is down.
- Other proxies (Caddy, Traefik, Cloudflare, Varnish, CDNs): do not add a cache rule or "cache everything" page rule that matches `/sw.js`.

## The two flags

Both are environment variables of the **frontend** container, read when it starts. Recreate the container after changing them (`docker compose up -d`). Unset or empty means the default, which is **on**: both features are enabled by default. Set `PWA_ENABLED=false` / `OFFLINE_QUEUE_ENABLED=false` to disable.

| Variable | Default | Effect |
|---|---|---|
| `PWA_ENABLED` | on | `true` (default) serves the real service worker at `/sw.js`; the app caches its own files and can start offline. `false` serves the kill worker, which removes any installed worker. |
| `OFFLINE_QUEUE_ENABLED` | on | `true` (default) turns on the upload hardening below, the cached sign-in, the logout protection, the sync center and the offline scan queue. `false` stops the queue; items already waiting stay on the device, so turn it on briefly to sync them before disabling. |

Accepted values: `true`, `1`, `yes`, `on`, `false`, `0`, `no`, `off` (any case). An invalid value logs a warning and uses the default.

## What the service worker does

- Saves the app's own files (`/assets/*`, icons, manifest) when it installs, then serves them from the device.
- Opens pages from the network first (2.5 seconds), and falls back to a saved copy of the app shell when the network is down. Without a saved shell it shows a short bilingual "you are offline" page.
- Saves public card, set and Pokédex images for faster loading (up to 800).
- **It caches no user data.** API calls, your collection, prices, photos you took and scan results are never stored by it.
- It never updates itself in the middle of your work. A bar offers **Update** when a new version is ready.

## Updating

A new release installs in the background while the old one keeps running. The bar "A new version is available." appears; tap **Update** to reload into the new version. If a scan upload is in progress the app asks you to finish first.

## Kill switch (if a release misbehaves)

You never need to clear site data. Three levels, from least to most effort:

1. **L1 – operator:** set `PWA_ENABLED=false` and recreate the frontend container. The next time a phone checks for an update (opening the app, or within 30 minutes of foregrounding it) the kill worker replaces the broken one, deletes its caches and unregisters itself.
2. **L2 – any user, one URL:** open `https://YOUR-ADDRESS/?pc_sw=off`. The page unregisters every worker, deletes the `pc-*` caches, removes the parameter and reloads. It leaves your queued data untouched.
3. **L3 – in-app reset:** a Reset button in the sync center arrives with the sync center in a later phase.

L2 and L3 do not depend on `/sw.js`, so they also work when a proxy cached a stale worker.

## Photo upload hardening

Safari on iOS has a bug where a photo chosen from the library can upload as an empty file. When `PWA_ENABLED` or `OFFLINE_QUEUE_ENABLED` is on, uploads (scanner photos, collection card photos, CSV and backup restore) are first copied into memory (files up to 8 MiB) or re-sliced (larger files) with the original filename kept. If a photo still arrives empty the server answers with an explicit error instead of saving it. With both flags off the upload code behaves exactly as before.

## Push notifications for price alerts

Wishlist price alerts can also arrive as a notification, next to Telegram.

1. Serve the app over HTTPS and set `PWA_ENABLED=true` (push needs the service worker).
2. On iPhone, install the app first: Share, then **Add to Home Screen**, and open it from the Home Screen icon. Safari tabs cannot receive push; Settings then shows a hint instead of buttons.
3. Open Settings, **Notifications**, and tap **Enable on this device**, then allow notifications. **Send test notification** checks that it works.

Each device is enabled separately. If notifications stop, tap **Disable** and **Enable** again. A subscription the phone has dropped is removed from the server automatically the next time it fails. The server keeps its signing key in `./data/auth` (see [DEPLOYMENT.md](DEPLOYMENT.md)); losing it only means turning notifications on again. Details: [BACKEND.md](BACKEND.md#web-push).

### Categories, daily digest and the icon number

Once a device is enabled, Settings › Notifications lists what to be notified about (per trainer, in `user_settings` as `notify_<category>`):

| Category | Default | When |
|---|---|---|
| Scans ready to review | on | right away, once per scan batch |
| Wishlist price alerts (your own thresholds) | on | right away |
| New sets | on | daily digest |
| Wishlist dips (at least 15 % below the 30-day average and at least €1 lower; a card at most once a week) | on | daily digest |
| Big movers in your collection (your price-alert percentage, default 10 %, and at least €2) | off | daily digest |

- **Daily digest:** at most one push a day, at **Daily digest time** (default 18:00) in the phone's time zone (the server's time zone until the app has checked in). It lists counts only, never prices.
- **Quiet hours** (22:00 to 08:00 local, on by default): an instant notification that falls inside waits until 08:00.
- **Icon number:** the number on the Home Screen icon is the scans waiting for review. The app updates it on start, when it returns to the foreground and when scans change; a scans-ready push sets it too (`app_badge` in the payload). It needs notification permission and iOS 16.4 or later, and does nothing where the Badging API is missing. Informational notifications are never counted.
- Telegram's new-sets message is now sent when a sync finds new sets (and `TELEGRAM_ENABLED=false` still silences it).

Server side: `services/notifications.py` (queue table `notification_queue`, flushed every 30 seconds by the scheduler).

## Opening the app offline (cached sign-in)

With `OFFLINE_QUEUE_ENABLED` on, the app remembers who was signed in (id, name, role, avatar; never the password or token) in this browser for up to 90 days. If the server cannot be reached when the app starts, it opens in a *degraded* state from that memory instead of the "Cannot reach PokéCollector" screen. The remembered user is only for display; the server checks every request. The app keeps retrying in the background and switches to normal as soon as the server answers. Without a remembered sign-in (first visit, after logout, expired, or a pending password change) the connection screen shows as before.

## Logging out with unsynced items

Log out is the last row of the **Profile** tab (multi-user mode). If items are waiting on this device, logging out asks what to do:

- **Sync first** sends them now. If anything is still waiting afterwards, you are asked again.
- **Log out and keep items** logs out and leaves them on the device, tied to your account and this server address. They are not shown to other accounts.
- **Log out and delete items** deletes the waiting items of your account from this device. Choose this on a shared device.
- **Cancel** stays signed in.

Sync before moving the app to a different address or port: waiting items belong to the old address.

## Offline card database

Settings › Data & sync › **Offline card database** keeps the card catalogue on the device: sets, series, cards (names, numbers, rarity, types, attacks, abilities) and the latest prices, for each language the server syncs. It is on by default on every device; each language has its own switch.

- **Server:** `GET /api/offline/carddb/manifest` lists, per language, a hash for the whole language, a hash and size per set and a separate **prices** hash (price syncs run often and never change a set's hash). `GET /api/offline/carddb/sets/{lang}/{set_id}` and `GET /api/offline/carddb/prices/{lang}` return gzip JSON with the hash as the ETag. Everything is built once, kept in memory and rebuilt after a card or price sync (and when the card count changes); no user data and no custom cards are included.
- **App:** a separate IndexedDB (`pokecollector-carddb`). When the app opens, when the connection returns and when it comes back to the foreground, the manifest is compared with the stored hashes and only changed sets (and the prices, if their hash changed) are fetched, two at a time. An interrupted download resumes from what is stored. The app asks the browser to keep the storage (`navigator.storage.persist()`).
- **Pictures** are optional and off by default: Settings › Data & sync › Card pictures, per language, with pause, resume, cancel and remove. They go in their own Cache Storage caches (`pc-carddb-images-v1-<lang>`), which the service worker's image route checks first. Pictures update only when you tap.
- **Switch off:** set `OFFLINE_CARD_DB_ENABLED=false` (default `true`) in the environment: the endpoints answer 404, the setting disappears and devices drop their copy at their next check.

## Sync center

With `OFFLINE_QUEUE_ENABLED` on, anything that waits on this device is visible:

- A small button in the navigation bar's trailing slot (top right) shows the state: *Offline mode*, *Waiting to sync*, *Syncing…* or *Needs attention*, with a count. It is hidden when nothing waits and the server answers. Tap it to open the sheet.
- The sheet lists each waiting item with its state and age. **Retry** puts a failed or blocked item back in line, **Discard** removes it after a confirmation (it has not reached the server and cannot be recovered). **Sync now** sends everything immediately, even with **Automatic sync** switched off; the switch only stops the background attempts.
- A status line under the navigation bar ("Offline mode", with "Showing saved data from …" when a saved copy is shown) appears when the server could not be reached twice in a row, or when the device says it is offline. The navigation bar and the tab bar stay visible. It is based on actually asking the server (`/api/health`), not on the phone's own online flag, and it disappears after the first successful answer. An open app notices a dead connection (iPhone Airplane Mode keeps the online flag true) in three ways: a request that fails without an answer triggers a check; a request still pending after about 5 seconds triggers a check too (the request is not cancelled, and a reachable but slow server never shows the banner, only failed checks do); and a pull to refresh runs its own health check and hands the result to the same monitor, so a failed or hanging check shows the banner at once and a passing one clears it at once. Otherwise the banner clears by itself within the monitor's retry delay (10 seconds at most). Every page of the app opens while it shows (see the saved-data section below).
- **/offline** is the full sync center: connection state, server version, the same item list, storage use, what this browser supports (HTTPS, service worker, storage, installed, push), the iPhone install hint and **Reset offline app data**. Reset removes cached app files and the saved copies of your data and keeps waiting items.

Items waiting here exist only on this device until they reach the server. The app asks the browser to protect its storage (`navigator.storage.persist()`), shows how much space is used, and keeps a marker so it can tell you when the browser deleted its offline data anyway ("Some offline data was removed by the browser…"). In a Safari tab (not the Home Screen app) it warns once an item is 3 days old, and more strongly after 7 days, because Safari can delete data of websites that were not opened for about a week. Sync items in the browser before adding the app to the Home Screen: the installed app has its own storage.

Not shown yet: *Edit* on queued adds (arrives with the collection/wishlist phase).

## What you can see offline

With `OFFLINE_QUEUE_ENABLED` on, the app keeps a copy of the data you have already looked at, so a degraded start (server unreachable) shows it instead of empty pages. Above the page it says *Showing saved data from <time ago>* while the server cannot be reached.

The same happens when the connection dies while the app is already open (iPhone Airplane Mode). Once per offline episode, when the offline banner comes up, the saved copy is merged back: queries this session already holds keep their data (restoring never overwrites newer data, and a saved copy older than the saved record never replaces it), the *Showing saved data* line appears, and fetches that can only hang (in flight, nothing to show yet) are cancelled, so a page shows its saved data, or its normal empty state, instead of an endless spinner. A page opened later in the same episode shows the saved data at once. When the server is back, the mounted pages refetch, replace the saved copies, and the line goes.

- **Which pages:** every page of the app. Whatever a page loaded successfully while you were online is saved (at most every 5 seconds), except a deny list in `offline/readCache.js` (`READ_CACHE_DENY`): invite links, the audit log, the admin user list, signed-in devices, the scanner configuration, push and Telegram data, single admin settings, live sync and scan-inbox state, and photo blobs. A query whose key names a secret, or whose data holds a field named like a token, password, secret or API key, is never saved. Saved pages you do not open again are kept until they are 30 days old.
- **Limits:** a single page of data over 15 MiB is skipped; the total stays under 50 MiB (the oldest data goes first); a copy older than 30 days, or saved by a different app version, is ignored. The service worker's cache of card pictures is unchanged (800 images).
- **Per user:** each account on this device and server address has its own copy, in a separate browser database from the waiting items. Signing in as someone else deletes every other account's copy.
- **Cleared at logout:** logging out (whatever you choose about waiting items; cancelling keeps you signed in) deletes your copy. **Reset offline app data** on /offline deletes every copy.
- **Read-only:** you can look, but changes still need the server. Offline, a request that changes something is refused at once with "Needs a connection. Try again when you're back online." (shown in the page's usual error message), never a spinner and never silently; what the outbox queues (scan uploads) keeps working.
- **A page you never opened** shows its normal empty page plus one line, "Not saved for offline yet. Open it once while online." Nothing is blocked: `offline/routes.js` has an empty exceptions list for a page that could not work at all offline.

## Scanning without a connection

With `OFFLINE_QUEUE_ENABLED` on, **Start scanning** never waits for the network. The photos are saved on the phone first; then:

- If the server is known to be reachable, the app tries to upload straight away and waits at most about 5 seconds. If that finishes you land on the scan as before. If it does not, the scanner closes with "Saved on this device. It will sync automatically." and the upload carries on in the background.
- If the server is not (yet) known to be reachable, the scanner closes at once with the same message and the photos upload when the server answers.
- Each upload is sent exactly once: it carries a key the server uses to ignore a repeat, so a lost response does not create a second scan.

Limits: 15 MB per photo, 12 photos or about 10 MB per waiting item (a bigger batch becomes several items, so several scan jobs), 50 photos per scan and 300 MB of waiting photos in total. If there is not enough space the scanner stays open with your photos and says so. The server's 14-day retention of scan photos starts when the upload arrives, not when you took the photo. HEIC/HEIF photos are stored and uploaded unchanged. While photos are staged or being saved, the "new version available" banner will not reload the page.

## Limitations

- The first visit must happen online; there is nothing to start from before that.
- Plain `http://` addresses never get a service worker (see HTTPS above).
- iOS can remove stored website data after a long period of non-use; the app then behaves like a first visit.
- Safari Lockdown Mode disables service workers. The app keeps working online.
- Offline start shows the app shell; data you viewed earlier is shown from a saved copy (see What you can see offline); anything you never opened is not available.

## Privacy

The service worker caches no user data. It stores the app's public static files and public card images only. The saved copy of your viewed data (above) is kept by the app itself, per user, and deleted at logout. Per-user information stays in the places it already lived in.

## For developers

See [`FRONTEND.md`](FRONTEND.md) (service-worker build, tests, file map) and [`DEPLOYMENT.md`](DEPLOYMENT.md) (headers, entrypoint order, rollback).
