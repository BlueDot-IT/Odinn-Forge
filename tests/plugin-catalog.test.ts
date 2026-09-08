import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertPluginCatalogUrl, fetchCatalogPlugin, fetchPluginPackage, loadPluginCatalog } from "../packages/kernel/src/plugin-catalog.ts";
import { packPluginPackage, scaffoldPlugin } from "../packages/kernel/src/plugin-packages.ts";
test("catalog requires pinned artifacts and honest metadata, not authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-catalog-")); await scaffoldPlugin(join(root,"source"), "catalog-fixture"); const packed = await packPluginPackage(join(root,"source"), join(root,"plugin.zip"));
  const entry = { id: packed.manifest.id, version: packed.manifest.version, sdkVersion: "1.0", name: "Fixture", description: "Catalog fixture", artifact: "plugin.zip", digest: packed.digest, publisher: "Unverified label" }; const path=join(root,"catalog.json");
  await writeFile(path, JSON.stringify({schemaVersion:1,plugins:[entry]})); const catalog=await loadPluginCatalog(path); assert.equal(catalog.plugins[0]?.artifact,join(root,"plugin.zip"));
  assert.equal((await fetchCatalogPlugin(catalog,entry.id,entry.version,join(root,"copy.zip"))).digest,packed.digest);
  await writeFile(path,JSON.stringify({schemaVersion:1,plugins:[{...entry,id:"wrong-fixture"}]})); const mismatch=await loadPluginCatalog(path); await assert.rejects(()=>fetchCatalogPlugin(mismatch,"wrong-fixture",entry.version,join(root,"wrong.zip")),/identity/);
  for(const change of [{digest:""},{artifact:"../outside.zip"},{trusted:true},{sdkVersion:"2.0"}]) { await writeFile(path,JSON.stringify({schemaVersion:1,plugins:[{...entry,...change}]})); await assert.rejects(()=>loadPluginCatalog(path)); }
});
test("catalog remote admission refuses private DNS, unsafe URLs, missing digest and oversized input", async()=>{
  for(const url of ["http://example.com/plugin.zip","https://127.0.0.1/plugin.zip","https://localhost/plugin.zip","https://example.com:444/plugin.zip","https://example.com/plugin.zip?token=value","https://user@example.com/plugin.zip"]) assert.throws(()=>assertPluginCatalogUrl(url));
  for(const answers of [["127.0.0.1"],["93.184.216.34","10.0.0.1"]]) await assert.rejects(()=>loadPluginCatalog("https://example.com/catalog.json",{resolveNetworkAddresses:async()=>answers}),/non-public/);
  await assert.rejects(()=>fetchPluginPackage("https://example.com/plugin.zip","","/unused"),/SHA-256/);
  const root=await mkdtemp(join(tmpdir(),"odinn-catalog-limit-")); const path=join(root,"catalog.json"); await writeFile(path,Buffer.alloc(256*1024+1)); await assert.rejects(()=>loadPluginCatalog(path),/bounded/);
});
