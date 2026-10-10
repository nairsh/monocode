# Personal fork delivery and upstream updates

Repository: https://github.com/nairsh/monocode, already a GitHub fork of https://github.com/hardbeat920/monocode.

## Downloads

`Fork macOS build` builds Apple Silicon macOS installers on pushes to `main`, on pull requests, and when manually dispatched. It runs web, host and Rust tests, builds the production app, verifies its architecture and ad-hoc signature, and uploads the DMG with source commit and checksums. Main pushes/manual builds publish an immutable `fork-<commit>` prerelease after success. PR and upstream proposal builds only upload Actions artifacts. Artifacts expire after 30 days; release assets do not use that artifact expiry.

The original upstream `Release` workflow remains available for upstream's signing/hosting setup. Do not use `v*` tags for personal builds: that workflow requires Apple/updater/R2 secrets this fork does not inherit. Personal tags use `fork-*`.

The fork configuration enables signed updater artifacts and points exclusively to `https://github.com/nairsh/monocode/releases/download/fork-updates/latest.json`. The public verification key is committed in `tauri.fork.conf.json`; the private key is stored in the repository's `FORK_UPDATER_PRIVATE_KEY` Actions secret, with a private local backup at `~/.tauri/monocode-fork.key`. Preserve that backup: replacing or losing the key breaks updates for installed copies trusting the old key. Never commit the private key. Updater signatures are separate from Apple signing/notarization.

Trusted main builds use version `0.12.0-fork.<Actions run number>`, produce the signed `.app.tar.gz` archive and `latest.json`, and publish immutable commit-specific assets before advancing the dedicated `fork-updates` feed. The workflow serializes builds per ref, refuses to publish an obsolete main commit and prevents feed version regression on retries. PR/upstream proposal builds disable updater artifact generation and do not receive the signing secret. An existing commit release keeps its original manifest and archives. If the fork version base is changed later, it must increase; keep the `-fork.0` suffix in the checked-in config.

The app checks when the sidebar mounts (normally at launch), displays an update button, and downloads, verifies, installs and restarts when clicked. Settings and the app menu also provide manual checks. It does not pull Git commits or automatically merge upstream changes. Builds through `fork-66552a4e8b50` have no updater and require one manual installation of an updater-enabled DMG. It builds Vite in `fork` mode so manual download messages point to this fork as well. Upstream's updater must not overwrite the fork. This build is ad-hoc signed, not notarized; a downloaded app can require macOS Privacy & Security → Open Anyway. Normal notarized distribution requires the owner's Apple signing credentials. Do not disable Gatekeeper globally.

The application name/identifier stay `MonoCode` / `com.monocode.desktop` to preserve existing application data. Quit the previous app before replacing `/Applications/MonoCode.app`. Keep a recoverable copy of the old application and preserve its data; deleting the application data is unnecessary. Only one installed active application should remain at the normal Applications path.

## Upstream updates

`Propose upstream update` checks upstream hourly at minute 23 and supports manual dispatch. A fork cannot subscribe directly to every upstream push using only its own Actions triggers; exact event-driven updates require an upstream webhook or equivalent external integration. The schedule detects the latest upstream tip, including all intervening commits, and may be delayed by GitHub scheduling.

When upstream is newer, the workflow creates a new `codex/upstream-<sha>` branch from this fork's current `main`, attempts a normal merge, and opens a PR. It never resets or force-pushes `main`, never resolves conflicts by choosing one side wholesale, and never auto-merges. If the merge conflicts, it aborts the local merge and publishes the upstream tip as a **draft PR**, listing the conflicted paths in the PR and run summary. That successful run means a proposal was created, not that upstream was merged or validated. Resolve the draft's conflicts against fork `main` while preserving fork changes, run PR checks, and review before marking it ready. No packaging validation runs for an unresolved draft.

An existing branch for that upstream tip is left alone to preserve human review changes. If branch creation succeeded but PR creation failed, the next run recovers it as an unvalidated draft without rewriting the branch. Existing open or closed PRs are left alone; if a closed proposal needs rebuilding from a newer main, delete that proposal branch deliberately and rerun, or update the PR manually. Fetch, push, PR API, and merge errors without actual conflicted paths still fail the run.

GitHub suppresses ordinary downstream push/PR workflows for changes made by `GITHUB_TOKEN`. Therefore the sync run explicitly calls the reusable macOS workflow with the exact merge SHA. Inspect that run before merging. This validation covers macOS web/host/Rust tests and packaging; it does not replace the repository's full Linux/Windows CI matrix. The repository setting allowing Actions to create PRs is required. Its combined API setting is named `can_approve_pull_request_reviews`; enabling it permits PR creation, but this workflow never approves reviews.

Reusable builds with an explicit proposal `ref` never receive the updater signing key or publish releases, including when the sync caller was manually dispatched on `main`.

Run `node --test scripts/upstream-sync.test.mjs` to exercise the workflow shell in disposable Git repositories. It covers already-included upstream, clean merges, conflicted drafts, preserved proposal branches, recovery after PR creation failure, fetch failures, and signing/publishing guards. GitHub PR calls are stubbed; this does not prove a hosted Actions run or real PR creation.

A clean Git merge and passing tests cannot guarantee preservation of custom UX. Review project rail navigation, thread folders, composer controls, transcript grouping, fork packaging and updater configuration. The performance comparison in `t3-performance-review.md` gives a staged plan for future changes rather than a wholesale backend replacement.

## Local build

```sh
TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/monocode-fork.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD='' PATH="$HOME/.cargo/bin:$PATH" npm run tauri -- build --bundles app,dmg --config src-tauri/tauri.fork.conf.json
```

On the reviewed Mac, `/opt/homebrew/bin/rustc` could not load `libLLVM.dylib`; the already-installed Rustup toolchain works. The PATH prefix selects that existing toolchain without modifying the user's shell configuration.

Local output: `target/release/bundle/dmg/` and `target/release/bundle/macos/MonoCode.app`. Compare SHA-256 checksums when downloading release assets.

## Validation on 2026-10-08

- Production TypeScript/Vite/Rust/Tauri build completed; ARM64 app signature and DMG integrity verified.
- Web after the complete reviewed T3 transfer: 466 test files passed, 4,929 tests passed, 13 skipped. Subsequent targeted browser corrections passed 22 transcript/code and 21 remote-detail/scroll tests; final TypeScript passed. Local Node 26 initially interfered with happy-dom storage; `NODE_OPTIONS=--no-experimental-webstorage` resolved the failures. The fork build uses that test setting as well.
- The targeted sidebar, transcript cache and transcript pool suite passed all 43 tests. TypeScript checking passed. These cover unnecessary database/layout/grouping work as well as existing interactions.
- Host: 111 tests passed, 5 skipped, including the production host pretest build.
- Rust: 591 tests passed, 1 ignored. Formatting and workspace/all-target Clippy with warnings denied passed.
- Both new workflows passed actionlint 1.7.12 and the patch passed whitespace validation.
- The upstream workflow's first dispatch exposed a reusable-workflow permission ceiling error; the corrected dispatch completed successfully and found upstream already included. No real new-upstream merge/conflict has occurred yet.
- The final manual-download routing change passed all seven updater tests (including the new fork routing regression check) and was rebuilt in fork mode.
- Existing compiler warnings: unused macOS imports; CSS optimizer does not recognize the transcript search `::highlight` pseudo-element. Build succeeded.
- The restored app's “Review and commit monocode changes” chat confirms completion of the earlier review, fixes, tests, commit and push of `b9c3971`. No GitHub check was attached to that review. The counts above were independently rerun for this delivery.
- Installed 0.9.0 at `/Applications/MonoCode.app` and visually verified project/chat restoration. Previous 0.7.0 moved to Trash. The old app ZIP and pre-launch application-data copy are in `~/Library/Application Support/MonoCode-fork-backups/2026-10-08/`.

The performance fixes scope sidebar refreshes to successful saved changes, skip unchanged row-position measurements, reuse historical transcript groups during final-answer streaming, and bound parked transcript DOM. The follow-up transfer stabilizes sidebar summary arrays and dependent filtering/sorting, scopes and bounds explorer refresh workers/cache retention, and reuses completed code-line grammar state. Regression fixtures show zero additional query filters/order comparisons over 30 unrelated shell updates and 465 rather than 96,465 tokenizer characters over 30 growing-tail updates. Explorer tests cover cold pending-read invalidation, late success/failure races, deleted parents, root/remote boundaries and the four-worker bound. See the architecture and commit reviews for limits and remaining work. No comparative whole-app speed or energy improvement is claimed.

The completed follow-up adds per-session detail publication, active-history content recycling, bounded remote transport/history/detail reads, changed-block host durability, guarded idle Codex subscription release, terminal flow control and Git/Inbox resource savings. `npm run test:performance` emits numeric JSON/Markdown reports; the release retains those artifacts alongside the DMG and source checksum. [The full completion ledger](t3-performance-completion.md) distinguishes every transferred mechanism, existing equivalent and non-applicable T3 feature. No remote host was deployed: format-1 host databases require a stopped whole-state-directory backup before upgrade and restoration before any older-host downgrade.
