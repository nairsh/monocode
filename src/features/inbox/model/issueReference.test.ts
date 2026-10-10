// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  issueLaunchText,
  issueNumbersSnapshot,
  parseIssueReference,
  requestOpenIssue,
  subscribeIssueNumbers,
  subscribeOpenIssue,
  takeOpenIssueRequest,
} from "./issueReference";
import { createLocalIssue, updateLocalIssue } from "./localIssues";

const issue = () =>
  createLocalIssue({ title: "Fix it", description: "", status: "backlog", priority: 2, projectPath: "/tmp/web", labels: [], agent: "" });

describe("issue references", () => {
  beforeEach(() => localStorage.clear());

  it("shows the title, feedback or commit label while the full prompt stays with the agent", () => {
    const base = { number: 12, title: "Fix it" };
    expect(issueLaunchText(base, false)).toBe("#MC-12 Fix it");
    expect(issueLaunchText({ ...base, feedback: "Too slow" }, false)).toBe("#MC-12 Review feedback: Too slow");
    expect(issueLaunchText({ ...base, feedback: "Too slow" }, true)).toBe("#MC-12 Commit approved changes");
  });

  it("parses only a leading reference", () => {
    expect(parseIssueReference("#MC-12 Fix it")).toEqual({ number: 12, rest: " Fix it" });
    expect(parseIssueReference("see #MC-12")).toBeNull();
    expect(parseIssueReference("#MC-12x")).toBeNull();
  });

  it("keeps an open request for a surface that mounts later, but only briefly", () => {
    vi.useFakeTimers();
    try {
      requestOpenIssue(3);
      expect(takeOpenIssueRequest()).toBe(3);
      expect(takeOpenIssueRequest()).toBeNull();
      requestOpenIssue(4);
      vi.advanceTimersByTime(11_000);
      expect(takeOpenIssueRequest()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    const listener = vi.fn();
    const stop = subscribeOpenIssue(listener);
    requestOpenIssue(5);
    stop();
    expect(listener).toHaveBeenCalledOnce();
    takeOpenIssueRequest();
  });

  it("maps threads to issues once, notifying only when the mapping changes", () => {
    const created = issue();
    const listener = vi.fn();
    const stop = subscribeIssueNumbers(listener);
    expect(issueNumbersSnapshot().size).toBe(0);
    updateLocalIssue(created.id, { sessionId: "thread-1" });
    expect(issueNumbersSnapshot().get("thread-1")).toBe(created.number);
    expect(listener).toHaveBeenCalledOnce();
    const map = issueNumbersSnapshot();
    updateLocalIssue(created.id, { runHeartbeatAt: new Date().toISOString() });
    expect(issueNumbersSnapshot()).toBe(map);
    expect(listener).toHaveBeenCalledOnce();
    stop();
  });
});
