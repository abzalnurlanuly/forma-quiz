import { createApp } from "./app.js";

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer between 1 and 65535.");
const app = createApp();
const server = app.listen(port, host, () =>
  console.log(`Forma listening on ${host}:${port}`),
);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
function shutdown() {
  app.locals.closeLive();
  server.close(() => {
    app.locals.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
