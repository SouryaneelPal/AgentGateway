# Where the migrations actually live

Prisma requires its migration history to sit next to `schema.prisma`, so the real
SQL migrations are in:

    packages/gateway/prisma/migrations/

This directory exists because it appears in the agreed monorepo layout, and is kept
as the home for any **hand-written, non-Prisma SQL** — the append-only `audit_log`
grant changes described in §2.3, for example, which Prisma cannot express.

The six `CHECK` constraints from WHITEPAPER.md §2.3 are _not_ here: they are appended
directly to the initial Prisma migration so that `prisma migrate dev` applies them
along with the tables. See the bottom of `prisma/migrations/*_init/migration.sql`.
