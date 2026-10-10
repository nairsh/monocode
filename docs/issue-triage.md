# Backlog triage and agent issue access

Click **Triage** to inspect fresh backlog issues immediately. Selected tickets take
precedence; otherwise the current project and search select ungrouped backlog
tickets. The button shimmers while working and a compact notification reports
the current source inspection. Use the adjacent dropdown or **Settings → Inbox**
to choose the normal agent/model independently of the task model.

Each validated batch applies automatically. Triage can refine each issue's title,
Markdown description and priority, assign a topic, and add prerequisites. Each
issue records its rationale in activity. The app validates the scoped per-issue
updates; the isolated triage agent does not receive unrestricted app CLI access.
A notification offers **Undo changes** and a dismiss button. Undo restores
triage-owned fields that have not subsequently changed, preserves later edits,
and skips assignments already started. Undo is available for the current run
while the issue view remains mounted. A new run replaces the previous undo.
Dependencies are validated again before undo; if later graph changes make the
restoration invalid, no partial undo is written.

Topics are rows in the board (or sections in the list), with statuses as columns.
Each row can be collapsed. Its three-dot menu selects all members or starts them
in one thread. **Display options → Rows** switches between Topic, Priority and
No grouping. Priority and ungrouped rows can also be launched as an explicit
shared assignment. The group menu explains blockers and links existing threads.
Search, status, priority and label filters combine; display options control
ordering, empty columns and card properties. The details button opens view counts.

Issue descriptions support direct formatted editing, Markdown shortcuts and a
selection toolbar. The pencil opens Markdown source editing. Sub-issues retain
their own properties, activity and execution; parent links are organizational,
not implicit execution dependencies. Parents must exist in the same project,
and nesting cannot form a cycle.

Repositories are analyzed separately, in batches of at most 100 tickets with
bounded input size. Successful batches remain applied if a later batch fails.
The agent inspects a temporary detached checkout of committed HEAD; uncommitted
changes are not included. It uses supervised plan mode, denies permission
requests, skips questions, and has no MonoCode app-tool access. Provider plan-mode
restrictions still depend on the selected agent; this is not a universal
filesystem sandbox. A result is rejected if the checkout was modified. Every
group must cite existing tracked files. Citations validate source paths, not
proof of an exact read call. The provider session is stopped before checkout
cleanup. Up to eight screenshots of at most 2 MB each are included per batch;
a vision-capable model is needed. Warnings report omitted images. Cancel stops
subsequent batches and does not apply a late response. Each batch has a five-minute
deadline; provider startup/shutdown may delay cleanup.

Updates are rejected if tickets changed during analysis, references are invalid,
tickets are omitted/repeated, or dependencies create issue or group cycles.
Retriage replaces generated prerequisites and retains manual ones. Explicit
agent/model choices must agree before dispatch. Unfinished prerequisites outside
the group block dispatch, including prerequisites still committing. Assignments
in the same repository wait for earlier assignments to finish and commit,
including work awaiting review. Unrelated ordinary chats and external editors
are not scheduled by this guard.

A group shares its thread, work result, feedback, review and eventual commit.
Open a member to give feedback or **Approve group and commit**. Approval covers
the entire active assignment; every member must be in review. Group replies
report each ticket in an `issue-results` JSON fence keyed by MC-number, with
`ready`, `blocked`, or `needs_work` status and a summary. Missing results require
more work. **Done** follows successful commit. Archived members are never
resumed. Archiving does not discard edits; restore an unfinished assignment to
finish review and commit. Failed runs can be retried from a member ticket.
Detach an unstarted ticket in its details to start it individually. Assigned
tickets cannot change projects. **Depends on** edits prerequisites; **Blocks**
is derived from them.

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
