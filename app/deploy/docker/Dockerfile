# The web WMS in one container: Node.js and the built single page app. Data (SQLite database,
# uploaded files) in /data, which compose.yaml mounts from the host. Build context: the repository.
FROM node:24-slim
WORKDIR /srv
COPY assets ./assets
COPY src/icons ./src/icons
COPY app ./app
WORKDIR /srv/app
RUN node build.mjs && mkdir -p /data/files && chown -R node:node /data
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 TRUST_PROXY=1 \
    DB_PATH=/data/fully-app.sqlite FILES_DRIVER=disk FILES_DIR=/data/files
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Migrations first (an update brings them), then the server.
CMD ["sh", "-c", "node server/migrate.mjs && exec node server/index.mjs"]
