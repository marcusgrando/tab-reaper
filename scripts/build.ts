import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const distDir = path.join(root, "dist");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const entrypoints = [
  { in: path.join(root, "src/background/index.ts"), out: "background.js" },
  { in: path.join(root, "src/popup/popup.ts"), out: "popup.js" },
  { in: path.join(root, "src/options/options.ts"), out: "options.js" },
];

for (const entry of entrypoints) {
  const result = await Bun.build({
    entrypoints: [entry.in],
    outdir: distDir,
    naming: entry.out,
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}

const staticFiles: Array<[string, string]> = [
  ["manifest.json", "manifest.json"],
  ["src/shared/ui.css", "ui.css"],
  ["assets/ui.svg", "ui.svg"],
  ["src/popup/popup.html", "popup.html"],
  ["src/popup/popup.css", "popup.css"],
  ["src/options/options.html", "options.html"],
  ["src/options/options.css", "options.css"],
  ["assets/icons/icon16.png", "icons/icon16.png"],
  ["assets/icons/icon48.png", "icons/icon48.png"],
  ["assets/icons/icon128.png", "icons/icon128.png"],
];

await mkdir(path.join(distDir, "icons"), { recursive: true });

for (const [src, dest] of staticFiles) {
  await copyFile(path.join(root, src), path.join(distDir, dest));
}

console.log(`Built extension to ${distDir}`);
