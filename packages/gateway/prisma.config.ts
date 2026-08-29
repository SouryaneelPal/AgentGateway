/**
 * Prisma 7 configuration.
 *
 * Prisma 7 removed `url` from the datasource block in schema.prisma. The connection
 * string used by Migrate now lives here, and the runtime PrismaClient takes a driver
 * adapter instead (see src/db/prisma-client.ts).
 *
 * Run migrations through the workspace so this file is picked up:
 *   npm run db:migrate --workspace=gateway
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../.env'), quiet: true });

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === '') {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env at the repo root and fill it in.',
  );
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: databaseUrl,
  },
});
