/** Runtime configuration shared by the HTTP adapter, tools, and seed data. */
export const SERVICE_NAME = "order-ops-mcp";
export const SERVICE_VERSION = "0.1.0";

export const DEFAULT_PORT = 3000;
export const SHUTDOWN_GRACE_PERIOD_MS = 5_000;
export const MILLISECONDS_PER_MINUTE = 60_000;

export const LOCAL_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0"] as const;
