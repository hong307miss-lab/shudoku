# Railway Deploy

Shudoku production now runs from a single Railway service. `server.js` serves the static pages, JSON APIs, and Socket.IO room service from the same origin.

## 1. Deploy

1. Push this repo to GitHub.
2. Connect the repo root to Railway and enable Auto Deploy for `main`.
3. Railway should detect `package.json` and run `npm start`.
4. After deploy, open the generated public domain or bound custom domain.

## 2. Verify

1. Confirm healthcheck works:
   - `https://<your-domain>/api/health`
2. Open the homepage.
3. Create a multiplayer room in one browser.
4. Join the same room from another browser.
5. Confirm board state sync, invite links, and ranked leaderboard requests all stay on the same origin.

## 3. Custom Domain

- `config.js` now defaults production traffic to `window.location.origin`, so `https://sudoku.kalis-sweetsecret.com` can point to the same Railway service without changing frontend API or WebSocket URLs.
- Keep all frontend assets on relative paths such as `./app.js` and `./styles.css` for Discord Activity compatibility.

## Notes

- Socket.IO still uses the compatibility path `/api/socket-io.js`.
- The committed `api/socket-io.js` and `api/health.js` files are retained for compatibility review, but Railway production traffic is handled by `server.js`.
- Room state and ranked leaderboard data are still stored in process memory and will reset if the Railway instance restarts.
