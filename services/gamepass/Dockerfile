# GamePass backend — Node + Prisma, deployable to Fly.io (or any Docker host).
FROM node:20-slim AS build
WORKDIR /app
# OpenSSL is required by Prisma engines on slim images.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY package*.json ./
# Keep the Prisma CLI in the runtime image so Fly release commands never need
# to download tooling from the network before applying the database schema.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
EXPOSE 3001
CMD ["node", "dist/index.js"]
