const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { Server } = require("socket.io");
const { SOCKET_IO_PATH, attachRoomSocketHandlers, getRoomServiceHealth } = require("./room-service");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 3000;
const STATIC_ROOT = __dirname;

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(message);
}

function maybeServeStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(STATIC_ROOT, safePath);
  const normalizedRoot = path.resolve(STATIC_ROOT);
  const normalizedPath = path.resolve(filePath);

  if (!normalizedPath.startsWith(normalizedRoot)) {
    sendText(res, 403, "Forbidden");
    return true;
  }

  if (!fs.existsSync(normalizedPath) || fs.statSync(normalizedPath).isDirectory()) {
    return false;
  }

  const ext = path.extname(normalizedPath).toLowerCase();
  const shouldBypassCache = ext === ".html" || ext === ".js" || ext === ".css";
  const headers = {
    "Content-Type": contentTypes[ext] || "application/octet-stream",
    "Cache-Control": shouldBypassCache ? "no-store" : "public, max-age=3600",
  };

  if (shouldBypassCache) {
    headers.Pragma = "no-cache";
    headers.Expires = "0";
  }

  res.writeHead(200, headers);
  fs.createReadStream(normalizedPath).pipe(res);
  return true;
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const { pathname } = url;

    if (pathname.startsWith(SOCKET_IO_PATH)) {
      return;
    }

    if (req.method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, getRoomServiceHealth());
      return;
    }

    if (req.method === "GET" && maybeServeStatic(res, pathname)) {
      return;
    }

    if (req.method === "GET" && maybeServeStatic(res, "/index.html")) {
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found." });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { ok: false, error: error.message || "Unexpected server error." });
  }
});

const io = new Server(server, {
  path: SOCKET_IO_PATH,
  cors: {
    origin: true,
    credentials: true,
  },
  serveClient: false,
});

attachRoomSocketHandlers(io);

server.listen(PORT, HOST, () => {
  console.log(`Sudoku room server listening on http://${HOST}:${PORT}`);
});
