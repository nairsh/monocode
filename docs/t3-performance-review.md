# MonoCode / T3 Code performance architecture review

Reviewed 2026-10-08. Scope: responsiveness, CPU, memory, transport, persistence, and rendering. Browser features and other new product features are excluded.

## Baseline and confidence

MonoCode: `b9c39710abb89bf98ef9ceda6d3c6ea6d9fde0fa` (the fork's custom navigation/composer/transcript commit). T3 Code: `95ccbf406626a8a80fa545777a6388bdf5153086`, fetched from `pingdotgg/t3code`. All T3 source links below are pinned to that revision. The comparison is of these sources, not necessarily the T3 binary currently installed on another machine.

This is a source-level architecture review, not a measured claim that one entire application is faster. Production MonoCode compilation and regression tests are recorded separately in the delivery notes. No comparative CPU, energy, frame-time, or resident-memory benchmark has been run. Build size is not runtime memory. Test fixture payload sizes are not end-to-end latency.

The central recommendation is to preserve MonoCode's Tauri/Rust foundation and borrow T3's limits on work: scoped state subscriptions, bounded history and transport, incremental processing, and demand-driven lifetimes. Replacing the desktop framework, adopting all of Effect, or changing local IPC to WebSockets would be a large change without demonstrated benefit.

## Existing architecture

MonoCode local: provider processes communicate through the native harness bridge; TypeScript adapters normalize events; `HarnessEventQueue` batches them; `App.tsx` applies batches to the sessions array; React renders session panes. Session persistence crosses Tauri IPC into the Rust SQLite store. IPC means communication between the native process and the web interface.

MonoCode remote: the Node host owns provider processes and SQLite state. It batches stream persistence every 120 ms. Desktop panes poll for revision-aware session deltas, through the native remote request layer. Unchanged revisions avoid downloading the transcript again. This is already substantially better than repeatedly fetching complete conversations.

T3: the server owns providers, durable events and projections (precomputed views of thread state). The client has separate shell and thread subscriptions over typed WebSocket RPC, bounded snapshot/history paths, and thread-specific reactive state. The desktop shell uses Electron. Its effective architectural ideas do not require moving MonoCode to Electron.

## Findings, ranked by likely value

### 1. Keep streamed text out of unrelated UI updates

**Evidence:** MonoCode `src/app/App.tsx:1558` batches incoming events, maps the entire active sessions array, calls `syncDockBadge`, and updates root React state. Other root effects depend on `sessions`, including persistence scanning. `src/app/model/harnessFlush.ts` schedules foreground output per animation frame and background output every 100 ms. `src/integrations/harness/core/apply.ts` already joins consecutive text deltas in a batch. Immutable block references and memoized transcript components prevent some downstream work, so this is not a claim that every component fully rerenders for every token.

T3 separates thread detail from shell state and derives narrow values with stable references in [threadDetail.ts](https://github.com/pingdotgg/t3code/blob/95ccbf406626a8a80fa545777a6388bdf5153086/packages/client-runtime/src/state/threadDetail.ts). A queued-count consumer need not change when only assistant text changes. [threads.ts](https://github.com/pingdotgg/t3code/blob/95ccbf406626a8a80fa545777a6388bdf5153086/packages/client-runtime/src/state/threads.ts) owns each thread's synchronization and lifetime.

**Transfer:** introduce a small per-session subscription boundary using the existing `useSyncExternalStore` pattern already used throughout MonoCode. Let the shell observe title, status, unread state and ordering; let the selected transcript observe blocks. Start with one provider/event path and keep existing persistence ordering. Do not replace the whole state system at once.

**Validation:** replay one foreground and five hidden streams; count shell, sidebar, composer and transcript commits. Unrelated shell renders should not scale with text-delta count. Preserve split panes, floating chats, approvals, queues, unseen completion markers and tab activation. Measure input latency and long tasks as well as render count.

### 2. Bound transcript DOM retention by cost, not just chat count

**Evidence:** `TranscriptPool.tsx` retains up to 12 parked transcripts, plus visible ones. Parking detaches the container and keeps its React tree and DOM alive to make revisits fast. There is no node/size budget or idle expiry in that pool. Separately, `sessionCache.ts` already caps saved session objects at 12 entries and an estimated 32 MiB. Those are different caches; the object-cache limit does not bound retained DOM. Active sessions intentionally remain alive.

`AgentTranscript.tsx` initially renders a small recent window (3 first-paint turns, normally expanding to 20), then adds older pages. `content-visibility` reduces offscreen layout/paint work, but loaded DOM remains allocated. Grouping caches avoid recomputing settled turn items; the grouping pass itself still scans blocks when the blocks array changes (`transcriptTurnCache.ts`).

T3 uses [LegendList in MessagesTimeline.tsx](https://github.com/pingdotgg/t3code/blob/95ccbf406626a8a80fa545777a6388bdf5153086/apps/web/src/components/chat/MessagesTimeline.tsx), including a virtualized expanded tool list. Virtualization means mounting only a region around the viewport. Its [threadRetention.ts](https://github.com/pingdotgg/t3code/blob/95ccbf406626a8a80fa545777a6388bdf5153086/packages/client-runtime/src/state/threadRetention.ts) retains recent snapshots for five minutes while live detail subscriptions end when consumers leave. This is a data lifetime policy, not proof of a global memory cap.

**Transfer:** first give parked transcript views a cost budget or idle expiry while retaining lightweight session and scroll state. Keep small recent chats warm; evict expensive parked views earlier. Then assess true turn/tool-row virtualization for long histories. Do not blindly reduce the pool from 12 to 1: that can trade memory for expensive reparsing on every switch.

**Validation:** revisit 12 small chats and 12 large chats; record retained nodes and memory after settling. Test selection, transcript search, jumping to a result, expand/collapse, prepending older history, scroll anchoring, floating chats and split panes. A viewport window must still support searching unloaded history.

### 3. Remote responsiveness is currently limited by polling cadence

**Evidence:** `RemoteSession.tsx:353` schedules the next request after the previous completes: 750 ms while busy, 3 seconds when idle and visible, 10 seconds when idle and hidden, with failure backoff. Thus delivery delay includes the polling interval and request time. `connections.ts` separately shares machine-health polling across subscribers, normally every 15 seconds. Remote file browsing also refreshes on a 5-second interval while the document is visible.

T3's [RPC session](https://github.com/pingdotgg/t3code/blob/95ccbf406626a8a80fa545777a6388bdf5153086/packages/client-runtime/src/rpc/session.ts) has connection readiness, a 15-second open timeout and ping/disconnect handling. [ws.ts](https://github.com/pingdotgg/t3code/blob/95ccbf406626a8a80fa545777a6388bdf5153086/apps/server/src/ws.ts) supports separate shell/thread replay and live streams.

**Transfer:** for remote sessions, add a host-owned push subscription, one transport per machine, with a last-received revision, deduplication, reconnect backoff and fallback snapshots. Retain polling compatibility during protocol rollout. The exact transport may be WebSocket or another suitable streaming protocol; cursor correctness, multiplexing and flow control matter more than the name. Keep local Tauri IPC.

**Validation:** compare provider-event-to-paint delay, idle network traffic, disconnect/reconnect, sleep/wake and multiple panes observing the same remote chat. Never replay a user command merely because a response was lost; command receipts must remain authoritative.

### 4. Bound live queues and reconnect work in both items and bytes

**Evidence:** MonoCode's `HarnessEventQueue` is time-batched but has no explicit event-count/byte ceiling. Host live events are similarly time-batched. `host/store.ts` retains roughly 2,000 revisions of event history and can read the entire available replay range. Native remote responses have a 16 MiB cap and large sync transfers are chunked; a transport cap does not bound all server allocations before serialization.

T3's [LiveStreamBudget.ts](https://github.com/pingdotgg/t3code/blob/95ccbf406626a8a80fa545777a6388bdf5153086/apps/server/src/orchestration-v2/LiveStreamBudget.ts) budgets a subscription at 1,000 retained items and 8 MiB serialized data, including delivery waiting for acknowledgment. Size estimates use a weak-reference cache. Overflow terminates the stream with a resumable error rather than accumulating indefinitely. Replay paths can retain more than one separately budgeted stage; these are not whole-process limits. `ws.ts` checks replay payload size and uses snapshots for large gaps. It subscribes before reading a high-water mark and deduplicates overlap, protecting the gap between replay and live delivery.

**Transfer:** add explicit budgets to the existing event queue and host replay before adding a push transport. Prefer ordered early flush, resumable snapshots, or controlled disconnect over dropping arbitrary events. Approval, completion, question and failure events must survive. Test huge individual payloads as well as many small events.

### 5. Do not ship full tool output in every overview or history update

**Evidence:** MonoCode remote delta sync sends changed blocks and the full block-ID ordering. Full snapshots still contain full session blocks. Host persistence serializes the complete session on each persisted batch (`host/store.ts:170`), despite delta delivery on the network. The host's recently used session cache has an entry count of 32 without a byte cap.

T3 [WireProjection.ts](https://github.com/pingdotgg/t3code/blob/95ccbf406626a8a80fa545777a6388bdf5153086/apps/server/src/orchestration-v2/WireProjection.ts) omits or summarizes heavy tool output on the live path, with on-demand bounded detail reads. [threadHistoryPaging.ts](https://github.com/pingdotgg/t3code/blob/95ccbf406626a8a80fa545777a6388bdf5153086/apps/server/src/orchestration-v2/threadHistoryPaging.ts) uses turn-aware progressive history. Its nominal policy is 10 user turns, 75 items and 1 MiB encoded data, with exceptions to avoid splitting normal turns; these numbers must not be described as universal hard caps.

The [transport performance fixture](https://github.com/pingdotgg/t3code/blob/95ccbf406626a8a80fa545777a6388bdf5153086/apps/server/src/orchestration-v2/ThreadTransportPerformance.test.ts) uses 600 command rows with 8,192-byte outputs and checks a projected snapshot ceiling of 131,072 JSON bytes against a recorded full RPC snapshot of 10,375,121 bytes. This is evidence of the intended transport contract; it was not executed in this review and is not a MonoCode/T3 speed benchmark.

**Transfer:** lightweight block summaries plus explicit detail loading for large completed tools; progressive history on disk and over the wire; byte-aware host snapshot cache. Preserve error indicators and copy/download access to full output. Test oversized output, Unicode, images, retry after deletion, and old host compatibility.

### 6. Make persistence proportional to changed data

**Evidence:** local `sessionStore.ts` serializes writes per session, preventing older writes overtaking newer ones. Mono sessions already use changed suffixes. Ordinary sessions sanitize full block lists and call `session_upsert`; Rust serializes block JSON under the session-store path. `App.tsx` fingerprints unchanged saves, debounces routine writes by 650 ms and avoids ordinary foreground-stream persistence except at relevant boundaries. These existing protections must remain.

The remote host applies events immediately but persists a complete JSON snapshot plus event batch every 120 ms. With long histories this repeatedly serializes old text and writes it to SQLite. `DatabaseSync` means this work occupies the host JavaScript thread. This is a plausible increasing cost, not a measured bottleneck on this Mac.

T3 separates durable server state from client cache persistence. The client [persists settled projections outside active streaming](https://github.com/pingdotgg/t3code/blob/95ccbf406626a8a80fa545777a6388bdf5153086/packages/client-runtime/src/state/threads.ts). That is not permission to postpone authoritative server durability indefinitely.

**Transfer:** profile serialization and transaction duration first. Extend the existing changed-suffix/block strategy where it wins, or checkpoint snapshots less frequently while durably recording ordered changes. Define crash-recovery and compaction behavior before changing storage. Keep queue ordering and deletion barriers.

### 7. Reuse completed parsing and highlighting work

**Evidence:** MonoCode's `codeHighlightPlugin.ts` already fixes unbounded highlighter caching with a 100-entry / 500,000-character exact-key cache, lazy languages and shared highlighters. Streaming versions of a growing code fence are distinct inputs, so a bounded cache controls retention but does not itself make tokenization incremental. `AgentMarkdown.tsx` uses Streamdown and paced/fading text; changing the pipeline without checking its existing block behavior could regress Markdown correctness.

T3's [incrementalHighlighting.ts](https://github.com/pingdotgg/t3code/blob/95ccbf406626a8a80fa545777a6388bdf5153086/apps/web/src/lib/incrementalHighlighting.ts) resumes after completed lines with grammar state and reprocesses the current line. [markdown-incremental.ts](https://github.com/pingdotgg/t3code/blob/95ccbf406626a8a80fa545777a6388bdf5153086/apps/web/src/markdown-incremental.ts) reuses a completed fenced prefix while falling back for document-wide definitions and tricky inputs. [DiffWorkerPoolProvider.tsx](https://github.com/pingdotgg/t3code/blob/95ccbf406626a8a80fa545777a6388bdf5153086/apps/web/src/components/DiffWorkerPoolProvider.tsx) shares lazily created diff workers and expires idle workers after 30 seconds, with a bounded AST cache.

**Transfer:** add incremental highlighting behind MonoCode's existing plugin interface, with exact full-pass equivalence tests. Only move expensive processing to a worker after measuring scheduling and serialization cost. Keep worker count bounded and terminate idle workers. Do not bring in a second Markdown framework merely to copy the optimization.

**Validation:** multiline strings/comments, embedded languages, changed prefixes, CRLF, Unicode, unclosed fences, language changes and theme changes. Compare long-fence CPU time and main-thread stalls, not just cache hits.

### 8. Scope file refreshes to relevant projects

**Evidence:** `fileTree.ts` retains a global directory map and `refreshCachedDirs()` relists every cached folder concurrently. There is no directory-count budget. A focus event or remote tree refresh can therefore cause work for folders visited earlier. `fileIndex.ts` already has an eight-project cache, in-flight deduplication and a 150 ms refresh delay, but tree refresh and index refresh have different scopes.

**Transfer:** track active project roots/subscribers, refresh affected folders, bound dormant directory caches, and limit concurrent directory reads. Keep focus-based recovery for missed changes. This is a direct MonoCode opportunity independent of any framework transplant.

**Validation:** visit many projects, then focus one window; assert the number of directory reads depends on the visible project, not all historical folders. Cover remote paths, deleted folders and file writes while hidden.

### 9. Startup, animation and background CPU need production traces

MonoCode already lazy-loads several major surfaces and uses separate quick-composer/floating-chat HTML entries. The production build reviewed emitted an approximately 1.58 MB App JavaScript chunk (0.49 MB gzip) and other large dynamic chunks. Those numbers identify things to inspect, not proof that all chunks execute at launch. Tauri uses the system webview; framework labels alone do not establish the total process-tree memory or energy use.

Measure initial imports, highlighter initialization, provider discovery, file prefetch, session hydration, animation loops and hidden-window work. Keep visual effects and user preferences intact unless a trace identifies a material cost. Record the renderer/webview processes as well as the Rust process and provider children; otherwise measurements can attribute provider workload to UI design incorrectly.

## Implementation order and acceptance plan

1. Establish a production baseline: same machine, same transcript fixture, same provider output recording, same window size. Record median and slow-tail input-to-paint, thread-open latency, streaming frame time, retained DOM, whole app process memory, idle CPU, request counts and disk writes. Separate local and remote runs. Repeat cold and warm runs.
2. Narrow state subscriptions and scope directory refreshes. These target unnecessary work without changing the wire protocol or durable data model.
3. Budget parked views and host caches; test huge histories and repeated tab switching. Retain the current small-chat revisit speed.
4. Incremental highlighting and optional bounded workers, justified by traces.
5. Remote payload projection, history paging and queue budgets; then push transport with reconnect and compatibility tests.
6. Persistence changes only after timing serialization and defining crash recovery.

Acceptance fixtures: 20/200/2,000 turns; many tool rows; a multi-megabyte code block; one foreground plus five background streams; twelve chat revisits; remote disconnect during a tool completion; sleep/wake; and an idle window after all runs settle. Keep existing navigation/composer/transcript-group regression tests in every stage. Do not claim improvement until the same fixture improves with no functional regression.

No T3 implementation code has been copied in this change. If later copying substantial portions, retain its MIT copyright and license notice. The present deliverable records transferable designs and their tradeoffs, while leaving runtime behavior unchanged during release preparation.
