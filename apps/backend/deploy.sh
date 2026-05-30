#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Load deploy config (GCP_PROJECT, GCP_REGION, AR_REPO, SERVICE_NAME).
set -a
# shellcheck source=/dev/null
source "$SCRIPT_DIR/.env.deploy"
set +a

IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${AR_REPO}/${SERVICE_NAME}:latest"

echo "Building ${IMAGE} via Cloud Build..."
gcloud builds submit \
  --project "$GCP_PROJECT" \
  --config "$REPO_ROOT/cloudbuild.yaml" \
  --substitutions="_IMAGE=${IMAGE}" \
  "$REPO_ROOT"

echo "Deploying to Cloud Run service ${SERVICE_NAME}..."
gcloud run deploy "$SERVICE_NAME" \
  --project "$GCP_PROJECT" \
  --image "$IMAGE" \
  --region "$GCP_REGION"
