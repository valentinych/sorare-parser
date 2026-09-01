FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public-tm ./public-tm
COPY data/scout-md1-ek.json ./data/scout-md1-ek.json

RUN npx playwright install --with-deps chromium

ENV NODE_ENV=production \
    TM_PORT=3081 \
    HOST=0.0.0.0 \
    EXPECTED11_HEADLESS=1

EXPOSE 3081

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:3081/api/health',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["npx", "tsx", "src/tm-server.ts"]
