import { describe, expect, it } from "vitest";
import { dragPointToClient } from "./dragPoint";

describe("dragPointToClient", () => {
  it("divides physical pixels by the scale on Windows", () => {
    expect(dragPointToClient(1000, 500, 1, true, 2)).toEqual({ x: 500, y: 250 });
  });

  it("keeps Windows points as is at scale 1", () => {
    expect(dragPointToClient(1000, 500, 1, true, 1)).toEqual({ x: 1000, y: 500 });
  });

  it("keeps macOS and GTK logical points as is at any scale", () => {
    expect(dragPointToClient(1000, 500, 1, false, 2)).toEqual({ x: 1000, y: 500 });
  });

  it("divides the UI scale zoom out of macOS and GTK points", () => {
    expect(dragPointToClient(1000, 500, 1.25, false, 2)).toEqual({
      x: 800,
      y: 400,
    });
  });

  it("leaves Windows zoom to devicePixelRatio", () => {
    expect(dragPointToClient(1000, 500, 1.25, true, 2.5)).toEqual({
      x: 400,
      y: 200,
    });
  });
});
