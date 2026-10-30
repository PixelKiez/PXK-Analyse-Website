# 360°Pixelkiez – Build-Artefakt für Railway: Caddy (fester Digest) plus die versionierten Dateien aus public/.
# Build-Kontext ist das Repository; .dockerignore lässt nur public/ (ohne Medien) und das Caddyfile durch.
FROM caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b
COPY deploy/railway/Caddyfile /etc/caddy/Caddyfile
COPY --chown=root:root public/ /srv/
USER nobody
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
