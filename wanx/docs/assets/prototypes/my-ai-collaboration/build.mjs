import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../../../../memory/package.json", import.meta.url));
const { build } = require("esbuild");
const output = resolve(process.argv[2] ?? "index.html");
const source = fileURLToPath(new URL("./demo.tsx", import.meta.url));
const { outputFiles } = await build({
  nodePaths: [fileURLToPath(new URL("../../../../../memory/node_modules/", import.meta.url))],
  entryPoints: [source], outfile: "demo.js", bundle: true, write: false, minify: true, jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".png": "dataurl", ".svg": "dataurl", ".woff2": "dataurl" },
});
const css = outputFiles.find(file => file.path.endsWith(".css")).text
  .replace(/@import\s*"https:\/\/fonts\.googleapis\.com\/[^"]+";/g, "").replace(/<\/style/gi, "<\\/style");
const script = outputFiles.find(file => file.path.endsWith(".js")).text.replace(/<\/script/gi, "<\\/script");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<title>记忆盒子 · 我的 AI 协作任务</title><style>${css}</style></head><body data-memory-surface="my-ai"><div id="root"></div><script>${script}</script></body></html>\n`);
