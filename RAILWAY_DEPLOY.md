# Railway Deploy

## 1. Deploy the room server

1. Push this repo to GitHub.
2. In Railway, create a new project from the GitHub repo.
3. Select the repo root as the service root.
4. Railway should detect `package.json` and run `npm start`.
5. After deploy, open the generated public domain.
6. Confirm healthcheck works:
   - `https://<your-railway-domain>/api/health`

## 2. Point Netlify to Railway

Edit [config.js](./config.js) and set:

```js
window.SUDOKU_RUNTIME_CONFIG = Object.assign(
  {
    roomServerUrl: "https://<your-railway-domain>",
  },
  window.SUDOKU_RUNTIME_CONFIG || {},
);
```

Then redeploy Netlify.

## 3. Verify

1. Open the Netlify site.
2. Create a room in one browser.
3. Join the same room in another browser.
4. Confirm board state sync works.
5. Confirm invite links open the Netlify site, not the Railway domain.

## Notes

- Keep the frontend on Netlify.
- Keep the room server on Railway.
- The Railway server builds invite links using the Netlify host sent by the frontend.
