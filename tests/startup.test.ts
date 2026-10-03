import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("production startup boundary", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "site-inspector-start-test-"));
    for (const path of ["scripts", "node_modules/@next/env", "node_modules/next/dist/bin"]) mkdirSync(join(directory, path), { recursive: true });
    copyFileSync(join(process.cwd(), "scripts/start.mjs"), join(directory, "scripts/start.mjs"));
    // Exercise the real startup wrapper and child process without binding a server socket.
    writeFileSync(join(directory, "node_modules/@next/env/index.js"), "exports.loadEnvConfig = () => {};\n");
    writeFileSync(join(directory, "node_modules/next/dist/bin/next.js"), "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), nodeEnv: process.env.NODE_ENV }));\n");
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const run = (arguments_: string[], environment: Record<string, string> = {}) => JSON.parse(execFileSync(process.execPath,
    [join(directory, "scripts/start.mjs"), ...arguments_], {
      cwd: tmpdir(), env: { ...process.env, PORT: "", APP_HOST: "", ...environment }, encoding: "utf8", stdio: "pipe", windowsHide: true,
    })) as { args: string[]; cwd: string; nodeEnv: string };

  it("keeps local production bound to loopback and resolves the application directory independently of caller cwd", () => {
    const result = run([]);
    expect(result.args[0]).toBe("start");
    expect(resolve(result.args[1])).toBe(directory);
    expect(result.cwd).toBe(directory);
    expect(result.args.slice(2)).toEqual(["--hostname", "127.0.0.1", "--port", "3000"]);
    expect(result.nodeEnv).toBe("production");
  });

  it("binds Railway to all interfaces and uses the platform-provided port without forwarding its wrapper flag", () => {
    const result = run(["--railway"], { PORT: "4178" });
    expect(result.args.slice(2)).toEqual(["--hostname", "0.0.0.0", "--port", "4178"]);
    expect(result.args).not.toContain("--railway");
  });

  it("respects an explicit host and forwards valid Next CLI options", () => {
    const result = run(["--railway", "--keepAliveTimeout", "70000"], { APP_HOST: "127.0.0.1", PORT: "4179" });
    expect(result.args.slice(2)).toEqual(["--hostname", "127.0.0.1", "--port", "4179", "--keepAliveTimeout", "70000"]);
  });

  it.each(["0", "65536", "invalid", "3000.5"])("fails before launching Next with invalid PORT=%s", (port) => {
    expect(() => run(["--railway"], { PORT: port })).toThrow(/PORT must be an integer between 1 and 65535/);
  });
});
