# ---------- build web ----------
FROM node:20-alpine AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------- build server ----------
FROM node:20-alpine AS build
WORKDIR /build/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8443

COPY --from=build /build/server/node_modules ./node_modules
COPY --from=build /build/server/dist ./dist
COPY --from=web /build/web/dist ./public

USER node
EXPOSE 8443
CMD ["node", "dist/index.js"]
