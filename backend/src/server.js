const http = require("http");

const app = require("./app");
const { port } = require("./config/env");
const { initializeSocketServer } = require("./realtime/socketServer");

const server = http.createServer(app);

initializeSocketServer(server);

server.listen(port, () => {
  console.log(`Backend server running on port ${port}`);
});
