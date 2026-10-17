# Cloud implementation and upstream review — 2026-10-17

Branch: `codex/voice-projects-upstream` in `nairsh/monocode`.
Implementation, Git operations, tests, native execution and browser verification
were performed in `/workspace/monocode` in the managed cloud environment.
No local Mac, private desktop-app data, proprietary source, or Imagegen was used.

## Upstream integration

- Clean starting fork commit: `c8fb46938eca3761a040847c2399e166f1ccecc1`.
- Fetched upstream main: `b653a397d180d98097a5f214e9bbdae68d837239`
  (v0.14.0), 94 upstream commits not reachable from the starting fork.
- Merge base: `49b4e5231d8a9c271d5a401f6074e1caa6e282e1`.
- Merge commit: `679e9d39`. Twelve paths conflicted, including the package
  manifests, App, project rail, title bar, usage footer, deleted Mono panels,
  transcript, model picker, session pane and popover.
- Resolutions retain the fork's project/thread rail, issue integration, hidden
  model choices and ghost controls, per-session live publication, parked and
  virtual transcript behavior, executable resolution cache, context meter,
  signed fork updater key/feed and fork delivery workflows. Upstream's new Mono
  overview, settings, provider corrections, remote worktree targeting, Git path
  handling, editor improvements and host fallback are included.
- Native QA found two composition regressions: a ref-first session addition
  needed shell publication, and the merged Mono pane rendered both composers.
  Both are corrected with regression coverage. Live activity subscriptions were
  migrated to the replacement activity view.
- The fork version base advances to `0.14.0-fork.0`, retaining its existing
  verification key and `nairsh/monocode` update endpoint.

### Change withheld as supplied

Upstream's new HTML artifact CSP allowed arbitrary HTTPS script, image, style,
font and media resources. Blocking `connect-src` alone does not block exporting
private document content in resource URLs. The merge blocks remote resources,
while retaining inline scripts and embedded data/blob resources in the opaque
sandbox. A Rust regression check covers this policy. HTML that depends on remote
CDNs now needs embedded resources. This is a focused integration review, not a
claim of an exhaustive security audit of upstream or its dependencies.

## Implemented behavior

### Issue voice commands

The issue/kanban header opens a project-scoped command dialog. Supported runtimes
use browser speech recognition; capture has an optional real audio meter and
releases recognition, microphone tracks and Web Audio resources on stop/unmount.
An unavailable speech runtime exposes the typed command path explicitly.
macOS packaging declares microphone/speech usage descriptions and the audio-input
entitlement; these declarations do not establish recognition support or prove
that a user granted access on macOS.

Explicit create, priority/status and Start-agent commands work without a model
turn. More general commands use the configured triage provider/model/account to
produce a constrained action plan. The planner is not granted app access and
approvals are denied. Only the selected project's issue data is sent. The user
reviews the transcript and actions before applying. Mutations use the existing
issue command handler and agent dispatch, including dependency/run guards;
stale previews and cross-project IDs are rejected. Partial failures report
completed progress instead of claiming the remaining actions succeeded.

### Projects and sidebar

The repository context menu opens one durable project coordinator, reusing the
existing Mono conversation, providers, memory, artifacts, completion reporting
and scheduler. Its overview adds Threads, Library and Scheduled tasks labels,
resize/full-screen/close, search and existing filters. Suggested draft threads
have individual, selected and bulk Start actions. Thread groups show counts,
collapse, reorder controls and status. Starts submit through the normal provider
path and register completion reports.

General settings include the project goal, independent thread model/effort,
auto-continue after usage resets, pause/restart, archive and deletion through the
existing confirmation flow. New threads receive the user instructions and the
coordinator's current memory. Environment settings choose current checkout or a
new worktree; repository/remote-host bindings reuse MonoCode's existing controls.
Library supports search, type filtering, grid/list, document creation, text-file
and folder imports, folder navigation and artifact opening. Imports are limited
to supported text formats under 2 MB per file.

Session cards lead with the title and repository/branch context, expose overflow
actions and preserve recorded coordinator provenance. This does not infer a
session's origin from its folder name.

## Exact validation

| Check | Result |
| --- | --- |
| `NODE_OPTIONS=--no-experimental-webstorage npm run check:web` | 513 files passed, 2 skipped; 5,628 tests passed, 13 skipped; TypeScript passed |
| `npm run check:rust` with cloud activation | Formatting and all-target workspace Clippy with warnings denied passed; 626 tests passed, 1 ignored |
| `npm run test:host` under the existing cloud child-reaper wrapper | 22 files passed, 1 skipped; 124 tests passed, 5 skipped; production host build passed |
| `node --test scripts/upstream-sync.test.mjs scripts/fork-updater.test.mjs` | 8 passed |
| `npm run build -- --mode fork` | Production TypeScript/Vite build passed |
| `cargo build --locked` with cloud activation | Native Linux debug build passed |
| Chromium browser suite | All 22 tests passed, including the 3 added project/voice flows |
| Whitespace | `git diff --check` passed |
| macOS permission declarations | Release and generated dev-bundle plists parsed; microphone/speech descriptions and audio-input entitlement checked; execution remains unverified |

The first host run without the child-reaper wrapper had three process-tree tests
fail because container PID 1 retained terminated orphan descendants as zombies.
The existing `/workspace/.monocode-env/reap.py` wrapper resolves that environment
condition; the same tests pass without changing host termination code. The first
web run exposed merge regressions; they were resolved before the final full run.

Production build warnings remain for CSS optimizer recognition of transcript
`::highlight` selectors and large output chunks. The build exits successfully.

## UI evidence and limits

The flows under test were project overview → suggested thread starts → status
groups; Library → create/import/search/list; project settings → saved goal,
instructions and checkout; and issue commands → preview → store mutation.

Cloud Chromium used `/usr/bin/chromium` at 1440×1000 and a compact 640×850 voice
viewport. Page identities, meaningful content, interaction state changes and
screenshots were checked; the new flows recorded no uncaught page errors. These
fixtures use production UI components with simulated native persistence and
provider callbacks. A separate speech test simulates recognition events and
capture cleanup; it is not live microphone evidence. Existing transcript,
animation responsiveness, tab movement/revisit and media tests also pass.
The separate console/response check identified only a missing fixture favicon;
both target fixtures now reference the existing app icon. The focused flows and
console check were rerun after that test-only correction.

The real Linux Tauri app was launched in Xvfb with isolated XDG state under
`/workspace/work/native-qa`. Native evidence covers project context navigation,
cold coordinator restoration, a single composer, the overview header and the
real command dialog. The native GTK WebKit runtime reports speech recognition
unavailable and displays the typed fallback.
The real native flow `Create an issue called Cloud native QA` → Review → Apply
created `MC-2` with the requested title on the board; the full preview and result
are captured separately. Native input was paced to let the container webview
process key events before clicking Review.

Evidence and logs are retained in `/workspace/work/evidence` and
`/workspace/work/*.log`. Selected screenshots are `project-threads.png`,
`project-library.png`, `project-settings.png`, `voice-preview.png`,
`voice-compact.png`, `voice-simulated-listening.png`, `native-cold-start.png` and
`native-voice-cold.png`. The projectless chat output path is read-only in this
cloud machine, so evidence is retained in the cloud workspace instead of that
export directory.
The final selected screenshots/logs are packaged in
`/workspace/work/cloud-qa-evidence.zip` with a checksum manifest. Intermediate
screenshots include pre-fix/transient states and are not final validation proof.

The branch was pushed successfully. Creating a draft PR through the cloud CLI
was blocked by `Post https://api.github.com/graphql: Forbidden`; no connector or
alternate network route was used to bypass that restriction. Review it at
`https://github.com/nairsh/monocode/compare/main...codex/voice-projects-upstream`.

### Reference mismatch ledger / remaining risks

- The supplied Claude observations establish behavior, not exact dimensions or
  runtime internals. Projects reuse MonoCode's Mono/provider model, mascots,
  permission semantics, SSH hosts and scheduler. They do not implement Claude
  Remote Control or invent an unconnected cloud-environment selector.
- Codex voice animation measurements and exact Claude styling references were
  not supplied. Listening, planning and action states are implemented, including
  reduced motion, but **no 1:1 visual or timing match is claimed**.
- Live microphone transcription and live voice-launched provider execution were
  not verified. Model planning and dispatch integrations have focused tests;
  browser Start controls use simulated provider callbacks. CLI login status by
  itself is not execution evidence.
- WebKit browser binaries could not be downloaded because network policy denies
  `cdn.playwright.dev`; the installed Chromium was used without bypassing that
  policy. Native GTK WebKit smoke is separate from a Playwright WebKit run.
- No macOS/Windows packaging, Apple notarization/signing, real SSH-host session,
  long-running schedule/reset recovery or hosted Actions result is claimed.
- Fork main was not changed or force-pushed. Upstream is integrated on the
  review branch; release/main integration remains a normal review decision.
