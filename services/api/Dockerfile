FROM node:22-bookworm-slim AS build
WORKDIR /app/services/api
COPY services/api/package.json services/api/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY services/api/tsconfig.json services/api/tsconfig.build.json ./
COPY services/api/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app/services/api
ENV NODE_ENV=production REPO_ROOT=/app PORT=4000
COPY --from=build /app/services/api/node_modules ./node_modules
COPY --from=build /app/services/api/dist ./dist
COPY services/api/package.json ./
COPY services/api/mappings ./mappings
COPY db /app/db
COPY data/geo /app/data/geo
EXPOSE 4000
CMD ["node", "dist/main.js"]
