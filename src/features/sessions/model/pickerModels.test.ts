import { beforeEach, expect, it } from "vitest";
import { pickerModels, saveModelHidden, type AgentModel } from "./models";

const model = (id: string) => ({ id, name: id, harness: "claude" }) as AgentModel;
const ids = (list: AgentModel[]) => list.map((item) => item.id);
const all = [model("a"), model("b"), model("c")];

beforeEach(() => {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    },
    configurable: true,
  });
});

it("hides models turned off in Settings but keeps the selected one", () => {
  saveModelHidden("b", true);
  saveModelHidden("c", true);
  expect(ids(pickerModels(all))).toEqual(["a"]);
  expect(ids(pickerModels(all, "c"))).toEqual(["a", "c"]);
  saveModelHidden("b", false);
  expect(ids(pickerModels(all))).toEqual(["a", "b"]);
});

it("lists everything when every model is hidden", () => {
  for (const item of all) saveModelHidden(item.id, true);
  expect(ids(pickerModels(all, "a"))).toEqual(["a", "b", "c"]);
});
