# DeepMV 生产镜像：编译后的后端 + 构建好的前端，单端口对外
#
# 用编译产物（node dist/index.js）而不是 tsx 直跑：
# 免费档机器通常只有 512MB 内存，tsx 要额外拉起 esbuild，白占 100MB 左右。

FROM node:20-alpine AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --no-frozen-lockfile --config.strictDepBuilds=false

COPY . .
RUN pnpm --filter @deepmv/web build \
 && cd server && npx tsc -p tsconfig.build.json

FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV DEEPMV_MODE=public
ENV PORT=7821

# 运行期只要生产依赖，devDependencies 全部丢掉
COPY package.json pnpm-workspace.yaml ./
COPY server/package.json server/
RUN corepack enable \
 && pnpm install --prod --no-frozen-lockfile --config.strictDepBuilds=false \
 && pnpm store prune

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/rules ./server/rules
COPY --from=build /app/web/dist ./web/dist

RUN addgroup -S deepmv && adduser -S deepmv -G deepmv \
 && mkdir -p server/share server/data \
 && chown -R deepmv:deepmv /app
USER deepmv

WORKDIR /app/server
EXPOSE 7821

# 端口由平台注入，健康检查跟着 PORT 走，别写死
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-7821}/api/health" || exit 1

CMD ["node", "dist/index.js"]