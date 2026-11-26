# Railway deployment: the whole of baizakisaev.com, served by Caddy.
#
# Stage 1 puts the site together with tools/assemble.py: this repository's pages and shared files,
# plus each project's pages from projects/ (copied from their own repositories by
# tools/sync_projects.py). It also stamps this build into file addresses (style.css?v=…) and the
# offline cache name, so every deploy is fetched fresh by browsers and Cloudflare instead of mixing
# new pages with old cached files.
FROM python:3.12-alpine AS site
WORKDIR /repo
COPY . .
RUN python tools/assemble.py build /srv --stamp "$(date -u +%Y%m%d%H%M%S)"

# Stage 2 serves it. Tools, tests and sources stay out of the image: only /srv is copied.
FROM caddy:2.8-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=site /srv /srv
# Fail the build, not the live site, if the server configuration is invalid.
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
