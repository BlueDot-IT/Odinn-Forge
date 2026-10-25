import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { gzipSync } from "node:zlib";

const slackRequire = createRequire(new URL("../adapters/channels/slack/package.json", import.meta.url));
const discordRequire = createRequire(new URL("../adapters/channels/discord/package.json", import.meta.url));
const discordRuntimeRequire = createRequire(discordRequire.resolve("discord.js"));
const boltRequire = createRequire(slackRequire.resolve("@slack/bolt"));

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

for (const [name, require] of [["Discord", discordRuntimeRequire], ["Slack", slackRequire]] as const) {
  test(`${name} HTTP dependency rejects excessive content encodings without a late uncaught error`, { timeout: 10_000 }, async (t) => {
    const { fetch } = require("undici");
    const server = createServer((request, response) => {
      if (request.url === "/malformed") {
        response.writeHead(200, {
          "content-encoding": "gzip, gzip, gzip, gzip, gzip, gzip",
          "content-length": "10",
          connection: "close"
        });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    const url = await listen(server);
    t.after(() => close(server));
    await assert.rejects(() => fetch(`${url}/malformed`), /fetch failed/u);
    // A subsequent round trip also gives the rejected response time to close.
    const response = await fetch(`${url}/healthy`);
    assert.deepEqual(await response.json(), { ok: true });
  });
}

test("Slack HTTP parser handles compressed JSON and trailing compressed-body errors", { timeout: 10_000 }, async (t) => {
  const express = boltRequire("express");
  const app = express();
  app.use(express.json());
  app.post("/", (request: any, response: any) => response.json(request.body));
  app.use((error: any, _request: any, response: any, _next: any) => response.status(error.status ?? 500).end());
  const server = createServer(app);
  const url = await listen(server);
  t.after(() => close(server));
  const compressed = gzipSync(JSON.stringify({ message: "bounded local fixture" }));
  const send = (body: Buffer) => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
    body
  });
  const valid = await send(compressed);
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { message: "bounded local fixture" });
  const malformed = await send(Buffer.concat([compressed, Buffer.from("invalid trailing bytes")]));
  assert.equal(malformed.status, 400);
  await malformed.arrayBuffer();
  const healthy = await send(compressed);
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { message: "bounded local fixture" });
});
