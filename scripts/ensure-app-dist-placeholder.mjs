import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "app-dist");

await mkdir(output, { recursive: true });
await writeFile(path.join(output, ".gitkeep"), "\n");
