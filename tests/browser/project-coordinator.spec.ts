import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const evidence = process.env.MONOCODE_QA_OUTPUT ?? "/tmp/monocode-cloud-qa";
test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
});
test("project threads, library, settings and full screen controls respond", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tests/browser/project-coordinator.html");
  await expect(page).toHaveTitle("MonoCode project coordinator QA");
  await expect(
    page.getByRole("tab", { name: "Threads", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Suggested threads" }),
  ).toBeVisible();
  await page.screenshot({ path: `${evidence}/project-threads.png` });
  await page.getByRole("button", { name: "Start all", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Suggested threads" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "In progress threads" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Full screen overview", exact: true })
    .click();
  const overview = page.locator('aside[aria-label$="overview"]');
  await expect
    .poll(async () => Math.round((await overview.boundingBox())!.width))
    .toBe(1440);
  await page
    .getByRole("button", { name: "Exit full screen overview", exact: true })
    .click();
  await page.getByRole("tab", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Add document", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Document title", exact: true })
    .fill("Project conventions");
  await page
    .getByRole("textbox", { name: "Document content", exact: true })
    .fill("Use focused tests before integration.");
  await page
    .getByRole("button", { name: "Save document", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Project conventions Document",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search library", exact: true })
    .fill("missing");
  await expect(
    page.getByText("No matching documents", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search library", exact: true })
    .fill("");
  await page
    .getByLabel("Import library files", { exact: true })
    .setInputFiles({
      name: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Notes\nImported from cloud QA"),
    });
  await expect(
    page.getByRole("button", { name: "notes.md Document", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Switch to list view", exact: true })
    .click();
  await page.screenshot({ path: `${evidence}/project-library.png` });
  await page
    .getByRole("button", { name: "Project settings", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Project goal", exact: true })
    .fill("Ship a stable release");
  await page
    .getByRole("checkbox", {
      name: "Auto-continue after usage resets",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "Environment", exact: true }).click();
  await page
    .getByRole("combobox", { name: "New thread checkout", exact: true })
    .selectOption("worktree");
  await page
    .getByRole("button", { name: "Thread instructions", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Thread instructions", exact: true })
    .fill("Run focused checks");
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.screenshot({ path: `${evidence}/project-settings.png` });
  const preferences = await page.evaluate(
    () =>
      Object.values(
        JSON.parse(localStorage.getItem("monocode.projectCoordinators.v1")!),
      )[0],
  );
  expect(preferences).toMatchObject({
    goal: "Ship a stable release",
    instructions: "Run focused checks",
    workspaceMode: "worktree",
    autoContinue: true,
  });
  expect(errors).toEqual([]);
});

test("typed voice commands preview and change the real issue store", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tests/browser/issue-tracker.html");
  await page
    .getByRole("button", { name: "Voice commands", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Issue command", exact: true })
    .fill("Create an issue called Voice workflow QA");
  await page
    .getByRole("button", { name: "Review command", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Apply actions", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${evidence}/voice-preview.png` });
  await page
    .getByRole("button", { name: "Apply actions", exact: true })
    .click();
  await expect(
    page.getByText("Completed 1 actions", { exact: true }),
  ).toBeVisible();
  // Use the rendered board as the store observer, avoiding reliance on its serialization version.
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByText("Voice workflow QA", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Voice workflow QA", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 640, height: 850 });
  await page
    .getByRole("button", { name: "Voice commands", exact: true })
    .click();
  await page.screenshot({ path: `${evidence}/voice-compact.png` });
  expect(errors).toEqual([]);
});

test("simulated speech preserves its transcript and stops capture on close", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // This checks capture lifecycle only. It does not prove microphone access,
    // transcription service availability, or live speech recognition.
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });
    (window as any).__speechAborts = 0;
    (window as any).SpeechRecognition = class {
      onresult?: (event: unknown) => void;
      onend?: () => void;
      start() {
        setTimeout(
          () =>
            this.onresult?.({
              results: [
                {
                  isFinal: true,
                  0: {
                    transcript: "Create an issue called Speech lifecycle QA",
                  },
                },
              ],
            }),
          20,
        );
      }
      stop() {
        this.onend?.();
      }
      abort() {
        (window as any).__speechAborts++;
        this.onend?.();
      }
    };
  });
  await page.goto("/tests/browser/issue-tracker.html");
  await page
    .getByRole("button", { name: "Voice commands", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start listening", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Issue command", exact: true }),
  ).toHaveValue("Create an issue called Speech lifecycle QA");
  await expect(page.getByText("Listening…", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${evidence}/voice-simulated-listening.png` });
  await page
    .getByRole("button", { name: "Stop listening", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Issue command", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Start listening", exact: true })
    .click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__speechAborts)).toBe(1);
});
