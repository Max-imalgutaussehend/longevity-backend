FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable pnpm

FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm typecheck && pnpm build

FROM node:22-alpine AS runner
WORKDIR /app
RUN corepack enable pnpm && addgroup -S app && adduser -S app -G app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
USER app
EXPOSE 3000
CMD ["node", "dist/index.js"]
