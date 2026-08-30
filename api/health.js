const { getRoomServiceHealth } = require("../room-service");

module.exports = (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(getRoomServiceHealth());
};
