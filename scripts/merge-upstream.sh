#!/usr/bin/env bash
# Merge the newest stable upstream SharkIQ release into the mj261 fork.
#
# Safe default: create and validate a local review branch only.
# External actions require an explicit --push, --pr, or --publish flag.
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"

upstream_url='https://github.com/homebridge-plugins/homebridge-sharkiq.git'
upstream_api='https://api.github.com/repos/homebridge-plugins/homebridge-sharkiq/releases/latest'
fork_repo='mj261/homebridge-sharkiq'
mode='local'
merge_target=''
assume_yes=false
dry_run=false

usage() {
  cat <<'EOF'
Usage: scripts/merge-upstream.sh [options] [TAG]

Find the newest stable upstream GitHub release, merge it into a review branch,
retain the mj261 RV3020 changes, assign the next X.Y.Z-mj261.N version, and run
the complete validation suite.

Options:
  --dry-run       Fetch and report the update that would be prepared.
  --push          Push the validated review branch and print its PR URL.
  --pr            Push and open a pull request with GitHub CLI.
  --publish       Open the PR, wait for checks, merge it, publish the GitHub
                  release, and wait for the tested package/checksum assets.
  --yes           Skip the typed confirmation required by --publish.
  --target TAG    Use a specific stable upstream tag instead of releases/latest.
  -h, --help      Show this help.

For backward compatibility, TAG may be supplied as the sole positional value.
Examples:
  bash scripts/merge-upstream.sh --dry-run
  bash scripts/merge-upstream.sh
  bash scripts/merge-upstream.sh --pr
  bash scripts/merge-upstream.sh --publish
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

while (($#)); do
  case "$1" in
    --dry-run)
      dry_run=true
      ;;
    --push)
      mode='push'
      ;;
    --pr)
      mode='pr'
      ;;
    --publish)
      mode='publish'
      ;;
    --yes)
      assume_yes=true
      ;;
    --target)
      shift
      (($#)) || die '--target requires a tag.'
      merge_target="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      die "Unknown option: $1"
      ;;
    *)
      [[ -z "$merge_target" ]] || die 'Only one upstream tag may be supplied.'
      merge_target="$1"
      ;;
  esac
  shift
done

require_command git
require_command node
require_command npm
require_command curl

if ! $dry_run && [[ "$mode" == 'pr' || "$mode" == 'publish' ]]; then
  require_command gh
  gh auth status >/dev/null 2>&1 || die 'GitHub CLI is not authenticated. Run: gh auth login'
fi

# Untracked diagnostics such as outputs/ are harmless and remain untouched.
# Tracked or staged edits are not: switching branches could mix them into the
# upstream update or make a conflict resolution ambiguous.
git diff --quiet || die 'Commit or stash tracked changes before updating upstream.'
git diff --cached --quiet || die 'Commit or stash staged changes before updating upstream.'

if ! git config --get remote.upstream.url >/dev/null 2>&1; then
  git remote add upstream "$upstream_url"
fi
[[ "$(git config --get remote.upstream.url)" == "$upstream_url" ]] \
  || die "The upstream remote must be $upstream_url"

git remote get-url origin >/dev/null 2>&1 || die 'The fork must have an origin remote.'

printf 'Fetching the fork and upstream tags...\n'
git fetch origin latest --tags
git fetch upstream latest --tags

if [[ -z "$merge_target" ]]; then
  merge_target="$(curl -fsSL "$upstream_api" | node -e '
    let body = "";
    process.stdin.on("data", chunk => body += chunk);
    process.stdin.on("end", () => {
      const release = JSON.parse(body);
      if (typeof release.tag_name !== "string") process.exit(1);
      process.stdout.write(release.tag_name);
    });
  ')" || die 'Unable to determine the latest stable upstream GitHub release.'
fi

[[ "$merge_target" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "Upstream target must be a stable vX.Y.Z tag, got: $merge_target"
git rev-parse --verify --quiet --end-of-options "${merge_target}^{commit}" >/dev/null \
  || die "Upstream tag was not fetched: $merge_target"

upstream_version="${merge_target#v}"

# Fork tags are vX.Y.Z-mj261.N. Pick the next unused numeric revision for this
# upstream base, including tags that exist only on origin.
next_revision="$({
  git tag --list "v${upstream_version}-mj261.*"
  git ls-remote --tags --refs origin "v${upstream_version}-mj261.*" \
    | awk '{ sub("refs/tags/", "", $2); print $2 }'
} | sed -nE "s/^v${upstream_version//./\\.}-mj261\.([0-9]+)$/\\1/p" \
  | awk 'BEGIN { max=0 } { if ($1 > max) max=$1 } END { print max + 1 }')"
fork_version="${upstream_version}-mj261.${next_revision}"
review_branch="upstream-review-${merge_target}-${fork_version}-$(date +%Y%m%d-%H%M%S)"

if git merge-base --is-ancestor "$merge_target" origin/latest; then
  current_version="$(git show origin/latest:package.json | node -e '
    let body = "";
    process.stdin.on("data", chunk => body += chunk);
    process.stdin.on("end", () => process.stdout.write(JSON.parse(body).version));
  ')"
  printf 'Fork latest already contains upstream %s (package %s). Nothing to do.\n' \
    "$merge_target" "$current_version"
  exit 0
fi

printf '\nUpdate plan:\n'
printf '  Upstream release: %s\n' "$merge_target"
printf '  Fork version:     %s\n' "$fork_version"
printf '  Review branch:    %s\n' "$review_branch"
printf '  Mode:             %s\n\n' "$mode"

if $dry_run; then
  printf 'Dry run complete; no branch, commit, push, PR, merge, or release was created.\n'
  exit 0
fi

git switch latest
git merge --ff-only origin/latest
git switch -c "$review_branch"

if ! git merge --no-edit "$merge_target"; then
  cat >&2 <<EOF

The upstream merge has conflicts. The review branch was kept in place:
  $review_branch

Resolve each conflict while retaining both upstream fixes and the RV3020 code,
then run npm ci, npm run lint, npm run build, and npm test. Do not resolve whole
files with --theirs because that can silently remove the fork functionality.
EOF
  exit 2
fi

# Fail before versioning or publishing if the core fork implementation vanished
# during a conflict-free upstream merge.
[[ -f src/sharkiq-js/rv3020.ts ]] || die 'RV3020 implementation is missing after the merge.'
[[ -f src/rv3020.test.ts ]] || die 'RV3020 tests are missing after the merge.'
grep -q 'RV3020XEUS' src/sharkiq-js/rv3020.ts \
  || die 'RV3020 model support is missing after the merge.'
grep -q 'LiveLocation' src/sharkiq-js/rv3020.ts \
  || die 'RV3020 coordinate-to-room support is missing after the merge.'
grep -q 'RV3020_CLEAN_MODES' src/SharkIQMatterPlatform.ts \
  || die 'RV3020 Matter modes are missing after the merge.'

npm ci
npm version "$fork_version" --no-git-tag-version

# Keep the fork changelog and documented package filename aligned with the
# generated version without depending on platform-specific sed syntax.
FORK_VERSION="$fork_version" UPSTREAM_TAG="$merge_target" node <<'NODE'
const fs = require('node:fs');

const version = process.env.FORK_VERSION;
const upstreamTag = process.env.UPSTREAM_TAG;
const date = new Date().toISOString().slice(0, 10);

let changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const heading = `## v${version}`;
if (!changelog.includes(heading)) {
  const insertAt = changelog.indexOf('\n\n', changelog.indexOf('\n') + 1) + 2;
  const section = `${heading} (${date})\n\n### Changed\n\n- chore: merge upstream ${upstreamTag} while retaining the mj261 RV3020 Matter features\n\n`;
  changelog = changelog.slice(0, insertAt) + section + changelog.slice(insertAt);
  fs.writeFileSync('CHANGELOG.md', changelog);
}

let forkDocs = fs.readFileSync('FORK.md', 'utf8');
forkDocs = forkDocs.replace(
  /homebridge-plugins-homebridge-sharkiq-[0-9A-Za-z.-]+\.tgz/g,
  `homebridge-plugins-homebridge-sharkiq-${version}.tgz`,
);
fs.writeFileSync('FORK.md', forkDocs);
NODE

npm run lint
npm run build
npm test
npm pack --dry-run >/dev/null

git add package.json package-lock.json CHANGELOG.md FORK.md
git commit -m "chore: prepare v${fork_version}"

printf '\nValidated review branch: %s\n' "$review_branch"
printf 'Upstream %s is merged and the RV3020 invariants and full test suite pass.\n' "$merge_target"

if [[ "$mode" == 'local' ]]; then
  printf '\nReview with:\n'
  printf '  git log --oneline --graph origin/latest..HEAD\n'
  printf '  git diff --stat origin/latest...HEAD\n'
  printf '\nPush when ready:\n'
  printf '  git push -u origin %s\n' "$review_branch"
  exit 0
fi

git push -u origin "$review_branch"
compare_url="https://github.com/${fork_repo}/compare/latest...${review_branch}?expand=1"

if [[ "$mode" == 'push' ]]; then
  printf '\nOpen the pull request: %s\n' "$compare_url"
  exit 0
fi

pr_url="$(gh pr create \
  --repo "$fork_repo" \
  --base latest \
  --head "$review_branch" \
  --title "Merge upstream ${merge_target} into the mj261 fork" \
  --body "Merges upstream ${merge_target}, retains the RV3020 Matter features, and prepares v${fork_version}. Local lint, build, tests, and package validation passed.")"
printf '\nPull request created: %s\n' "$pr_url"

if [[ "$mode" == 'pr' ]]; then
  exit 0
fi

if ! $assume_yes; then
  printf '\nPublishing will wait for checks, merge the PR into latest, and create v%s.\n' "$fork_version"
  read -r -p 'Type publish to continue: ' confirmation
  [[ "$confirmation" == 'publish' ]] || die 'Publish cancelled; the pull request remains open.'
fi

printf 'Waiting for GitHub checks to register...\n'
checks_registered=false
for _ in $(seq 1 40); do
  check_count="$(gh pr view "$pr_url" --json statusCheckRollup --jq '.statusCheckRollup | length')"
  if [[ "$check_count" -gt 0 ]]; then
    checks_registered=true
    break
  fi
  sleep 3
done
$checks_registered || die 'Timed out waiting for pull-request checks to start.'
gh pr checks "$pr_url" --watch --fail-fast
gh pr merge "$pr_url" --merge --delete-branch

git switch latest
git pull --ff-only origin latest
merged_version="$(node -p 'require("./package.json").version')"
[[ "$merged_version" == "$fork_version" ]] \
  || die "Merged latest has package version $merged_version, expected $fork_version"

release_tag="v${fork_version}"
gh release create "$release_tag" \
  --repo "$fork_repo" \
  --target latest \
  --title "$release_tag" \
  --latest \
  --notes "Merge upstream ${merge_target} while retaining the mj261 RV3020 Matter features. Lint, build, tests, and package validation passed before publishing."

printf 'Waiting for the release workflow to attach the tested package...\n'
expected_package="homebridge-plugins-homebridge-sharkiq-${fork_version}.tgz"
for _ in $(seq 1 120); do
  assets="$(gh release view "$release_tag" --repo "$fork_repo" --json assets --jq '.assets[].name' 2>/dev/null || true)"
  if grep -Fxq "$expected_package" <<<"$assets" && grep -Fxq 'SHA256SUMS' <<<"$assets"; then
    printf 'Published and verified release assets for %s.\n' "$release_tag"
    printf 'https://github.com/%s/releases/tag/%s\n' "$fork_repo" "$release_tag"
    exit 0
  fi
  sleep 5
done

die "Timed out waiting for release assets. Inspect the Fork build and release workflow for $release_tag."
