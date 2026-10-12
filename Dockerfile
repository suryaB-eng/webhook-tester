FROM node:22.14.0-alpine

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --no-audit --no-fund

COPY tsconfig.base.json ./
COPY apps ./apps
RUN npm run build
# Vite loads its preview configuration into this writable temporary directory.
RUN mkdir -p /app/apps/web/node_modules/.vite-temp && chown -R node:node /app/apps/web/node_modules

USER node
CMD ["npm", "run", "start", "-w", "@webhook-tester/api"]
