# Backlog triage and agent issue access

In **Settings → Inbox → Task model**, choose a **Triage model** and optional
reasoning effort. Triage shares the task model's endpoint and saved API key, but
uses its own model. The endpoint must support Chat Completions function tools.

Click **Triage** in Issues to review the scope, then **Analyze N issues**. Checked
tickets take precedence; otherwise the current project and search select fresh,
ungrouped backlog tickets. Existing groups stay intact unless you explicitly
select their tickets for retriage. Repositories are analyzed separately, in
batches of at most 100 tickets with a bounded input size. Successful batches
remain available if a later batch fails. Review groups across batches for merges.
The model inspects tracked files in a temporary detached Git worktree
of HEAD. It cannot edit files or run arbitrary commands. Uncommitted changes are
not included. Inspection is bounded, and the temporary worktree is removed when
the run finishes or fails. Code search, file-list pagination and continued reads
allow inspection beyond the start of large files. Every group must cite files
the model actually read. Priority, agent/model choices and recent activity are
included. Screenshot analysis is optional and requires a vision-capable model;
up to eight screenshots of at most 2 MB each are included per batch. Skipped
images are identified in the proposal. Cancel stops further inspection and
batches; an in-flight HTTP request may finish before cleanup completes.

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
