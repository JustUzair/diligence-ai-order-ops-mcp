import { buildApp } from "./server.js";

const port = Number(process.env.PORT ?? 3000);
const app = buildApp();

const httpServer = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[order-ops-mcp] listening on :${port} (POST /mcp, GET /health)`);
});

function shutdown(signal: string): void {
  // eslint-disable-next-line no-console
  console.log(`[order-ops-mcp] received ${signal}, shutting down`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
