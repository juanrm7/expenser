#!/usr/bin/env bash
# Deploy Expenser on the droplet: pull, install, build both apps, publish the static
# webapp to the nginx web root, and (re)start the backend under pm2.
#
# Run on the droplet from the repo checkout:
#   pnpm run deploy            (or: bash deploy/deploy.sh)
#
# Overridable env vars:
#   BRANCH    git branch to deploy        (default: main)
#   WEB_ROOT  nginx root for the webapp   (default: /var/www/expenser)
set -euo pipefail

# Everything runs inside main() so bash has parsed the whole script before `git pull`
# can rewrite this file.
main() {
  local script_dir repo_root
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd "$script_dir/.." && pwd)"
  local branch="${BRANCH:-main}"
  local web_root="${WEB_ROOT:-/var/www/expenser}"

  cd "$repo_root"

  for f in apps/backend/.env apps/webapp/.env; do
    if [[ ! -f "$f" ]]; then
      echo "Missing $f — copy it from $f.example and fill in production values." >&2
      exit 1
    fi
  done

  echo "==> Pulling $branch"
  git fetch origin "$branch"
  git checkout "$branch"
  git pull --ff-only origin "$branch"

  echo "==> Installing dependencies"
  pnpm install --frozen-lockfile

  # Built per package rather than via turbo: turbo's cache doesn't see the gitignored
  # .env files, so a changed PUBLIC_BACKEND_URL could otherwise ship a stale build.
  echo "==> Building backend"
  pnpm --filter @expenser/backend db:generate
  pnpm --filter @expenser/backend build

  echo "==> Building webapp"
  pnpm --filter @expenser/webapp build

  echo "==> Publishing webapp to $web_root"
  mkdir -p "$web_root"
  rsync -a --delete apps/webapp/dist/ "$web_root/"

  echo "==> (Re)starting backend with pm2"
  pm2 startOrReload deploy/ecosystem.config.cjs --update-env
  pm2 save

  echo "Done."
}

main "$@"
