import { loadLocalIssues, subscribeLocalIssues, type LocalIssue } from "./localIssues";

/** Compact transcript text for an issue-launched turn; the agent still gets the full prompt. */
export const issueLaunchText = (issue: Pick<LocalIssue, "number" | "title" | "feedback">, committing: boolean) =>
  `#MC-${issue.number} ${committing ? "Commit approved changes" : issue.feedback ? `Review feedback: ${issue.feedback}` : issue.title}`;

export function parseIssueReference(text: string): { number: number; rest: string } | null {
  const match = /^#MC-(\d+)\b/.exec(text);
  return match ? { number: Number(match[1]), rest: text.slice(match[0].length) } : null;
}

// A request outlives the lazy Inbox surface that has not mounted yet.
const OPEN_ISSUE_TTL_MS = 10_000;
let pendingOpen: { number: number; at: number } | null = null;
const openListeners = new Set<() => void>();

export function requestOpenIssue(number: number) {
  pendingOpen = { number, at: Date.now() };
  for (const listener of [...openListeners]) listener();
}

export function takeOpenIssueRequest(): number | null {
  const request = pendingOpen;
  pendingOpen = null;
  return request && Date.now() - request.at < OPEN_ISSUE_TTL_MS ? request.number : null;
}

export function subscribeOpenIssue(listener: () => void) {
  openListeners.add(listener);
  return () => void openListeners.delete(listener);
}

let issueNumbers: ReadonlyMap<string, number> = new Map();

function refreshIssueNumbers() {
  let next: Map<string, number>;
  try {
    next = new Map(loadLocalIssues().flatMap(issue => issue.sessionId ? [[issue.sessionId, issue.number] as const] : []));
  } catch {
    return false;
  }
  if (next.size === issueNumbers.size && [...next].every(([id, number]) => issueNumbers.get(id) === number)) return false;
  issueNumbers = next;
  return true;
}

/** sessionId to issue number, rebuilt once per store change and kept referentially stable otherwise. */
export function subscribeIssueNumbers(listener: () => void) {
  // React re-reads the snapshot right after subscribing, so no notify is needed here.
  refreshIssueNumbers();
  return subscribeLocalIssues(() => {
    if (refreshIssueNumbers()) listener();
  });
}
export const issueNumbersSnapshot = () => issueNumbers;
