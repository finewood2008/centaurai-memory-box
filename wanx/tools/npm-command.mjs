import { dirname, join } from "node:path";

export function npmCommand(args) {
  const cli = process.env.npm_execpath || (process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : null);
  return cli ? [process.execPath, [cli, ...args]] : ["npm", args];
}
