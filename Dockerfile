FROM oven/bun:1.3.8

WORKDIR /opt/selfcraft

COPY package.json bun.lock ./
COPY web/package.json ./web/package.json
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build:web && bun run typecheck && bun test && bun run doctor

COPY docker/entrypoint.sh /usr/local/bin/selfcraft-entrypoint
RUN chmod +x /usr/local/bin/selfcraft-entrypoint

ENV SELFCRAFT_ENV=production
ENV SELFCRAFT_HOME=/var/lib/selfcraft
ENV SELFCRAFT_WEB_HOST=0.0.0.0
ENV SELFCRAFT_WEB_PORT=3210

EXPOSE 3210

VOLUME ["/app", "/var/lib/selfcraft"]
ENTRYPOINT ["/usr/local/bin/selfcraft-entrypoint"]
