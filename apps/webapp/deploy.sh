#!/usr/bin/env bash
# Build the webapp and publish it to the Cloud Storage bucket served by Cloud CDN.
# Run after infra/setup-cdn.sh has provisioned the bucket + load balancer.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Load deploy config (GCP_PROJECT, BUCKET, URLMAP, ...).
set -a
# shellcheck source=/dev/null
source "$SCRIPT_DIR/.env.deploy"
set +a

P=(--project "$GCP_PROJECT")

echo "==> Building webapp..."
pnpm --filter @expenser/webapp build

echo "==> Syncing dist/ -> gs://$BUCKET"
gcloud storage rsync "$SCRIPT_DIR/dist" "gs://$BUCKET" "${P[@]}" \
  --recursive --delete-unmatched-destination-objects

echo "==> Setting cache headers"
# Default: everything is immutable (Astro fingerprints assets in _astro/).
gcloud storage objects update "gs://$BUCKET/**" "${P[@]}" \
  --cache-control="public, max-age=31536000, immutable"
# Re-validate the shell + PWA control files on every request so updates roll out.
gcloud storage objects update "${P[@]}" --cache-control="no-cache" \
  "gs://$BUCKET/**.html" \
  "gs://$BUCKET/sw.js" \
  "gs://$BUCKET/manifest.webmanifest" \
  "gs://$BUCKET/workbox-*.js"

echo "==> Invalidating CDN cache"
gcloud compute url-maps invalidate-cdn-cache "$URLMAP" "${P[@]}" \
  --global --path "/*" --async

echo "Done. Served at https://$DOMAIN"
