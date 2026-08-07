FROM node:20-slim

WORKDIR /app

# better-sqlite3 is a native module. It ships prebuilt binaries for most
# platforms, but installing a toolchain guarantees the build still succeeds
# on whatever platform this image ends up running on.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# SQLite DB + downloaded media live here — mount this as a volume so they
# survive container restarts/redeploys.
RUN mkdir -p /app/data/media
VOLUME ["/app/data"]

EXPOSE 8787
CMD ["node", "server.js"]
