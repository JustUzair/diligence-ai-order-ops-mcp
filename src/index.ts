import { buildApp } from "./server.js";
import { disconnectPrismaClient } from "./data/database.js";
import { env } from "./config/env.js";
import {
  SERVICE_NAME,
  SHUTDOWN_GRACE_PERIOD_MS,
} from "./constants.js";

const port = env.PORT;
const app = await buildApp();

const httpServer = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[${SERVICE_NAME}] listening on :${port} (POST /mcp, GET /health)`);
});

function shutdown(signal: string): void {
  // eslint-disable-next-line no-console
  console.log(`[order-ops-mcp] received ${signal}, shutting down`);
  httpServer.close(async () => {
    await disconnectPrismaClient();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), SHUTDOWN_GRACE_PERIOD_MS).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
