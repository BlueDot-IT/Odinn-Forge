import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { spawnPnpmSync } from "../scripts/lib/package-manager.ts";

test("package-manager subprocesses use the active pnpm JavaScript launcher without Corepack", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-package-manager-active-"));
  const launcher = join(root, "pnpm.cjs");
  await writeFile(launcher, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const previous = process.env.npm_execpath;
  process.env.npm_execpath = launcher;
  try {
    const result = spawnPnpmSync(["--filter", "@odinn/kernel", "typecheck"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: root }
    });
    assert.equal(result.status, 0, result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout), ["--filter", "@odinn/kernel", "typecheck"]);
  } finally {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("package-manager subprocesses fall back to pnpm on PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-package-manager-path-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const launcher = join(bin, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  await writeFile(launcher, process.platform === "win32" ? "@echo off\r\n<nul set /p =%*\r\n" : "#!/bin/sh\nprintf '%s' \"$*\"\n");
  if (process.platform !== "win32") await chmod(launcher, 0o700);
  const previous = process.env.npm_execpath;
  delete process.env.npm_execpath;
  try {
    const result = spawnPnpmSync(["--version"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }
    });
    assert.equal(result.status, 0, result.error?.message);
    assert.equal(result.stdout, "--version");
  } finally {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
    await rm(root, { recursive: true, force: true });
  }
});
