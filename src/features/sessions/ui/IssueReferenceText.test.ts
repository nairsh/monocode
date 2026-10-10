// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { subscribeOpenIssue, takeOpenIssueRequest } from "../../inbox/model/issueReference";
import { IssueReferenceText } from "./IssueReferenceText";

it("renders a leading #MC-n as a link that requests that issue and leaves other text alone", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(createElement(IssueReferenceText, { text: "#MC-12 Fix the sidebar" })));
  const link = container.querySelector("button")!;
  expect(link.textContent).toBe("#MC-12");
  expect(container.textContent).toBe("#MC-12 Fix the sidebar");

  const opened = vi.fn();
  const stop = subscribeOpenIssue(opened);
  act(() => link.click());
  stop();
  expect(opened).toHaveBeenCalledOnce();
  expect(takeOpenIssueRequest()).toBe(12);

  act(() => root.render(createElement(IssueReferenceText, { text: "plain #MC-12" })));
  expect(container.querySelector("button")).toBeNull();
  act(() => root.unmount());
});
