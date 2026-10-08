// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Popover } from "./Popover";
import { LAYER } from "../lib/layers";

let root: Root;
let container: HTMLDivElement;
let dialog: HTMLDivElement;
let anchor: HTMLButtonElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  anchor = document.createElement("button");
  dialog.append(anchor);
  document.body.append(container, dialog);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  dialog.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("focuses menus only after they become visible", async () => {
  const original = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.getAttribute("role") === "menu")
      expect(this.parentElement?.style.visibility).not.toBe("hidden");
    original.call(this);
  });
  await act(async () =>
    root.render(
      createElement(
        Popover,
        {
          anchor,
          bare: true,
          autoFocus: true,
          width: 200,
          role: "menu",
          tabIndex: -1,
        },
        "Options",
      ),
    ),
  );
  expect(document.activeElement?.getAttribute("role")).toBe("menu");
});

it("keeps dialog menus and their submenus above the modal", async () => {
  const menu = createElement(
    Popover,
    { key: "parent", anchor, bare: true, width: 200, role: "menu" },
    createElement("button", { id: "submenu-anchor" }, "More options"),
  );
  await act(async () => root.render(createElement(Fragment, null, menu)));
  const trigger = document.getElementById("submenu-anchor")!;
  expect(
    trigger.closest("[data-popover-layer]")?.getAttribute("data-popover-layer"),
  ).toBe(String(LAYER.dialogPopover));
  await act(async () =>
    root.render(
      createElement(
        Fragment,
        null,
        menu,
        createElement(
          Popover,
          {
            key: "child",
            anchor: trigger,
            layer: LAYER.submenu,
            bare: true,
            width: 180,
            role: "menu",
            "aria-label": "Submenu",
          },
          "Choice",
        ),
      ),
    ),
  );
  const submenu = document.querySelector('[aria-label="Submenu"]');
  expect(
    submenu
      ?.closest("[data-popover-layer]")
      ?.getAttribute("data-popover-layer"),
  ).toBe(String(LAYER.dialogPopover + 1));
});
