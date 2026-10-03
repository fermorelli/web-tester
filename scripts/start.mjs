import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(appDirectory, false);

const railway = process.argv.includes("--railway");
const host = process.env.APP_HOST?.trim() || (railway ? "0.0.0.0" : "127.0.0.1");
const port = process.env.PORT || "3000";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error("PORT must be an integer between 1 and 65535.");
  process.exit(1);
}

const nextCli = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextCli, "start", appDirectory, "--hostname", host, "--port", port,
  ...process.argv.slice(2).filter(argument => argument !== "--railway")], {
  cwd: appDirectory, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" }, windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(`Could not start Next.js: ${error.message}`); process.exit(1); });
child.on("exit", (code, signal) => process.exit(code ?? (signal === "SIGINT" ? 130 : signal ? 143 : 1)));
