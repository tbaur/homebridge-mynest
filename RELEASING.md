# Releasing

Releases are fully automated with [release-please](https://github.com/googleapis/release-please). Versions, `CHANGELOG.md`, git tags, GitHub Releases, and `npm publish` are all derived from commit messages — none are edited or run by hand.

## Flow

1. A branch is created and changes are committed.
2. A PR is opened with a **Conventional Commit title**. The title determines the next version when the PR is squash-merged into `main`:

   | PR title prefix | Example | Version bump (pre-1.0) |
   | --- | --- | --- |
   | `fix:` | `fix: rate-limit REST subscribe success path` | patch (0.1.0 → 0.1.1) |
   | `feat:` | `feat: thermostat write path behind confirm` | patch (0.1.0 → 0.1.1) |
   | `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer | `feat!: drop Node 20` | minor (0.1.0 → 0.2.0) |
   | `chore:`, `docs:`, `refactor:`, `test:`, `ci:` | `docs: fix typo` | no release |

   The bumps above are damped while the version is below `1.0.0`, because `release-please-config.json` sets `bump-minor-pre-major` and `bump-patch-for-minor-pre-major`. Once `1.0.0` ships, the same prefixes resume their normal meaning.

3. The **Tests** workflow runs on the PR (matrix: Node 20, 22, 24, plus a security audit). The PR is squash-merged to `main`.
4. **release-please** opens or updates a **Release PR** titled `chore(main): release X.Y.Z`.
5. Merging the Release PR triggers `release.yml`, which creates the `vX.Y.Z` tag, publishes a GitHub Release, and runs `npm publish` with provenance on Node 24.

## Branch protection

`main` is protected with settings chosen to be compatible with the automated flow above:

- **Require a pull request before merging** (0 required approvals) — keeps direct pushes off `main` without blocking a solo maintainer.
- **Block force-pushes and deletions.**
- **No required status checks.** The Tests workflow runs on every code PR and is visible there, but it is intentionally *not* a hard merge gate. The Release PR is opened by the built-in `GITHUB_TOKEN`, and GitHub does not trigger workflows for such PRs (loop prevention), so a required check would leave every Release PR permanently unmergeable. The `publish` job re-runs build → lint → test before `npm publish`, so releases are still gated on a green build.

## Publishing authentication

Publishing uses **npm Trusted Publishing (OIDC)** — there is no `NPM_TOKEN` secret. Link the package to this repo's `release.yml` workflow on npmjs.com before the first Release PR is merged:

- Package → **Settings → Trusted Publisher**
- GitHub Actions publisher: organization/user `tbaur`, repository `homebridge-mynest`, workflow `release.yml`, no environment.

This link only needs to exist before the first Release PR is merged; it does not need to be reconfigured per release.

## Notes

- **PR titles drive releases.** With squash merges, the PR title becomes the commit release-please reads. `chore:`/`docs:`/`ci:` titles intentionally produce no release.
- **The Release PR does not re-run the Tests workflow.** GitHub does not trigger workflows for PRs opened by the built-in token (loop prevention). The code was already tested on its own PR, and the `publish` job builds, lints, and tests again before publishing, so nothing ships untested.
- **Do not hand-edit** `CHANGELOG.md` or the `package.json` version after the first public release; release-please owns both. Version source of truth is `.release-please-manifest.json`.
- **`dist/` is committed** so `npm install` from git works. CI fails if `dist/` drifts from `src/`.

## Manual fallback

Manual publishing is rarely needed and bypasses CI provenance and manifest syncing. If unavoidable:

```bash
npm run clean && npm run build && npm run lint && npm test
npm publish --dry-run   # verify contents
npm publish             # requires npm login + OTP
```
