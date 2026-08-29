/**
 * PostgreSQL access via Prisma (§2.1 State Layer).
 *
 * A single client instance is shared process-wide — the pg pool behind the driver
 * adapter is shared with it, and the row-locked spend-cap transaction in §3.5 depends
 * on that being true.
 *
 * Prisma 7 no longer reads the connection URL from schema.prisma. The runtime client
 * takes a driver adapter (here node-postgres); Migrate reads its URL from
 * prisma.config.ts. Both ultimately come from DATABASE_URL.
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/index.js';
import { env } from '../config/env.js';

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

export interface DependencyCheck {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

/**
 * Liveness probe for /health. Uses a raw query rather than a model read so it stays
 * meaningful before any migration has been applied.
 */
export async function checkDatabase(): Promise<DependencyCheck> {
  const startedAt = performance.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
