# AgentGateway gateway service.
# Dev-oriented image: runs TypeScript directly through tsx so the container and the
# host `npm run dev` execute identical source. Production hardening is Phase 6 scope.
FROM node:22-alpine

# Prisma's query engine needs openssl on alpine.
RUN apk add --no-cache openssl

WORKDIR /app

# Install deps first so edits to src/ don't bust the dependency layer.
COPY package.json ./
COPY packages/gateway/package.json ./packages/gateway/package.json
RUN npm install --workspace=packages/gateway --include-workspace-root --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages/gateway ./packages/gateway

# Generate the Prisma client against the schema (no DB connection required).
RUN npx prisma generate --schema=packages/gateway/prisma/schema.prisma

ENV NODE_ENV=development
ENV PORT=3001
EXPOSE 3001

CMD ["npx", "tsx", "packages/gateway/src/server.ts"]
