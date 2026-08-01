import { access, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { FileChannelDedupeStore, FileSessionBindingStore, type ChannelAddress } from "../../packages/channels/src/index.ts";
import { SecureJsonFileStore } from "../../packages/store-file/src/index.ts";

const [mode, path, gate, ...arguments_] = process.argv.slice(2);
if (!mode || !path || !gate) throw new Error("channel-store-worker requires mode, path, and gate");

await waitForGate(gate);

if (mode === "bindings") {
  const worker = arguments_[0] ?? "worker";
  const count = Number.parseInt(arguments_[1] ?? "1", 10);
  const store = new FileSessionBindingStore(path);
  for (let index = 0; index < count; index += 1) {
    const address: ChannelAddress = {
      channel: "fixture",
      accountId: worker,
      conversationKind: "direct",
      conversationId: String(index)
    };
    await store.set(address, `${worker}-session-${index}`);
  }
} else if (mode === "claim") {
  const key = arguments_[0] ?? "shared-key";
  const store = new FileChannelDedupeStore(path);
  process.stdout.write(`${JSON.stringify({ claimed: await store.claim(key) })}\n`);
} else if (mode === "commit" || mode === "release") {
  const key = arguments_[0] ?? "shared-key";
  const store = new FileChannelDedupeStore(path);
  await store[mode](key);
} else if (mode === "crash-lock") {
  const marker = arguments_[0];
  if (!marker) throw new Error("crash-lock requires a marker path");
  const store = new SecureJsonFileStore<Record<string, unknown>>(path, {
    label: "crash fixture",
    create: () => ({ schemaVersion: 1, bindings: {} }),
    validate: (value) => value as Record<string, unknown>
  });
  await store.mutate(async () => {
    await writeFile(marker, "locked\n", "utf8");
    process.exit(73);
  });
} else {
  throw new Error(`unsupported channel-store-worker mode: ${mode}`);
}

async function waitForGate(path: string) {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for gate: ${path}`);
      await delay(5);
    }
  }
}
