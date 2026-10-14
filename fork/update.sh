#!/usr/bin/env bash
# Sync this fork with pingdotgg/t3code, rebuild the macOS desktop app, and install it.
#
#   fork/update.sh              sync + build + install
#   fork/update.sh --no-sync    rebuild the current checkout (e.g. after resolving a rebase)
#   fork/update.sh --no-install build only; artifacts land in release/
#   fork/update.sh --yes        quit a running T3 Code without asking
#
# Branches: `main` mirrors upstream/main and never gets local commits.
# Your changes live on `custom`, which is rebased onto `main` on every sync.
set -euo pipefail

BRANCH="custom"
sync=1 build=1 install=1 assume_yes=0
for arg in "$@"; do
  case "$arg" in
    --no-sync) sync=0 ;;
    --no-build) build=0 ;;
    --no-install) install=0 ;;
    --yes | -y) assume_yes=1 ;;
    -h | --help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

if ((sync)); then
  [[ -z "$(git status --porcelain)" ]] || die "working tree has uncommitted changes; commit or stash them first"
  [[ ! -d "$(git rev-parse --git-path rebase-merge)" && ! -d "$(git rev-parse --git-path rebase-apply)" ]] ||
    die "a rebase is in progress; finish it (git rebase --continue) then run with --no-sync"

  step "Fetching upstream"
  git fetch upstream --tags
  git fetch origin

  [[ "$(git branch --show-current)" == "$BRANCH" ]] || git checkout "$BRANCH"
  old_main=$(git rev-parse main)
  # Fast-forward only: main must stay an exact mirror of upstream.
  git fetch . upstream/main:main
  echo "main: $(git log --oneline -1 main)"
  echo "new upstream commits: $(git rev-list --count "$old_main..main")"

  step "Rebasing $BRANCH onto main"
  if ! git rebase main; then
    cat >&2 <<EOF

Rebase stopped on a conflict between your changes and upstream.
  1. Fix the files git lists as conflicted, then: git add <files> && git rebase --continue
     (or give up for now with: git rebase --abort)
  2. Re-run: fork/update.sh --no-sync
git rerere is on, so a conflict you resolve once is replayed automatically next time.
EOF
    exit 1
  fi

  step "Pushing to your fork"
  git push origin main
  git push --force-with-lease origin "$BRANCH"
fi

arch=$([[ "$(uname -m)" == "arm64" ]] && echo arm64 || echo x64)

if ((build)); then
  step "Installing dependencies"
  vp i
  step "Building desktop app ($arch)"
  vp run dist:desktop:artifact --platform mac --target dmg --arch "$arch"
fi

((install)) || { echo; echo "Built artifacts are in $(pwd)/release"; exit 0; }

zip=$(ls -t release/T3-Code-*-"$arch".zip 2>/dev/null | head -1 || true)
[[ -n "$zip" ]] || die "no release/T3-Code-*-$arch.zip found; build first"

step "Installing $zip"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
ditto -x -k "$zip" "$stage"
new_app=$(find "$stage" -maxdepth 1 -name '*.app' | head -1)
[[ -n "$new_app" ]] || die "no .app inside $zip"
app_name=$(basename "$new_app" .app)
bundle_id=$(defaults read "$new_app/Contents/Info" CFBundleIdentifier)
dest="/Applications/$app_name.app"

# pgrep -x can't match the name: macOS truncates process names to 16 chars.
is_running() { [[ "$(osascript -e "application id \"$bundle_id\" is running" 2>/dev/null)" == true ]]; }

was_running=0
if is_running; then
  was_running=1
  if ((!assume_yes)); then
    read -r -p "$app_name is running; quitting it stops any agent turns in progress. Quit now? [y/N] " reply
    [[ "$reply" == [yY]* ]] || die "not installed; quit $app_name and re-run with --no-sync --no-build"
  fi
  osascript -e "tell application id \"$bundle_id\" to quit"
  for _ in $(seq 60); do is_running || break; sleep 0.5; done
  is_running && die "$app_name did not quit"
fi

# Keep the replaced app so a bad build can be rolled back (see fork/README.md).
if [[ -d "$dest" ]]; then
  rm -rf release/previous
  mkdir -p release/previous
  mv "$dest" release/previous/
fi
ditto "$new_app" "$dest"
echo "Installed $dest ($(defaults read "$dest/Contents/Info" CFBundleShortVersionString), $(git log --oneline -1 HEAD | cut -c1-60))"

((was_running)) && open -a "$dest"
exit 0
