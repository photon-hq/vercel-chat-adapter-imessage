import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clearPackageJSON } from "clean-publish/core.js";

const {
  RELEASE_CHANNEL: channel,
  RELEASE_VERSION: base,
  RELEASE_SUFFIX: suffix,
  PACK_DESTINATION: output,
} = process.env;

if (!(base && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(base))) {
  throw new Error("RELEASE_VERSION must be a stable X.Y.Z version");
}
if (
  !(
    (channel === "staging" &&
      /^-staging\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(suffix ?? "")) ||
    (channel === "production" && suffix === "")
  )
) {
  throw new Error(
    "RELEASE_CHANNEL and RELEASE_SUFFIX must describe staging or production"
  );
}
if (!output) {
  throw new Error("PACK_DESTINATION is required");
}

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const destination = resolve(output);
const temporary = mkdtempSync(join(tmpdir(), "chat-adapter-imessage-pack-"));

const declaredTargets = (value) => {
  if (typeof value === "string") {
    return [value.startsWith("./") ? value.slice(2) : value];
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(declaredTargets);
  }
  return [];
};

try {
  const [{ files }] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
    })
  );
  for (const { path } of files) {
    const target = join(temporary, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, path), target);
  }
  // Preserve the existing clean-publish manifest without rebuilding at promotion.
  const packagedManifest = {
    ...clearPackageJSON(manifest),
    version: `${base}${suffix}`,
  };
  writeFileSync(
    join(temporary, "package.json"),
    `${JSON.stringify(packagedManifest, null, 2)}\n`
  );
  mkdirSync(destination, { recursive: true });
  const [archive] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
      { cwd: temporary, encoding: "utf8" }
    )
  );
  const paths = new Set(archive.files.map(({ path }) => path));
  const targets = new Set(
    [
      packagedManifest.exports,
      packagedManifest.main,
      packagedManifest.types,
      packagedManifest.bin,
    ].flatMap(declaredTargets)
  );
  const missing = [...targets].filter((target) => !paths.has(target));
  if (missing.length > 0) {
    throw new Error(
      `Packed archive is missing declared targets: ${missing.join(", ")}`
    );
  }
  process.stdout.write(`${archive.filename}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
