import { readdir, readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const assets = new URL("../dist/assets/", import.meta.url);
const files = await readdir(assets);
const javascript = files.filter((file) => file.endsWith(".js"));
let bytes = 0;
for (const file of javascript) bytes += gzipSync(await readFile(new URL(file, assets)), { level: 9 }).byteLength;
const limit = 250 * 1024;
console.log(`JavaScript gzip budget: ${(bytes / 1024).toFixed(1)} KB / 250 KB (${javascript.length} JS asset(s))`);
if (bytes > limit) {
  console.error("JavaScript gzip budget exceeded. Reduce dependencies or add code splitting.");
  process.exitCode = 1;
}
