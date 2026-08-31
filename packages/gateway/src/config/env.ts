/**
 * Environment configuration module (Phase 1 deliverable).
 *
 * Loads the repo-root .env when running on the host, then validates the result.
 * In Docker there is no .env file — Compose injects the variables directly and the
 * dotenv call is a harmless no-op. dotenv never overrides an already-set variable,
 * so the container's values always win.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
// packages/gateway/src/config -> repo root
const repoRoot = resolve(here, '../../../..');

loadDotenv({ path: resolve(repoRoot, '.env'), quiet: true });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  RAZORPAY_KEY_ID: z.string().min(1, 'RAZORPAY_KEY_ID is required (test mode)'),
  RAZORPAY_KEY_SECRET: z.string().min(1, 'RAZORPAY_KEY_SECRET is required (test mode)'),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1, 'RAZORPAY_WEBHOOK_SECRET is required'),

  // Phase 4.5 — AES-256-GCM master key for merchants.razorpay_key_secret_encrypted.
  // Base64 of 32 random bytes. Generate with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  MERCHANT_SECRET_ENCRYPTION_KEY: z
    .string()
    .min(1, 'MERCHANT_SECRET_ENCRYPTION_KEY is required (base64 of 32 bytes)'),

  // Phase 4.5 — rate limiting. Configurable rather than hardcoded so a load test or a
  // demo can raise them without a code change.
  RATE_LIMIT_MERCHANT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_MERCHANT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_AGENT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_AGENT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
});

export type Env = Readonly<z.infer<typeof EnvSchema>>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${details}\n\nCopy .env.example to .env and fill in the values.`,
    );
  }

  return Object.freeze(parsed.data);
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const repoRootPath = repoRoot;
