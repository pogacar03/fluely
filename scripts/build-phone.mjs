import { build } from "vite";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const phoneRoot = path.join(projectRoot, "electron", "phone");
const outputDirectory = path.join(projectRoot, "dist-phone");

await build({
  root: projectRoot,
  configFile: false,
  publicDir: false,
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: path.join(phoneRoot, "phone.ts"),
      output: {
        entryFileNames: "phone.js",
        format: "es",
        inlineDynamicImports: true,
      },
    },
  },
});

await mkdir(outputDirectory, { recursive: true });
await copyFile(path.join(phoneRoot, "index.html"), path.join(outputDirectory, "index.html"));
await copyFile(path.join(phoneRoot, "phone.css"), path.join(outputDirectory, "phone.css"));
