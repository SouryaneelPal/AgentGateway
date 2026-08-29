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
