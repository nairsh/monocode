# Backlog triage and agent issue access

In **Settings → Inbox → Task model**, choose a **Triage model** and optional
reasoning effort. Triage shares the task model's endpoint and saved API key, but
uses its own model. The endpoint must support Chat Completions function tools.

Click **Triage** in Issues to analyze unassigned backlog tickets. Selecting a
project limits the run to that repository; otherwise repositories are analyzed
separately. The model inspects tracked files in a temporary detached Git worktree
of HEAD. It cannot edit files or run arbitrary commands. Uncommitted changes are
not included. Inspection is bounded, and the temporary worktree is removed when
the run finishes or fails. Up to 100 tickets per project can be analyzed per run.

The proposed plan explains each group, lists affected files, and gives reasons
for dependencies. **Apply triage plan** saves the plan without launching work.
Discarding a plan leaves tickets unchanged. Plans are rejected if tickets changed
while analysis ran, references are invalid, tickets are omitted or repeated, or
dependencies would create an issue cycle or mutually blocked groups.

Expand **Issue assignments** and click **Start group** to launch all its tickets
in one thread. Explicit agent, model and model options must agree; unset choices
inherit the group's selected choice or the project default. Internal
prerequisites are ordered in the prompt. Unfinished prerequisites outside the
group block dispatch. This is a manual launch, not an automatic queue.

Each ticket retains its identity, properties and activity. An assigned group
shares its thread, work result, feedback, review and eventual commit. Open any
ticket to give feedback or **Approve group and commit**. Approval covers the
entire assignment; every member must be in review. Failed runs can be retried
from a member ticket. Moving an unassigned ticket individually still starts an
individual thread. Add or remove prerequisites under **Depends on** in ticket
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
supplied arrays replace existing values. Status updates change the tracker
without launching a thread or approving a commit. Managed work finishes in
review. Project access follows the calling session; a Mono can choose among its
configured projects with `project`. Agents cannot change another agent's running
ticket, and dependency edits use the same validation as the UI. Reuse request
IDs when retrying calls, particularly issue creation. Never print credentials.
