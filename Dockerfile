# 单镜像：后端 + 已构建的前端，一个端口对外
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN corepack enable && pnpm install --no-frozen-lockfile --config.strictDepBuilds=false
COPY . .
RUN pnpm --filter @deepmv/web build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV DEEPMV_MODE=public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/package.json ./
WORKDIR /app/server
EXPOSE 7821
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:7821/api/health || exit 1
CMD ["npx", "tsx", "src/index.ts"]
