# Workflow maintenance

Desktop and standalone-host CI currently run on macOS only. Windows/Linux
builds, AppImage and RPM checks, and the combined tagged release are paused.
Set the repository Actions variable `ENABLE_CROSS_PLATFORM_BUILDS` to `true`
to restore them. Unset or `false` keeps them disabled.

Ubuntu runners still run shared browser, script, workflow and performance checks,
upstream proposals, and macOS fork publication. These are support jobs, not
Windows/Linux application builds. `fork-build.yml` continues to build and publish
the Apple Silicon fork independently. The combined `release.yml` is gated at
preflight because its publication and updater feed require all platform artifacts;
skipping individual platform builds would otherwise break publication.

The preserved RPM jobs cover distinct build and clean-install failure modes.
The AppImage build also remains conditional on packaging inputs when re-enabled.

## Efficiency and reliability

- Rust jobs cache dependencies with the existing `Swatinem/rust-cache` action.
  RPM matrix entries use separate keys because Fedora and AlmaLinux have different
  system libraries. Cache misses still perform full builds.
- Clippy checks all workspace targets, so CI does not repeat `cargo check`.
  Clippy and tests use the committed lockfile with `--locked`.
- `test:host` invokes `pretest:host`, which compiles and type-checks the host.
  Workflows then call `node host/package.mjs` directly to package that build.
  Local `npm run host:package` remains self-contained.
- Superseded CI, performance and fork PR runs are cancelled. Fork main builds
  retain uninterrupted signing/publication; reusable builds use their requested
  ref in the concurrency key so they do not block main builds.
- Tagged releases validate version consistency and changelog coverage before
  any platform build. Repeated runs for the same tag are serialized. Different
  release tags can still run concurrently; this does not enforce feed version
  ordering across tags.
- Jobs have explicit time limits. Missing performance reports after an earlier
  failure no longer cause an additional summary-step failure.

## Validation

The existing CI workflow now runs all release/updater/sync script tests and a
pinned actionlint job. This closes the workflow-validation gap without adding a
separate workflow. Run the same checks locally:

```sh
node --test scripts/release-channel.test.cjs scripts/fork-updater.test.mjs scripts/upstream-sync.test.mjs
actionlint -shellcheck= -pyflakes=
```

The lint job checks YAML, workflow structure and GitHub expressions. ShellCheck
and Python linting are deliberately disabled; it does not prove runtime behavior.
See [actionlint](https://github.com/rhysd/actionlint) and
[Rust cache configuration](https://github.com/Swatinem/rust-cache).

No additional scheduled workflow is needed: performance measurement and upstream
proposals already have workflows. The reusable upstream build is retained as an
exact-commit check even though PAT-created PRs can also trigger normal CI. The
signed fork build also retains its own tests so manual/reusable invocations do
not depend on a separate CI run.

Cache savings, cold-build timeout margins, platform installers, and signed
publication must be confirmed on hosted runners. Local checks cannot establish
those results. macOS release builds still follow the other platform jobs; moving
them into parallel jobs would require a larger signing/artifact handoff change.
