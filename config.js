const isLocalPreviewHost = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
const localRoomServerUrl = isLocalPreviewHost
  ? window.location.port === "3100"
    ? window.location.origin
    : `${window.location.protocol}//${window.location.hostname}:3100`
  : window.location.origin;

window.SUDOKU_RUNTIME_CONFIG = Object.assign(
  {
    roomServerUrl: localRoomServerUrl,
  },
  window.SUDOKU_RUNTIME_CONFIG || {},
);
