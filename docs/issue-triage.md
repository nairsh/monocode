# Backlog triage and agent issue access

Choose a **Triage model** using the normal agent/model dropdown in the triage
scope panel or **Settings → Inbox**. The provider, model and model options are
saved automatically, independently of the task model. Triage uses that agent's
normal connection and selected project account; no task-model endpoint or API
key is required. The initial choice follows your normal conversation default.
Old endpoint-based triage settings are ignored; choose your preferred agent once.

Click **Triage** in Issues to review the scope, then **Analyze N issues**. Checked
tickets take precedence; otherwise the current project and search select fresh,
ungrouped backlog tickets. Existing groups stay intact unless you explicitly
select their tickets for retriage. Repositories are analyzed separately, in
batches of at most 100 tickets with a bounded input size. Successful batches
remain available if a later batch fails. Review groups across batches for merges.
The agent inspects code in a temporary detached Git worktree of HEAD, through
its normal reading/search tools. Uncommitted changes are not included. The run
uses supervised plan mode, denies permission requests, skips questions, and has
no MonoCode app-tool access. Provider plan-mode restrictions still depend on the
selected agent; this is not a new universal filesystem sandbox. A proposal is
rejected if the checkout was modified. The provider session is stopped before
the temporary worktree is removed on completion or failure. Every group must
cite existing tracked files inside that checkout. Native tool execution is owned
by the provider, so citations are validated as source paths rather than proof of
an exact read call. Priority, agent/model choices and recent activity are
included. Screenshot analysis is optional and requires a vision-capable model;
up to eight screenshots of at most 2 MB each are included per batch. Skipped
images are identified in the proposal. Cancel interrupts that triage session and
stops subsequent batches without affecting normal chats. Each batch has a
five-minute cancellation deadline; provider startup/shutdown may delay cleanup.

The proposed plan explains each group, lists affected files, and gives reasons
for dependencies. Draft proposals and edits survive navigation and restart.
Rename groups, move tickets between groups, choose **Separate group**, or reject
individual dependency suggestions before applying. **Apply triage plan** saves
the plan without launching work. Retriage replaces its previous generated
dependencies while retaining manual prerequisites.
Discarding a plan leaves tickets unchanged. Plans are rejected if tickets changed
while analysis ran, references are invalid, tickets are omitted or repeated, or
dependencies would create an issue cycle or mutually blocked groups.

Expand **Issue assignments** and click **Start group** to launch all its tickets
in one thread. Explicit agent, model and model options must agree; unset choices
inherit the group's selected choice or the project default. Internal
prerequisites are ordered in the prompt. Unfinished prerequisites outside the
group block dispatch, including prerequisites still committing. **Done** is set
only after a successful commit. Issue assignments in the same repository wait
for earlier assignments to finish and commit, including work awaiting review.
This prevents separate issue threads from sharing uncommitted edits. This is a
manual launch, not an automatic queue; unrelated ordinary chats and external
editors are not scheduled by this guard.

Each ticket retains its identity, properties and activity. An assigned group
shares its thread, work result, feedback, review and eventual commit. Open any
ticket to give feedback or **Approve group and commit**. Approval covers the
entire active assignment; every member must be in review. Group replies report
each ticket in an `issue-results` JSON fence, keyed by MC-number, with a `status`
of `ready`, `blocked`, or `needs_work` and a `summary`. Omitted or invalid group
results require more work instead of automatically becoming reviewable. Send
feedback to continue, or explicitly confirm an individual ticket is ready.
Archived members are never resumed. Archiving does not discard existing edits;
restore an unfinished standalone assignment to complete its review and commit.
Failed runs can be retried from the group card or a member ticket. Group cards
link to tickets, threads and review results, and explain why dispatch is blocked.
Detach an unstarted ticket in its details before starting it individually.
Changing an unstarted ticket's project detaches it; assigned tickets cannot
change projects. Add or remove prerequisites under **Depends on** in ticket
details; the reverse **Blocks** relation is derived automatically.

## Agent CLI

MonoCode's existing authenticated app CLI now supports issues. Issue threads are
enabled automatically; other project threads can use `/operator` to enable it.
The agent receives the executable path and session credentials through the
existing app integration. No separate MCP setup is required.

```sh
monocode app issues.list --json '{"status":"backlog"}'
monocode app issues.get --json '{"issueId":"MC-12"}'
monocode app issues.update --json '{"issueId":"MC-12","priority":2,"dependsOn":["MC-10"]}'
monocode app issues.comment --json '{"issueId":"MC-12","text":"Needs the authentication API first."}'
monocode app issues.create --json '{"title":"Reconnect streaming after disconnect","priority":3}'
```

Run `monocode app --help` for all fields. Updates preserve omitted properties;
supplied arrays replace existing values. Status updates on unassigned tickets
change the tracker without launching a thread or approving a commit. Assigned
tickets' statuses follow execution and human review; agents report per-ticket
outcomes and use comments for blockers. The CLI cannot manufacture In Progress
or mark its own managed assignment Done. Project access follows the calling session; a Mono can choose among its
configured projects with `project`. Agents cannot change another agent's running
ticket, and dependency edits use the same validation as the UI. Reuse request
IDs when retrying calls, particularly issue creation. Never print credentials.
