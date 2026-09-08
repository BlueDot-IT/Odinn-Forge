#!/usr/bin/env node
import { mkdir, open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createConnectorScaffold, validatePluginManifest } from "./index.js";
const [command, target, ...flags] = process.argv.slice(2);
try {
    if (command === "validate" && target && !flags.length) {
        const handle = await open(resolve(target), "r");
        let value;
        try {
            const info = await handle.stat();
            if (!info.isFile() || info.size > 256 * 1024)
                throw new Error("manifest must be a file up to 256 KiB");
            const buffer = Buffer.alloc(256 * 1024 + 1);
            const { bytesRead } = await handle.read(buffer);
            if (bytesRead > 256 * 1024)
                throw new Error("manifest exceeds limit");
            try {
                value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
            }
            catch {
                throw new Error("invalid plugin manifest JSON");
            }
        }
        finally {
            await handle.close();
        }
        const manifest = validatePluginManifest(value);
        process.stdout.write(`${manifest.id}@${manifest.version}: valid SDK v1 connector\n`);
    }
    else if (command === "scaffold" && target) {
        const id = flags.find((flag) => flag.startsWith("--id="))?.slice(5) ?? target.split(/[\\/]/u).at(-1);
        const image = flags.find((flag) => flag.startsWith("--image="))?.slice(8);
        if (flags.some((flag) => !flag.startsWith("--id=") && !flag.startsWith("--image=")))
            throw new Error("unknown scaffold option");
        const scaffold = createConnectorScaffold(id, image), root = resolve(target);
        await mkdir(root, { mode: 0o700 });
        for (const [name, content] of Object.entries(scaffold.files))
            await writeFile(join(root, name), content, { flag: "wx", mode: 0o600 });
        process.stdout.write(`Created ${scaffold.manifest.id} in ${root}\n`);
    }
    else
        throw new Error("Usage: odinn-plugin scaffold <new-directory> [--id=name] [--image=digest-pinned-image] | validate <plugin.json>");
}
catch (error) {
    throw new Error(error instanceof Error ? error.message : "Plugin authoring failed");
}
