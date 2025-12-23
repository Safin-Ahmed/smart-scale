# Build Stage

FROM node:20-alpine AS build

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace files
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY services/checkout/package.json services/checkout/tsconfig.json ./services/checkout/
COPY services/checkout/src ./services/checkout/src 

# Install only checkout deps
RUN pnpm install --filter checkout --frozen-lockfile 

# Build checkout
RUN pnpm --filter checkout run build

# Runtime Stage
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# ENABLE pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace files
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY services/checkout/package.json ./services/checkout/

# Install production deps in the runtime image using a flat layout
# so Node's require resolution works correctly with pnpm workspaces.
# `--shamefully-hoist` creates a traditional node_modules layout.
RUN pnpm install --filter checkout --prod --frozen-lockfile --shamefully-hoist

# Copy Built output
COPY --from=build /app/services/checkout/dist ./dist

EXPOSE 8080

CMD ["node", "dist/server.js"]
