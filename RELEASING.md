# Releasing

Releases are fully automated with [release-please](https://github.com/googleapis/release-please). Versions, `CHANGELOG.md`, git tags, GitHub Releases, and `npm publish` are all derived from commit messages — none are edited or run by hand.

## Flow

1. A branch is created and changes are committed.
2. A PR is opened with a **Conventional Commit title**. The title determines the next version when the PR is squash-merged into `main`:

   | PR title prefix | Example | Version bump (examples assume a 1.0.0 baseline) |
   | --- | --- | --- |
   | `fix:` | `fix: rate-limit REST subscribe success path` | patch (1.0.0 → 1.0.1) |
   | `feat:` | `feat: expose Protect humidity` | minor (1.0.0 → 1.1.0) |
   | `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer | `feat!: require Homebridge 2 and Node 22` | major (1.0.0 → 2.0.0) |
   | `chore:`, `docs:`, `refactor:`, `test:`, `ci:` | `docs: fix typo` | no release |

   To force an exact version (for example graduating to `1.0.0`), put `Release-As: 1.0.0` in the commit/PR body footer. release-please will open a Release PR for that version.

3. The **Tests** workflow runs on the PR (matrix: Node 22 and 24 — the versions Homebridge 2 supports — plus a typecheck, a committed-`dist` drift check, and a security audit). The PR is squash-merged to `main`.
4. **release-please** opens or updates a **Release PR** titled `chore(main): release X.Y.Z`.
5. Merging the Release PR triggers `release.yml`, which creates the `vX.Y.Z` tag, publishes a GitHub Release, and runs `npm publish` with provenance on Node 24.

## Approve the Release PR checks

The Release PR is authored by `github-actions[bot]`, because `release.yml` passes `github.token` to release-please. GitHub creates its checks but holds them until a user with write access approves.

**Open the Release PR's Checks tab and click "Approve and run" before merging.**

- There is no CLI for this. `POST /actions/runs/{run_id}/approve` is documented for forks from first-time contributors and does not cover this gate.
- The approval does not stick. It is needed on every release, and again whenever release-please updates an open Release PR.
- **Merging without approving turns the runs red.** They finalise as `failure` with zero jobs and no logs. That means nobody approved them, not that anything broke.

This gate arrived with GitHub's [bot-created pull requests change](https://github.blog/changelog/2026-06-11-bot-created-pull-requests-can-run-workflows-if-approved/) and reached these repos in late August 2026. It applies to same-repo branches, not just forks, and has no repository-level opt-out. The only way to remove the step is to author the Release PR as a different identity, which needs a GitHub App or a PAT. Neither is set up here, and the click is cheaper.

## Branch protection

`main` is protected with settings chosen to be compatible with the automated flow above:

- **Require a pull request before merging** (0 required approvals) — keeps direct pushes off `main` without blocking a solo maintainer.
- **Block force-pushes and deletions.**
- **No required status checks.** The Tests workflow runs on every code PR and is visible there, but it is intentionally *not* a hard merge gate. The Release PR's own checks are held for approval, so a required check there would sit unresolved until someone approves it. The `publish` job re-runs build → lint → test before `npm publish`, so releases are still gated on a green build.

## Publishing authentication

Publishing uses **npm Trusted Publishing (OIDC)** — there is no `NPM_TOKEN` secret. Link the package to this repo's `release.yml` workflow on npmjs.com before the first Release PR is merged:

- Package → **Settings → Trusted Publisher**
- GitHub Actions publisher: organization/user `tbaur`, repository `homebridge-mynest`, workflow `release.yml`, no environment.

This link only needs to exist before the first Release PR is merged; it does not need to be reconfigured per release.

## Notes

- **PR titles drive releases.** With squash merges, the PR title becomes the commit release-please reads. `chore:`/`docs:`/`ci:` titles intentionally produce no release.
- **The Release PR's checks wait for approval.** They do not run on their own, and go red if the PR is merged first. See [Approve the Release PR checks](#approve-the-release-pr-checks). The code was already tested on its own PR, and the `publish` job builds, lints and tests again before publishing, so nothing ships untested.
- **Do not hand-edit** `CHANGELOG.md` or the `package.json` version after the first public release; release-please owns both. Version source of truth is `.release-please-manifest.json`.
- **`dist/` is committed** so `npm install` from git works. CI fails if `dist/` drifts from `src/`.

## Manual fallback

Manual publishing is rarely needed and bypasses CI provenance and manifest syncing. If unavoidable:

```bash
npm run clean && npm run build && npm run lint && npm test
npm publish --dry-run   # verify contents
npm publish             # requires npm login + OTP
```
