# T3 performance commit review — 2026-10-08

## Coverage and evidence

This follow-up examines change history, complementing [the architecture review](t3-performance-review.md). MonoCode starts at `c49bac429ac9bdad72f2dd9317191e4dfc7cce3c`. T3 was fetched again and pinned to `300f7f9d45ff19c01bc987dbf1c3bc3e9a3a59ee`; its newest commit is an unrelated composer feature.

The bounded history query was `git log <pinned-sha> --since=2026-09-07`: 1,351 commits, including **52 whose subjects begin with perf**. Every one of those 52 is inventoried below. Relevant desktop/shared/server production patches were examined alongside MonoCode code; mobile-only and delivery-only changes were triaged out. Additional performance-related fixes are discussed separately. This is not a claim to have audited every line of all 1,351 commits, or every performance change in T3's entire history. Commit dates below are Git committer dates. Titles containing multipliers or percentage savings are not adopted as measured MonoCode results.

No T3 binary was benchmarked against MonoCode. The measured evidence here is regression-fixture work counts and functional equivalence. Some historical T3 changes affect its legacy `orchestration/` backend rather than the current `orchestration-v2/` implementation; copying an old patch into a new architecture would be wrong.

## What was transferred in this batch

### Stable thread/sidebar summaries

Sources of the principle: [unchanged shell metadata suppression](https://github.com/pingdotgg/t3code/commit/c138163c8), [stable per-file props](https://github.com/pingdotgg/t3code/commit/f21d6da51), and [batched publication](https://github.com/pingdotgg/t3code/commit/e145c5f22). This is a MonoCode summary selector, without a protocol or state-store rewrite.

The root's history/open-thread projections now compare the metadata those summaries consume before rebuilding. Text-only updates retain the existing arrays and transient timestamps. Title, model/runtime, project/worktree, visibility, draft, persistence eligibility, linked work item, automation, busy/input and membership changes still publish. Actual saved-history revisions always publish, including updated timestamps, pin/archive/order changes. Live orchestration revisions and worker approval/question transitions publish; hidden ephemeral sessions keep their prior exclusion. The cache retains metadata and summary rows, never full transcript blocks.

Sidebar folder merges, visibility filtering and session filter/sort now use these stable inputs, together with live busy/approval/unread sets, worktree focus, filter/query state and its existing 30-second clock. The unrelated-shell-render fixture performs **zero additional session-query filters and zero session-order comparisons over 30 updates**; changed title input resumes both. The token-update fixture performs **zero new summary timestamps over 30 updates** and preserves both projection arrays. Existing action, rename and status tests run alongside these checks.

This skips defined projection/list work; it does not isolate the whole shell from streams. The broad root still renders and checks session metadata, draft/persistence predicates may scan blocks, and orchestration workers still scan approval state. Ordinary busy chats retain the existing approval-scan short circuit. Sidebar still scans hidden-habit IDs and observes its Mono roster so independent visibility changes remain correct. Other Sidebar derivations and changing root props can still render. No whole-app CPU, energy or latency percentage is claimed.

### Incremental code highlighting

Source: [completed-line highlighting](https://github.com/pingdotgg/t3code/commit/d7d7f8f3e) and [stable completed-line DOM](https://github.com/pingdotgg/t3code/commit/8078c532c).

MonoCode's existing `codeHighlightPlugin.ts` already bounded exact-result caching, but every new version of an open code fence was a cache miss and re-tokenized its entire source. It now retains completed token lines and the syntax parser's state, then processes only newly completed lines and the unfinished tail. Token offsets are rebased to the full source. It preserves both light and dark token styles.

The plugin API has no document identifier. Therefore reuse requires an exact source-prefix match and the same language/theme pair; interleaved documents can lose the optimization but cannot reuse a different prefix. At most eight language/theme prefixes and 500,000 source characters are retained by default, separately from the existing result-cache budget. These character counts are not byte-accurate heap limits. Oversized inputs and CRLF use the full path. Historical edits fall back when their prefix no longer matches. No new dependency or Markdown framework was added.

Fixture: 200 completed lines (3,200 characters), followed by 30 growing-tail updates. Full highlighting would submit **96,465 characters** to the tokenizer. The new path submits **465 characters** after the initial prefix, a **99.5% reduction in characters tokenized for this fixture**. This excludes initial parsing, cache lookup, prefix comparisons, array assembly, React reconciliation and browser paint; it is not a 99.5% whole-app speedup.

Equivalence checks compare token content, offsets and styles against full Shiki passes for TypeScript multiline comments/template strings, Python triple-quoted strings, HTML with embedded script/style, Unicode, CRLF, empty lines, edits and interleaved source. Existing cache bounds, oversized input, concurrent request, alias and plain-text fallback tests pass. Completed token-line arrays retain identity, but equivalent DOM/selection savings to T3's renderer are not yet established because MonoCode uses Streamdown.

The adaptation is attributed in `NOTICE`, including T3's MIT license. `NOTICE` is now bundled as an application resource.

### Explorer work follows mounted projects

Sources of the principle: [passive sidebar subscriptions](https://github.com/pingdotgg/t3code/commit/5055de3ae), [project refresh loop removal](https://github.com/pingdotgg/t3code/commit/8bc40b4e0), [shared active metadata probes](https://github.com/pingdotgg/t3code/commit/1a3f7ad50), and [bounded filesystem work](https://github.com/pingdotgg/t3code/commit/71dbaf1f9). This is a MonoCode-specific implementation, not a port of T3's Git service.

Previously, a focus event, agent write or remote explorer timer re-listed every cached directory from all previously visited projects, with unlimited concurrent refresh calls. Simultaneous reads of a cold folder also launched duplicate calls.

Now:
- Mounted FileTree instances retain their project roots; automatic refreshes read cached folders under those roots only.
- Dormant project cache entries are invalidated without background reads. A revisit reads fresh data.
- Simultaneous reads of the same folder share one pending promise.
- A forgotten/replaced request cannot repopulate the cache after a newer request completes.
- Refreshes use at most four workers per refresh pass, and the directory listing cache retains at most 256 entries.
- Explicit single-folder refreshes and change notifications for the Git/index consumers remain.

Tests verify one native read for simultaneous callers, newer data surviving late old responses/failures, cold pre-write requests being reread after a change, deleted-parent descendant invalidation, root/trailing-slash/remote path boundaries, zero inactive-project reads during an automatic refresh, a maximum of four concurrent refresh-worker reads, and eviction after visiting 300 folders. The worker limit does not cancel prior in-flight reads or cap manual directory calls or the separate expanded/selected UI-state maps. Refreshes still cover cached collapsed folders within a mounted project; per-visible-directory subscriptions could narrow that further if profiling justifies it.

## Important findings that should guide the next changes

### 1. Shell summaries must stop changing with token traffic

T3 repeatedly reduced work at the shell/detail boundary: batch publication, stable row props, narrow SQL reads, avoiding redundant schema traversals, suppressing unchanged shell updates, and single-copy Codex streaming text. The October 5 shell suppression retains a five-second resend to bound replay and keep update timestamps from drifting indefinitely. Merely dropping apparently redundant events can break cursor recovery.

MonoCode's `App.tsx` still owns a broad sessions array. `HarnessEventQueue` already batches text and independently schedules hidden streams; earlier fixes scoped cross-project sidebar database reads and row measurements. This batch stabilizes summary publication and memoizes the dependent session lists. Full separation of title/status/approval/unread subscriptions from blocks remains future work. Preserve split panes, floating windows, queues, persistence ordering and transient completion states. Acceptance for that larger change: replay a foreground and five background streams and show that unrelated shell commits do not grow with delta count.

### 2. Active-history rendering remains different from cache retention

T3 virtualizes history and has explicit displayed-thread identity during transitions. MonoCode's recent-window rendering, content visibility and parked pool reduce work but do not remove all loaded offscreen DOM. The earlier 20,000-node parked budget applies only to detached cached transcripts.

True active-history virtualization is a larger change: selection, search across unloaded history, variable-height tool rows, open disclosures, prepend anchoring and jump-to-result must all work. A virtualized command palette is lower priority here because `appSearch.ts` already caps each result group (for example 8 conversations in all-results mode and 24 in conversation mode). Do not add a second list library just to copy T3's implementation.

### 3. Provider lifetime can dominate memory independently of React

[T3's October 7 idle-thread unload](https://github.com/pingdotgg/t3code/commit/eba052156) addresses threads retained inside a shared Codex app-server. It uses a per-thread generation, attachment lock and background-work check so an old timer cannot unload a newly resumed turn. Stopping a shared process is not equivalent to unloading one idle provider thread.

MonoCode's `codex.ts` manages its own live RPC sessions and explicit stop/resume path. Before changing it, measure the native app, webview and provider child processes separately and record how many remain after many chats settle. Any idle release needs resume tests, approval/queued-message protection and proof that background commands are not killed. No new automatic provider termination was introduced in this batch.

### 4. Remote transport needs bounded payloads and recovery, not just a socket

T3's batch changes preserve snapshot/revert/delete handling. [The subsequent cached-turn fix](https://github.com/pingdotgg/t3code/commit/a5da32750) preserves a settled snapshot even when a new turn begins in the same batch and prevents an obsolete page response clearing a newer loading state.

[The slow-snapshot fix](https://github.com/pingdotgg/t3code/commit/b2577d6ef) lengthens a deadline because its old fallback asked the same slow server to build the same snapshot twice. The correct lesson is to avoid duplicate work, not to reduce every timeout.

MonoCode's remote polling has revision-aware deltas but still sends the full block ordering and large completed payloads. Next candidates are bounded detail/history reads, summary-only list data, shared machine subscriptions, explicit queue/replay budgets, and eventual push delivery with recovery. Do not transplant T3's Effect RPC transport or dependency patches into Tauri.

### 5. Background Git work requires freshness rules

T3 now separates passive sidebar status from remote polling, gives background PR lookup batches a longer window, checks cheap fingerprints before fetching expensive details, caches positive repository identity longer, and scopes refreshes to actual changes. It also checks filesystem state to invalidate repository detection and avoids caching executable-resolution misses.

MonoCode has a three-second native Git-info cache and listener-based project diff stats. Extending TTLs without handling branch/remote changes, nested repositories, deleted worktrees and explicit refresh would trade load for stale UI. The explorer fix is safe independently; further Git caching needs subprocess counts from a many-project fixture. The T3 PR feature set itself is outside this task.

### 6. Serialization and disk writes are separate costs

T3's usage work reuses encoded per-file fragments, bounds stat/read concurrency, preserves deterministic scan order and guards against old scans replacing newer state. Its shell cache avoids a second schema pass only where data is already in encoded form. Those optimizations do not justify removing input validation.

MonoCode's host `store.ts` serializes full session snapshots on persisted batches, whereas local persistence already uses fingerprints, debounce and changed Mono suffixes. A durable event/checkpoint strategy would reduce repeated old-text serialization, but requires crash recovery, compaction, deletion and interrupted-turn tests. The current batch does not alter durable storage.

### 7. CSS, typing and hidden-view fixes are highly specific

[T3's modifier fix](https://github.com/pingdotgg/t3code/commit/ed57bed8e) avoids dispatching React state at all when modifier values are unchanged, rather than relying only on a no-op state updater. Its quoted typing multiplier is not a MonoCode benchmark.

The broad sidebar descendant `:has` and composer sibling-selector fixes reduce style invalidation. MonoCode's `:has` uses are scoped to settings rows, transcript turns and code shells; the exact T3 wrapper rule is absent. Local selectors should be changed only with a style-recalculation trace.

[T3's hidden terminal fix](https://github.com/pingdotgg/t3code/commit/6989856aa) stops retained terminal drawers subscribing to full thread history. This matters when splitting MonoCode's future summary/detail store: hidden UI must not silently keep detail subscriptions alive.

### 8. Bound retained work without throwing away useful warm state

T3's [oversized diff cache fix](https://github.com/pingdotgg/t3code/commit/cb3d95c17) rejects heavy cache entries and checks identity before invalidating, so a late result cannot erase a newer entry. [Its keyed-lock refactor](https://github.com/pingdotgg/t3code/commit/37de6cbde) retains lock entries only while held or awaited. MonoCode's session write queue already deletes settled queue tails, so another lock framework is unnecessary.

Node/V8 compile caching is not a WebKit optimization, mobile audio initialization is not a Mac renderer optimization, and faster release CI does not make the installed app lighter. Those distinctions are recorded in the inventory.

## Performance-labelled commit inventory

“Candidate” means the relevant mechanism merits a MonoCode-specific change or measurement; it does not claim the exact patch has been ported. Excluded entries were classified for scope rather than subjected to a feature-level implementation audit.

| Date | T3 commit | Area / disposition | Transfer assessment |
|---|---|---|---|
| 2026-10-07 | [c93080b0a](https://github.com/pingdotgg/t3code/commit/c93080b0a3bf4faffb375169c5ec06adce05eb2f) | GitHub reads | Batch background branch lookups separately from interactive reads; fingerprint before fetching full PRs; share only active routing probes. Candidate for MonoCode inbox/PR paths, not a reason to add T3 PR features. |
| 2026-10-06 | [f21d6da51](https://github.com/pingdotgg/t3code/commit/f21d6da51c9aa78ea12e7f13a378f55f1e63cb38) | Diff rendering | Keep header inputs and retry/collapse handlers stable per file. Apply the principle when profiling MonoCode DiffPane; T3 component code and its diff library are not interchangeable. |
| 2026-10-06 | [71964e670](https://github.com/pingdotgg/t3code/commit/71964e670ff212006ebb8de26585649c2adced68) | Process startup | Cache successful executable resolution by command, PATH, platform and resolver; do not cache misses or explicit paths. Audit native/provider launches before adding another cache. |
| 2026-10-05 | [6bfc8baeb](https://github.com/pingdotgg/t3code/commit/6bfc8baeb8f280e57ef6d0d514680b0bce8538a2) | Excluded cloud feature | Relay tunnel cleanup is outside the requested desktop scope. Its bounded-worker principle is applied to explorer refreshes. |
| 2026-10-05 | [758dc290e](https://github.com/pingdotgg/t3code/commit/758dc290e900e35958d37fec41fed4a357ad60fa) | GitHub reads | Batch background branch lookups separately from interactive reads; fingerprint before fetching full PRs; share only active routing probes. Candidate for MonoCode inbox/PR paths, not a reason to add T3 PR features. |
| 2026-10-05 | [dcbaf0527](https://github.com/pingdotgg/t3code/commit/dcbaf05279984187b96c99edc2416abf91e77b96) | Git polling | Reuse origin lookups and repository identity; validate cached detection against disk and force refresh after mutations. MonoCode already has a short native Git-info cache; longer TTL needs correct invalidation. |
| 2026-10-05 | [c138163c8](https://github.com/pingdotgg/t3code/commit/c138163c8cc39d4a98b2d3d796bcef183013bac5) | Shell / provider / waits | Suppress unchanged shell updates with bounded cursor advancement; avoid duplicate Codex text; replace polling waits with relevant events. High-value follow-up; preserve completion and replay boundaries. |
| 2026-10-05 | [c71ca063d](https://github.com/pingdotgg/t3code/commit/c71ca063dfcd8c2e3dcb2bd92adbb2180cbbece3) | Excluded mobile implementation | Mobile-only renderer, recorder, platform imports or cache path. Shared principles are covered in desktop highlighting, subscriptions and serialization; no mobile features copied. |
| 2026-10-05 | [1c33f3b2b](https://github.com/pingdotgg/t3code/commit/1c33f3b2b2976b7f4e26698ed69c549de687a97e) | Excluded mobile implementation | Mobile-only renderer, recorder, platform imports or cache path. Shared principles are covered in desktop highlighting, subscriptions and serialization; no mobile features copied. |
| 2026-10-05 | [1a3f7ad50](https://github.com/pingdotgg/t3code/commit/1a3f7ad5085606463a602bd756ca9c04d106fffe) | GitHub reads | Batch background branch lookups separately from interactive reads; fingerprint before fetching full PRs; share only active routing probes. Candidate for MonoCode inbox/PR paths, not a reason to add T3 PR features. |
| 2026-10-04 | [bc2748241](https://github.com/pingdotgg/t3code/commit/bc2748241776066c532f3312a26f1756d9740f9c) | Font selection | Validate only the selected monospace font, not every installed font during enumeration. No equivalent eager full-font validation was established in MonoCode. |
| 2026-10-03 | [fffe6e6c8](https://github.com/pingdotgg/t3code/commit/fffe6e6c82c12769e0cbc4d89a23ec845c5abed1) | Search rendering | Virtualize results while keeping keyboard highlight independent of mounted rows. MonoCode search already caps each result group; lower priority than long transcripts. |
| 2026-10-03 | [71dbaf1f9](https://github.com/pingdotgg/t3code/commit/71dbaf1f94b580491d033f2e347a9b1c507fd793) | Usage scans | Bound file-stat/read concurrency, preserve scan order, reuse serialized file entries and rate lookups, and avoid stale scan writes. MonoCode usage paths differ; do not transplant T3's pricing/scanning subsystem. |
| 2026-10-03 | [39efcd855](https://github.com/pingdotgg/t3code/commit/39efcd855833a1486ff7662e2efcedeeee6be0cc) | CSS invalidation | Remove broad descendant :has dependencies around the whole chat. MonoCode has local :has selectors, but the exact root-wide T3 rule is absent; do not remove local styling blindly. |
| 2026-09-30 | [783ccf0fd](https://github.com/pingdotgg/t3code/commit/783ccf0fdde0d20824ad87af10a870fc28005835) | Excluded delivery infrastructure | Vercel, npm platform packaging, Windows release setup and CI scheduling do not reduce the installed Mac app's runtime load. |
| 2026-09-30 | [c57a04b72](https://github.com/pingdotgg/t3code/commit/c57a04b722f2172e3be2c8f73c936d10b4582431) | Excluded delivery infrastructure | Vercel, npm platform packaging, Windows release setup and CI scheduling do not reduce the installed Mac app's runtime load. |
| 2026-09-30 | [8630e1ac7](https://github.com/pingdotgg/t3code/commit/8630e1ac7a94cdae6f3014161db65385931cf3a2) | Excluded delivery infrastructure | Vercel, npm platform packaging, Windows release setup and CI scheduling do not reduce the installed Mac app's runtime load. |
| 2026-09-30 | [6f8e2534f](https://github.com/pingdotgg/t3code/commit/6f8e2534f2d935e6befa7353a003c4b59fe66f6f) | Excluded delivery infrastructure | Vercel, npm platform packaging, Windows release setup and CI scheduling do not reduce the installed Mac app's runtime load. |
| 2026-09-30 | [67b175a4c](https://github.com/pingdotgg/t3code/commit/67b175a4c916ac0d5dbac809da22271db3f542d7) | Excluded delivery infrastructure | Vercel, npm platform packaging, Windows release setup and CI scheduling do not reduce the installed Mac app's runtime load. |
| 2026-09-26 | [887266695](https://github.com/pingdotgg/t3code/commit/8872666957802b37c9fdd212e01f0024bcc102c6) | Idle work | Back off unlinked relay retries and query only live provider bindings. Transfer lifecycle-based scheduling; T3 Connect relay itself is out of scope. |
| 2026-09-26 | [9151ea407](https://github.com/pingdotgg/t3code/commit/9151ea407accd1b7af575dcdd514e2b2e3fe6cbb) | Serialization | Avoid encoding/decoding already validated shell rows twice; keep actual transforms and trust-boundary validation. MonoCode's full-snapshot host serialization is a separate cost. |
| 2026-09-26 | [1d6f23b51](https://github.com/pingdotgg/t3code/commit/1d6f23b51929117d5e69ded8c5c0f8e195d75d4a) | Scoped queries | Read one thread/project, unsettled threads, or PR-linked rows as needed instead of rebuilding all shell state. Some patches target T3's legacy v1 path; transfer the query principle, not those tables. |
| 2026-09-26 | [6f97b0f66](https://github.com/pingdotgg/t3code/commit/6f97b0f66a51fbafabd54a5616da8827ebdf6020) | Sorting / formatting | Compute date keys once per sort, filter before sorting, find maxima without sorting, reuse formatting. MonoCode summary timestamps are already numeric; avoid unnecessary decorate-sort allocations. |
| 2026-09-26 | [8b873eab0](https://github.com/pingdotgg/t3code/commit/8b873eab0d74b731bc0f387be84a8561eace789f) | Diagnostics | Stream trace files with bounded top-N results and skip empty instrumentation spans. No matching Effect tracing layer in MonoCode; retain as a principle for diagnostics work. |
| 2026-09-26 | [99efaeab5](https://github.com/pingdotgg/t3code/commit/99efaeab58297c7e346ee91a4f28044faed03c59) | Diagnostics | Stream trace files with bounded top-N results and skip empty instrumentation spans. No matching Effect tracing layer in MonoCode; retain as a principle for diagnostics work. |
| 2026-09-25 | [999161ef8](https://github.com/pingdotgg/t3code/commit/999161ef844a7a38c8a6d08195c1240759169832) | Git polling | Reuse origin lookups and repository identity; validate cached detection against disk and force refresh after mutations. MonoCode already has a short native Git-info cache; longer TTL needs correct invalidation. |
| 2026-09-25 | [3b0a495b0](https://github.com/pingdotgg/t3code/commit/3b0a495b0e05d11dbf88ff2148e7c21b49508172) | Scoped queries | Read one thread/project, unsettled threads, or PR-linked rows as needed instead of rebuilding all shell state. Some patches target T3's legacy v1 path; transfer the query principle, not those tables. |
| 2026-09-25 | [6989856aa](https://github.com/pingdotgg/t3code/commit/6989856aa630611dd7d6dcc8cfe9f97456816284) | Hidden views | Hidden terminals subscribe to shell summaries instead of retaining full thread detail. Relevant to a future per-session store; the existing MonoCode parked DOM cap addresses only a different retention layer. |
| 2026-09-25 | [b6eefc926](https://github.com/pingdotgg/t3code/commit/b6eefc926ae305f4cb85cca797668b010cee1136) | Serialization | Avoid encoding/decoding already validated shell rows twice; keep actual transforms and trust-boundary validation. MonoCode's full-snapshot host serialization is a separate cost. |
| 2026-09-25 | [574b18090](https://github.com/pingdotgg/t3code/commit/574b18090281225de3449816c8366f0ee9ab886c) | Shutdown | Rewrite only provider bindings actually stopped. Preserve resume cursors and active-turn recovery; no blanket changes to MonoCode shutdown. |
| 2026-09-25 | [6530de033](https://github.com/pingdotgg/t3code/commit/6530de0339d2ca49957d0039133c49e3a08557f7) | Scoped queries | Read one thread/project, unsettled threads, or PR-linked rows as needed instead of rebuilding all shell state. Some patches target T3's legacy v1 path; transfer the query principle, not those tables. |
| 2026-09-25 | [c216ba4da](https://github.com/pingdotgg/t3code/commit/c216ba4dade683bf3a7c96bf63b33a85afc1a16c) | Event application | Locate once, copy the array, replace one thread; return existing arrays for missing IDs. MonoCode already batches provider events, but root session-array fanout remains. |
| 2026-09-25 | [595a1e1f5](https://github.com/pingdotgg/t3code/commit/595a1e1f537f403eba408817c2aba35e61c2ac29) | Excluded mobile implementation | Mobile-only renderer, recorder, platform imports or cache path. Shared principles are covered in desktop highlighting, subscriptions and serialization; no mobile features copied. |
| 2026-09-25 | [525af2d1a](https://github.com/pingdotgg/t3code/commit/525af2d1ad4b6de847ea658c37a081fd7afe8ef6) | Excluded mobile implementation | Mobile-only renderer, recorder, platform imports or cache path. Shared principles are covered in desktop highlighting, subscriptions and serialization; no mobile features copied. |
| 2026-09-25 | [4293433ec](https://github.com/pingdotgg/t3code/commit/4293433eccbe6c6661acd020e584ae5d2234bf1e) | Git preview | Correct copied-index timestamp rounding to avoid unnecessary Git rereads. Specific to T3's temporary-index preview path; no equivalent workaround to remove in MonoCode. |
| 2026-09-24 | [d10bd1360](https://github.com/pingdotgg/t3code/commit/d10bd1360ace3ab1dbccc1ee706c9169982d98ae) | Desktop startup | Node/V8 compile cache enabled before Electron/backend imports; avoid leaking settings to child tools. Not applicable to the Rust/WebKit desktop shell. |
| 2026-09-22 | [151324b2c](https://github.com/pingdotgg/t3code/commit/151324b2c0bf0ace789820b8ea4ec8ceb55753d9) | Excluded mobile implementation | Mobile-only renderer, recorder, platform imports or cache path. Shared principles are covered in desktop highlighting, subscriptions and serialization; no mobile features copied. |
| 2026-09-18 | [53830d413](https://github.com/pingdotgg/t3code/commit/53830d413474b2a5749c040d4382c96002894b88) | Excluded mobile implementation | Mobile-only renderer, recorder, platform imports or cache path. Shared principles are covered in desktop highlighting, subscriptions and serialization; no mobile features copied. |
| 2026-09-18 | [e0649ed7d](https://github.com/pingdotgg/t3code/commit/e0649ed7d8f8b5f21d114ff2b09ef803184f1d05) | Excluded mobile implementation | Mobile-only renderer, recorder, platform imports or cache path. Shared principles are covered in desktop highlighting, subscriptions and serialization; no mobile features copied. |
| 2026-09-14 | [a37b85279](https://github.com/pingdotgg/t3code/commit/a37b85279d71f958482cb8b6fef1886cdb43f364) | Worktrees | Fetch the requested ref and use configured parallel checkout workers, with narrow fallback. Benchmark large-repo checkout separately; maximum worker count may raise peak Mac CPU. |
| 2026-09-12 | [b1e223e2b](https://github.com/pingdotgg/t3code/commit/b1e223e2b0d87124883b1410ab52dd6a1338e40d) | Scoped queries | Read one thread/project, unsettled threads, or PR-linked rows as needed instead of rebuilding all shell state. Some patches target T3's legacy v1 path; transfer the query principle, not those tables. |
| 2026-09-12 | [ca6416ec2](https://github.com/pingdotgg/t3code/commit/ca6416ec2d1d194738bc78a81df4b82a75cb72e2) | Sorting / formatting | Compute date keys once per sort, filter before sorting, find maxima without sorting, reuse formatting. MonoCode summary timestamps are already numeric; avoid unnecessary decorate-sort allocations. |
| 2026-09-11 | [e145c5f22](https://github.com/pingdotgg/t3code/commit/e145c5f22a10d7433420b447537ed3f29a66d7d9) | Batching / sidebar | Apply stream batches once, construct only required HTTP API groups, stabilize drag props and budget bulk fade animations. Preserve snapshot/revert/delete boundaries; MonoCode already has batching and prior sidebar fixes. |
| 2026-09-11 | [6e8931d75](https://github.com/pingdotgg/t3code/commit/6e8931d75615ec020e602e97df2694b0541a6272) | Batching / sidebar | Apply stream batches once, construct only required HTTP API groups, stabilize drag props and budget bulk fade animations. Preserve snapshot/revert/delete boundaries; MonoCode already has batching and prior sidebar fixes. |
| 2026-09-11 | [7bd7f99e6](https://github.com/pingdotgg/t3code/commit/7bd7f99e6cab940892ff9240549c507bfd066aee) | Excluded mobile implementation | Mobile-only renderer, recorder, platform imports or cache path. Shared principles are covered in desktop highlighting, subscriptions and serialization; no mobile features copied. |
| 2026-09-11 | [2b7d3a45e](https://github.com/pingdotgg/t3code/commit/2b7d3a45e6ee9454e4dd46aaf0276ca05d8555d3) | CSS invalidation | Remove broad descendant :has dependencies around the whole chat. MonoCode has local :has selectors, but the exact root-wide T3 rule is absent; do not remove local styling blindly. |
| 2026-09-10 | [211618fd9](https://github.com/pingdotgg/t3code/commit/211618fd9fe39d3dde01171a6856ce9f633571c9) | Thread switching | Retain displayed-thread identity while preparing a replacement; reset per-thread row state without blanking the pane. MonoCode uses a distinct transcript pool; preserve its scroll and split-pane behavior. |
| 2026-09-10 | [8078c532c](https://github.com/pingdotgg/t3code/commit/8078c532ceeee5cb951325031f216171507f3d5e) | Code DOM | Retain completed line node identities and selection after streaming finishes. New MonoCode token prefixes retain completed line arrays; Streamdown remains responsible for DOM rendering, so equivalent DOM savings are not yet proven. |
| 2026-09-10 | [d7d7f8f3e](https://github.com/pingdotgg/t3code/commit/d7d7f8f3eb7bf593925281eb62348e15a91252b8) | Implemented: highlighting | Adapted completed-line grammar-state reuse to MonoCode's dual-theme token API, rebasing offsets, bounding retained prefixes and falling back for CRLF/large inputs. MIT attribution included. |
| 2026-09-10 | [a9dabbf10](https://github.com/pingdotgg/t3code/commit/a9dabbf100d1f6c0b2ed7b5e879d469ac14fd186) | Markdown parsing | Reuse only safe closed-fence prefixes; fall back for reference definitions, footnotes, CRLF, BOM and unknown syntax. Defer until Streamdown's existing incremental processing is profiled. |
| 2026-09-10 | [8fc253605](https://github.com/pingdotgg/t3code/commit/8fc253605e6d203c3654dbb1ce22fa1fd6fa0767) | Deferred formatting | Keep raw minimap text and format only an opened preview. MonoCode prompt navigation differs; useful principle, not a reason to add a minimap. |
| 2026-09-06 | [252df7742](https://github.com/pingdotgg/t3code/commit/252df7742047af8a1b859dc652b2f40b639d16b3) | Batching / sidebar | Apply stream batches once, construct only required HTTP API groups, stabilize drag props and budget bulk fade animations. Preserve snapshot/revert/delete boundaries; MonoCode already has batching and prior sidebar fixes. |

## Validation and remaining limits

- 4,864 web tests passed, 13 skipped; 457 test files passed.
- The highlighter suite passed 9 tests, including full-token equivalence and the parsing-work fixture.
- The explorer/cache/index targeted run passed 41 tests.
- TypeScript checking passed. Production packaging is recorded in the delivery notes.
- No new dependencies, browser features, mobile features, telemetry collection or background T3 monitor were added.
- The existing fork build and upstream merge-proposal workflows remain. The prior c49bac4 GitHub macOS build completed successfully during this review.
- Whole-app frame times, input latency, idle energy and process-tree memory still need production traces. Source analysis and work-count fixtures cannot establish those outcomes.
