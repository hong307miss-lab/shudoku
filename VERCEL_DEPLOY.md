# Vercel Deploy

## What this setup does

- Frontend pages are served by Vercel static hosting.
- The room server runs from `api/socket-io.js`.
- The Socket.IO client path is `/api/socket-io.js`.
- Healthcheck is available at `/api/health.js`.

## Before deploy

1. Push this repo to GitHub.
2. Make sure `vendor/socket.io.min.js` is committed.
3. Leave `config.js` as-is for same-origin Vercel deploy.

## Deploy

1. In Vercel, create a new project from this repo.
2. Keep the root directory as the repo root.
3. Framework preset can stay `Other`.
4. Deploy.

## After deploy

1. Open `https://<your-vercel-domain>/api/health.js`
2. It should return JSON like:

```json
{"ok":true,"rooms":0,"sockets":0}
```

3. Open the site homepage.
4. Create a room in one browser.
5. Join it from another browser.

## Important note

- This version keeps room state in function memory.
- It is good for initial testing and low traffic.
- If you later want stronger persistence across cold starts or multiple instances, the next upgrade is Redis.
