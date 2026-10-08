import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "nairsh/monocode";

export function buildConfig(config, runNumber, signed) {
  if (!/^[1-9]\d*$/.test(runNumber)) throw new Error("Invalid Actions run number");
  if (!/^\d+\.\d+\.\d+-fork\.0$/.test(config.version)) {
    throw new Error("Expected a fork version ending in -fork.0");
  }
  return {
    version: config.version.replace(/\.0$/, `.${runNumber}`),
    bundle: { createUpdaterArtifacts: signed },
  };
}

export function manifest(version, source, archive, signature) {
  if (!/^\d+\.\d+\.\d+-fork\.[1-9]\d*$/.test(version)) throw new Error("Invalid fork version");
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error("Invalid source commit");
  if (!archive.endsWith(".app.tar.gz") || basename(archive) !== archive) {
    throw new Error("Expected a macOS updater archive filename");
  }
  if (!signature.trim()) throw new Error("Missing updater signature");
  return {
    version,
    notes: `MonoCode fork ${source.slice(0, 12)}. See https://github.com/${repository}/releases/tag/fork-${source.slice(0, 12)} for details.`,
    pub_date: new Date().toISOString(),
    platforms: {
      "darwin-aarch64": {
        signature: signature.trim(),
        url: `https://github.com/${repository}/releases/download/fork-${source.slice(0, 12)}/${encodeURIComponent(archive)}`,
      },
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, configPath, destination] = process.argv.slice(2);
  if (command === "configure") {
    const config = JSON.parse(readFileSync("src-tauri/tauri.fork.conf.json", "utf8"));
    const signed = process.env.FORK_SIGNED === "true";
    if (signed && !process.env.TAURI_SIGNING_PRIVATE_KEY) throw new Error("Missing fork signing key");
    writeFileSync(configPath, JSON.stringify(buildConfig(config, process.env.GITHUB_RUN_NUMBER ?? "", signed)));
  } else if (command === "manifest") {
    const directory = "target/aarch64-apple-darwin/release/bundle/macos";
    const archives = readdirSync(directory).filter((name) => name.endsWith(".app.tar.gz"));
    if (archives.length !== 1) throw new Error("Expected exactly one updater archive");
    const archive = archives[0];
    const signature = readFileSync(join(directory, `${archive}.sig`), "utf8");
    const { version } = JSON.parse(readFileSync(configPath, "utf8"));
    const update = manifest(version, process.env.GITHUB_SHA ?? "", archive, signature);
    copyFileSync(join(directory, archive), join(destination, archive));
    copyFileSync(join(directory, `${archive}.sig`), join(destination, `${archive}.sig`));
    writeFileSync(join(destination, "latest.json"), `${JSON.stringify(update, null, 2)}\n`);
  } else {
    throw new Error("Expected configure <config> or manifest <config> <destination>");
  }
}
