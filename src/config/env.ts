import "dotenv/config";
import { z } from "zod";

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_HOSTNAME: optionalTrimmedString,
  MCP_BEARER_TOKEN: optionalTrimmedString,
});

export const env = envSchema.parse(process.env);

export type Env = z.infer<typeof envSchema>;
