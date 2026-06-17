#!/usr/bin/env bash
# One-time provisioning of the static-site infrastructure on GCP:
#   Cloud Storage bucket -> backend bucket (Cloud CDN) -> external HTTPS Load Balancer
#   -> Google-managed SSL cert -> global static IP, plus an HTTP->HTTPS redirect.
#
# Idempotent: re-running skips resources that already exist. After this completes,
# point the DNS A record at the printed static IP, then run ../deploy.sh to upload files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load deploy config (GCP_PROJECT, GCP_REGION, DOMAIN, BUCKET, resource names).
set -a
# shellcheck source=/dev/null
source "$WEBAPP_DIR/.env.deploy"
set +a

P=(--project "$GCP_PROJECT")

# Run a gcloud "create" command, treating "already exists" as success.
create() {
  if "$@" 2>/tmp/gcloud_err; then
    return 0
  fi
  if grep -qiE 'already exists|alreadyExists|already own it|HTTPError 409' /tmp/gcloud_err; then
    echo "  (already exists, skipping)"
    return 0
  fi
  cat /tmp/gcloud_err >&2
  return 1
}

echo "==> 1. Storage bucket gs://$BUCKET"
create gcloud storage buckets create "gs://$BUCKET" "${P[@]}" \
  --location "$GCP_REGION" --uniform-bucket-level-access
# Configure static website behavior (index + custom 404) and public read.
gcloud storage buckets update "gs://$BUCKET" "${P[@]}" \
  --web-main-page-suffix=index.html --web-error-page=404.html
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" "${P[@]}" \
  --member=allUsers --role=roles/storage.objectViewer >/dev/null

echo "==> 2. Global static IP $IP_NAME"
create gcloud compute addresses create "$IP_NAME" "${P[@]}" --global
IP_ADDR="$(gcloud compute addresses describe "$IP_NAME" "${P[@]}" --global --format='value(address)')"

echo "==> 3. Managed SSL certificate $CERT_NAME for $DOMAIN"
create gcloud compute ssl-certificates create "$CERT_NAME" "${P[@]}" \
  --global --domains "$DOMAIN"

echo "==> 4. Backend bucket $BACKEND_BUCKET (Cloud CDN enabled)"
create gcloud compute backend-buckets create "$BACKEND_BUCKET" "${P[@]}" \
  --gcs-bucket-name "$BUCKET" --enable-cdn

echo "==> 5. URL map $URLMAP -> backend bucket"
create gcloud compute url-maps create "$URLMAP" "${P[@]}" \
  --default-backend-bucket "$BACKEND_BUCKET"

echo "==> 6. Target HTTPS proxy $HTTPS_PROXY_NAME"
create gcloud compute target-https-proxies create "$HTTPS_PROXY_NAME" "${P[@]}" \
  --url-map "$URLMAP" --ssl-certificates "$CERT_NAME"

echo "==> 7. HTTPS forwarding rule $FR_HTTPS (:443)"
create gcloud compute forwarding-rules create "$FR_HTTPS" "${P[@]}" \
  --global --address "$IP_NAME" --target-https-proxy "$HTTPS_PROXY_NAME" --ports 443

echo "==> 8. HTTP->HTTPS redirect (:80)"
create gcloud compute url-maps import "$REDIRECT_URLMAP" "${P[@]}" --global --source=- <<EOF
name: $REDIRECT_URLMAP
defaultUrlRedirect:
  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT
  httpsRedirect: true
EOF
create gcloud compute target-http-proxies create "$HTTP_PROXY_NAME" "${P[@]}" \
  --url-map "$REDIRECT_URLMAP"
create gcloud compute forwarding-rules create "$FR_HTTP" "${P[@]}" \
  --global --address "$IP_NAME" --target-http-proxy "$HTTP_PROXY_NAME" --ports 80

cat <<DONE

Done. Next steps:
  1. Point DNS: set the '${DOMAIN%%.*}' A record to  ->  $IP_ADDR
     (DigitalOcean: Networking -> Domains -> juanromerodev.com)
  2. Upload the site:  pnpm --filter @expenser/webapp run deploy
  3. Wait for the cert to become ACTIVE (DNS must resolve to the IP first):
     gcloud compute ssl-certificates describe $CERT_NAME --project $GCP_PROJECT --global \\
       --format='value(managed.status)'
DONE
