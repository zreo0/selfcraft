FROM oven/bun:1.3.8

WORKDIR /opt/selfcraft

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run typecheck && bun test && bun run doctor

COPY docker/entrypoint.sh /usr/local/bin/selfcraft-entrypoint
RUN chmod +x /usr/local/bin/selfcraft-entrypoint

ENV SELFCRAFT_ENV=production
ENV SELFCRAFT_HOME=/var/lib/selfcraft

VOLUME ["/app", "/var/lib/selfcraft"]
ENTRYPOINT ["/usr/local/bin/selfcraft-entrypoint"]
