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

Both are environment variables of the **frontend** container, read when it starts. Recreate the container after changing them (`docker compose up -d`). Empty means the default, which is off.

| Variable | Default | Effect |
|---|---|---|
| `PWA_ENABLED` | off | `true` serves the real service worker at `/sw.js`; the app caches its own files and can start offline. `false` serves the kill worker, which removes any installed worker. |
| `OFFLINE_QUEUE_ENABLED` | off | Turns on the upload hardening below, the cached sign-in and the logout protection described next. The offline scan queue itself arrives in later phases. |

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

## Opening the app offline (cached sign-in)

With `OFFLINE_QUEUE_ENABLED` on, the app remembers who was signed in (id, name, role, avatar; never the password or token) in this browser for up to 90 days. If the server cannot be reached when the app starts, it opens in a *degraded* state from that memory instead of the "Cannot reach PokéCollector" screen. The remembered user is only for display; the server checks every request. The app keeps retrying in the background and switches to normal as soon as the server answers. Without a remembered sign-in (first visit, after logout, expired, or a pending password change) the connection screen shows as before.

## Logging out with unsynced items

If items are waiting on this device, logging out asks what to do:

- **Sync first** sends them now. If anything is still waiting afterwards, you are asked again.
- **Log out and keep items** logs out and leaves them on the device, tied to your account and this server address. They are not shown to other accounts.
- **Log out and delete items** deletes the waiting items of your account from this device. Choose this on a shared device.
- **Cancel** stays signed in.

Sync before moving the app to a different address or port: waiting items belong to the old address.

## Limitations

- The first visit must happen online; there is nothing to start from before that.
- Plain `http://` addresses never get a service worker (see HTTPS above).
- iOS can remove stored website data after a long period of non-use; the app then behaves like a first visit.
- Safari Lockdown Mode disables service workers. The app keeps working online.
- Offline start shows the app shell; data is shown only while the server is reachable until the later caching phases ship.

## Privacy

The service worker caches no user data. It stores the app's public static files and public card images only. Per-user information stays in the places it already lived in.

## For developers

See [`FRONTEND.md`](FRONTEND.md) (service-worker build, tests, file map) and [`DEPLOYMENT.md`](DEPLOYMENT.md) (headers, entrypoint order, rollback).
