# Workflow maintenance

CI preserves the three-platform web/Rust and standalone-host checks, both
browser engines, Fedora and Enterprise Linux RPM builds, and the clean RPM
installation check. The AppImage build remains conditional on packaging inputs.
These jobs cover different failure modes; in particular, installing an RPM on a
build machine cannot replace installing it without development libraries.

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
