import { expect, it } from "vitest";
import { shortAgo } from "./relativeTime";

it("formats compact ages", () => {
  const now = Date.UTC(2026, 9, 8, 12);
  const ago = (minutes: number) => shortAgo(now - minutes * 60_000, now);
  expect(ago(0.5)).toBe("now");
  expect(ago(-3)).toBe("now");
  expect(ago(5)).toBe("5m ago");
  expect(ago(59)).toBe("59m ago");
  expect(ago(60)).toBe("1h ago");
  expect(ago(23 * 60 + 59)).toBe("23h ago");
  expect(ago(3 * 24 * 60)).toBe("3d ago");
  expect(ago(15 * 24 * 60)).toBe("2w ago");
  expect(ago(400 * 24 * 60)).toBe("1y ago");
});
