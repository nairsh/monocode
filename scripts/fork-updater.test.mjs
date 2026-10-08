import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConfig, manifest } from "./fork-updater.mjs";
import { readFileSync } from "node:fs";

test("fork releases have increasing versions, a fork-only feed, and signed macOS downloads", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.fork.conf.json", import.meta.url)));
  assert.deepEqual(buildConfig(config, "12", true), {
    version: "0.9.1-fork.12", bundle: { createUpdaterArtifacts: true },
  });
  assert.equal(buildConfig(config, "13", false).bundle.createUpdaterArtifacts, false);
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.ok(config.plugins.updater.pubkey);
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://github.com/nairsh/monocode/releases/download/fork-updates/latest.json",
  ]);
  const source = "66552a4e8b50bac11fe468babf4121af08d1ed1a";
  const update = manifest("0.9.1-fork.12", source, "MonoCode.app.tar.gz", "signed\n");
  assert.equal(update.version, "0.9.1-fork.12");
  assert.deepEqual(update.platforms, {
    "darwin-aarch64": {
      signature: "signed",
      url: "https://github.com/nairsh/monocode/releases/download/fork-66552a4e8b50/MonoCode.app.tar.gz",
    },
  });
  assert.throws(() => manifest(update.version, source, "MonoCode.app.tar.gz", ""));
  assert.throws(() => manifest(update.version, source, "../MonoCode.app.tar.gz", "signed"));
  assert.throws(() => buildConfig(config, "0", true));
});
