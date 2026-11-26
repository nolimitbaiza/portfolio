#!/usr/bin/env bash
# Smoke test of the built site: the addresses the live site must answer, with the right status,
# content, headers and caching. Run it against the production image (see .github/workflows):
#   docker build -t site . && docker run -d --name site -p 8080:8080 site
#   bash tools/smoke_test.sh [http://localhost:8080]
# Exits non-zero at the first failure.
set -euo pipefail
BASE="${1:-http://localhost:8080}"
cd "$(mktemp -d)"   # body.txt is written here, not into the repository
expect() {   # expect <status> <path> [text the page must contain]
  status=$(curl -s -o body.txt -w "%{http_code}" "$BASE$2")
  if [ "$status" != "$1" ]; then echo "FAIL $2: status $status, expected $1"; exit 1; fi
  if [ -n "${3:-}" ] && ! grep -q "${3:-}" body.txt; then echo "FAIL $2: page lacks '${3:-}'"; exit 1; fi
  echo "ok   $2 -> $status"
}
expect 200 /                    "About me"
expect 200 /ai-grid-trader      "chart-main"
expect 200 /ai-grid-trader-case-study "Perfect hindsight"
expect 200 /pitwall-case-study  "Who built what"
expect 200 /pitwall/            "Pitwall"
expect 301 /pitwall
expect 200 /pitwall/data.json   "constructors"
expect 200 /pitwall/app.js      "seasonStats"
expect 404 /pitwall/api/data
expect 200 /assets/Baizak-Isaev-Resume.pdf "%PDF"
expect 200 /battery-wear-cost   "Does the agent need to know"
expect 200 /perfect-hindsight-benchmark "What a worse forecast costs"
expect 200 /assets/video/demo-loop.webm "webm"
expect 200 /assets/video/pitwall-loop.webm "webm"
curl -sI $BASE/assets/video/demo-loop.webm | grep -qi "content-type: video/webm" \
  || { echo "FAIL demo loop is not served as video/webm"; exit 1; }
expect 301 /about.html
expect 301 /ai-grid-trader.html
expect 301 /pitwall-case-study.html
expect 200 /robots.txt          "Sitemap"
expect 200 /sitemap.xml         "ai-grid-trader"
expect 200 /sitemap.xml         "pitwall-case-study"
expect 200 /sitemap.xml         "pitwall/"
expect 404 /no-such-page        "Page not found"
# Every build stamp was filled in, and the security headers are sent.
if curl -s $BASE/ | grep -q "__BUILD__"; then echo "FAIL: unfilled build stamp"; exit 1; fi
curl -sI $BASE/ | grep -qi "x-content-type-options: nosniff" || { echo "FAIL: security headers missing"; exit 1; }
echo "ok   build stamps and security headers"
# Caching: pages and unstamped files are re-checked; build-stamped files and fonts keep a year.
cache() {   # cache <path> <expected Cache-Control>
  got=$(curl -sI "$BASE$1" | tr -d '\r' | grep -i "^cache-control:" | cut -d' ' -f2-)
  if [ "$got" != "$2" ]; then echo "FAIL cache $1: '$got', expected '$2'"; exit 1; fi
  echo "ok   cache $1 -> $got"
}
cache "/"                                   "no-cache"
cache "/ai-grid-trader-case-study"          "no-cache"
cache "/?v=1"                               "no-cache"
cache "/sw.js"                              "no-cache"
cache "/pitwall/data.json"                  "no-cache"
cache "/assets/style.css"                   "no-cache"
cache "/assets/style.css?v=1"               "public, max-age=31536000, immutable"
cache "/assets/img/project-chart-phone.webp?v=1"  "public, max-age=31536000, immutable"
cache "/assets/fonts/inter-latin-var.woff2" "public, max-age=31536000, immutable"
cache "/assets/vendor/plotly-basic-2.35.2.min.js" "public, max-age=31536000, immutable"
expect 200 /assets/img/project-chart-phone.webp "WEBP"
curl -sI $BASE/assets/img/project-chart-phone.webp | grep -qi "content-type: image/webp" \
  || { echo "FAIL screenshots are not served as image/webp"; exit 1; }
echo "All smoke checks passed."
