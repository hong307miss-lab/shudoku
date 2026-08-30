const http = require("node:http");
const { Server } = require("socket.io");
const { SOCKET_IO_PATH, attachRoomSocketHandlers } = require("../room-service");

function createSocketServer() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end("Sudoku Socket.IO endpoint");
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
  return server;
}

module.exports = globalThis.__SUDOKU_VERCEL_SOCKET_SERVER__ || (
  globalThis.__SUDOKU_VERCEL_SOCKET_SERVER__ = createSocketServer()
);
