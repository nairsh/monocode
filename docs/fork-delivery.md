# Personal fork delivery and upstream updates

Repository: https://github.com/nairsh/monocode, already a GitHub fork of https://github.com/hardbeat920/monocode.

## Downloads

`Fork macOS build` builds Apple Silicon macOS installers on pushes to `main`, on pull requests, and when manually dispatched. It runs web, host and Rust tests, builds the production app, verifies its architecture and ad-hoc signature, and uploads the DMG with source commit and checksums. Main pushes/manual builds publish an immutable `fork-<commit>` prerelease after success. PR and upstream proposal builds only upload Actions artifacts. Artifacts expire after 30 days; release assets do not use that artifact expiry.

The original upstream `Release` workflow remains available for upstream's signing/hosting setup. Do not use `v*` tags for personal builds: that workflow requires Apple/updater/R2 secrets this fork does not inherit. Personal tags use `fork-*`.

The fork configuration disables updater artifacts and leaves the in-app updater key/endpoints empty. It builds Vite in `fork` mode so the manual update message points to this fork's releases as well. Upstream's updater must not overwrite the fork. This build is ad-hoc signed, not notarized; a downloaded app can require macOS Privacy & Security → Open Anyway. Normal notarized distribution requires the owner's Apple signing credentials. Do not disable Gatekeeper globally.

The application name/identifier stay `MonoCode` / `com.monocode.desktop` to preserve existing application data. Quit the previous app before replacing `/Applications/MonoCode.app`. Keep a recoverable copy of the old application and preserve its data; deleting the application data is unnecessary. Only one installed active application should remain at the normal Applications path.

## Upstream updates

`Propose upstream update` checks upstream hourly at minute 23 and supports manual dispatch. A fork cannot subscribe directly to every upstream push using only its own Actions triggers; exact event-driven updates require an upstream webhook or equivalent external integration. The schedule detects the latest upstream tip, including all intervening commits, and may be delayed by GitHub scheduling.

When upstream is newer, the workflow creates a new `codex/upstream-<sha>` branch from this fork's current `main`, attempts a normal merge, and opens a PR. It never resets or force-pushes `main`, never resolves conflicts by choosing one side wholesale, and never auto-merges. Conflicts fail the run with the conflicted paths in the run summary. Review GitHub Actions failure notifications. An existing branch for that upstream tip is left alone to preserve human review changes; if a closed/failed proposal needs rebuilding from a newer main, delete that proposal branch deliberately and rerun, or update the PR manually.

GitHub suppresses ordinary downstream push/PR workflows for changes made by `GITHUB_TOKEN`. Therefore the sync run explicitly calls the reusable macOS workflow with the exact merge SHA. Inspect that run before merging. This validation covers macOS web/host/Rust tests and packaging; it does not replace the repository's full Linux/Windows CI matrix. The repository setting allowing Actions to create PRs is required. Its combined API setting is named `can_approve_pull_request_reviews`; enabling it permits PR creation, but this workflow never approves reviews.

A clean Git merge and passing tests cannot guarantee preservation of custom UX. Review project rail navigation, thread folders, composer controls, transcript grouping, fork packaging and updater configuration. The performance comparison in `t3-performance-review.md` gives a staged plan for future changes rather than a wholesale backend replacement.

## Local build

```sh
PATH="$HOME/.cargo/bin:$PATH" npm run tauri -- build --bundles app,dmg --config src-tauri/tauri.fork.conf.json
```

On the reviewed Mac, `/opt/homebrew/bin/rustc` could not load `libLLVM.dylib`; the already-installed Rustup toolchain works. The PATH prefix selects that existing toolchain without modifying the user's shell configuration.

Local output: `target/release/bundle/dmg/` and `target/release/bundle/macos/MonoCode.app`. Compare SHA-256 checksums when downloading release assets.

## Validation on 2026-10-08

- Production TypeScript/Vite/Rust/Tauri build completed; ARM64 app signature and DMG integrity verified.
- Web after the performance fixes: 457 test files passed, 4,859 tests passed, 13 skipped. Local Node 26 initially interfered with happy-dom storage; `NODE_OPTIONS=--no-experimental-webstorage` resolved the failures. The fork build uses that test setting as well.
- The targeted sidebar, transcript cache and transcript pool suite passed all 43 tests. TypeScript checking passed. These cover unnecessary database/layout/grouping work as well as existing interactions.
- Host: 100 tests passed, 5 skipped.
- Rust: 586 tests passed, 1 ignored.
- Both new workflows passed actionlint 1.7.12 and the patch passed whitespace validation.
- The upstream workflow's first dispatch exposed a reusable-workflow permission ceiling error; the corrected dispatch completed successfully and found upstream already included. No real new-upstream merge/conflict has occurred yet.
- The final manual-download routing change passed all seven updater tests (including the new fork routing regression check) and was rebuilt in fork mode.
- Existing compiler warnings: unused macOS imports; CSS optimizer does not recognize the transcript search `::highlight` pseudo-element. Build succeeded.
- The restored app's “Review and commit monocode changes” chat confirms completion of the earlier review, fixes, tests, commit and push of `b9c3971`. No GitHub check was attached to that review. The counts above were independently rerun for this delivery.
- Installed 0.9.0 at `/Applications/MonoCode.app` and visually verified project/chat restoration. Previous 0.7.0 moved to Trash. The old app ZIP and pre-launch application-data copy are in `~/Library/Application Support/MonoCode-fork-backups/2026-10-08/`.

The first performance fixes now scope sidebar refreshes to successful saved changes, skip unchanged row-position measurements, reuse historical transcript groups during final-answer streaming, and bound parked transcript DOM. See the comparison's implementation section for regression evidence and remaining work. No comparative whole-app speed or energy improvement is claimed.
