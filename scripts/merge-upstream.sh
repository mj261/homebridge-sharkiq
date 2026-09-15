#!/usr/bin/env bash
# Run from any directory. Review the resulting branch before merging to latest.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'Commit or stash your changes before merging upstream.' >&2
  exit 1
fi
if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream https://github.com/homebridge-plugins/homebridge-sharkiq.git
fi
if [[ "$(git remote get-url upstream)" != 'https://github.com/homebridge-plugins/homebridge-sharkiq.git' ]]; then
  echo 'The upstream remote does not match the original SharkIQ repository.' >&2
  exit 1
fi
git fetch upstream latest --tags
merge_target="${1:-upstream/latest}"
merge_commit="$(git rev-parse --verify --end-of-options "${merge_target}^{commit}")"
git switch -c "upstream-review-$(date +%Y%m%d-%H%M%S)"
git merge --no-edit "$merge_commit"
npm ci
npm run lint
npm run build
npm test
echo 'Upstream merged and checks passed on the review branch. Review the diff and retain the mj261 package version before publishing a release.'
