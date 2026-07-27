# Imagem única para o app e para o worker: os dois compartilham src/ e
# node_modules, mudando apenas o `command` no compose.

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app


# ── Dependências ─────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci


# ── Build do Next ────────────────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `standalone` gera .next/standalone com só o necessário para servir.
ENV BUILD_STANDALONE=1
ENV NEXT_TELEMETRY_DISABLED=1

# O build não deve exigir segredos reais: src/env.ts valida sob demanda, não na
# importação. Estes valores existem só para satisfazer checagens de build.
ENV SKIP_ENV_VALIDATION=1

RUN npm run build


# ── Runtime ──────────────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 mandafy \
 && adduser  --system --uid 1001 --ingroup mandafy mandafy

# Servidor do Next (standalone traz seu próprio node_modules mínimo).
COPY --from=builder --chown=mandafy:mandafy /app/.next/standalone ./
COPY --from=builder --chown=mandafy:mandafy /app/.next/static ./.next/static

# O worker e as migrations rodam TypeScript direto com tsx, então precisam do
# código-fonte, do SQL e das dependências completas.
COPY --from=builder --chown=mandafy:mandafy /app/node_modules ./node_modules
COPY --from=builder --chown=mandafy:mandafy /app/src ./src
COPY --from=builder --chown=mandafy:mandafy /app/drizzle ./drizzle
COPY --from=builder --chown=mandafy:mandafy /app/package.json ./package.json
COPY --from=builder --chown=mandafy:mandafy /app/tsconfig.json ./tsconfig.json

USER mandafy

ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
