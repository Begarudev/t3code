# Begarudev/t3code fork

Personal build of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) with my own tweaks, kept on top of upstream `main`.

## Layout

| Ref               | What it is                                          |
| ----------------- | --------------------------------------------------- |
| `upstream` remote | `pingdotgg/t3code`                                  |
| `origin` remote   | `Begarudev/t3code` (this fork)                      |
| `main`            | Exact mirror of `upstream/main`. Never commit here. |
| `custom`          | My changes, rebased onto `main` on every update.    |

## Everyday commands

```sh
fork/update.sh                       # pull upstream, rebase custom, build, install to /Applications
fork/update.sh --no-sync             # rebuild + install the current checkout
fork/update.sh --no-install          # build only; artifacts land in release/
vp run dev:desktop                   # try a change live; uses ~/.t3/dev/userdata, not your real data
```

To make a change: work on `custom`, try it with `vp run dev:desktop`, commit, then `fork/update.sh --no-sync`.
Keep changes small and in as few upstream files as possible, because each one can conflict on a rebase.

## When a rebase conflicts

`update.sh` stops and leaves the rebase in progress. Fix the conflicted files, `git add` them,
`git rebase --continue`, then `fork/update.sh --no-sync`. `git rerere` is enabled, so a
conflict resolved once is replayed automatically next time.

## Rolling back a bad build

Each install moves the replaced app to `release/previous/`. Quit T3 Code, then:

```sh
rm -rf "/Applications/T3 Code (Alpha).app" && mv "release/previous/T3 Code (Alpha).app" /Applications/
```

To go back to the official app instead: `brew install --cask --force t3-code`.

## How this build differs from the official app

- Same app name, bundle id and data directory (`~/.t3/userdata`), so it replaces the official app and keeps your threads.
- No auto-update feed is compiled in, so the in-app updater never overwrites it. `fork/update.sh` is the updater.
- Ad-hoc signed, not Apple-signed: macOS desktop passkeys are unavailable, and macOS may ask once for keychain access the official app had.
- Built from `main`, which runs ahead of the latest stable release. Its database migrations apply to `~/.t3/userdata`, so an older official release may not open that data afterwards.
- The version shown is the one in `package.json` (for example 0.0.45), not the commit.
