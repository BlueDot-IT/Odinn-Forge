import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ADVANCED_FEATURE_BRANDS,
  CORE_ADVANCED_FEATURES,
  EXPERIMENTAL_FEATURES,
  advancedFeatureLabel,
  experimentalFeatureWarning
} from "../packages/kernel/src/index.ts";

test("advanced services expose clear branded labels without changing compatibility identifiers", () => {
  assert.deepEqual([...CORE_ADVANCED_FEATURES], ["proof", "sentinel", "rewind", "darwin"]);
  assert.deepEqual([...EXPERIMENTAL_FEATURES], ["capsules", "capabilities", "counterfactual"]);

  assert.deepEqual(
    Object.fromEntries(Object.entries(ADVANCED_FEATURE_BRANDS).map(([id, brand]) => [id, brand.name])),
    {
      proof: "Runemark",
      sentinel: "Gatewatch",
      rewind: "Norn Restore",
      darwin: "Raven Route",
      capabilities: "Rune Key",
      capsules: "Saga Archive",
      counterfactual: "Worldtree Paths"
    }
  );

  for (const [id, brand] of Object.entries(ADVANCED_FEATURE_BRANDS)) {
    assert.ok(brand.descriptor.length > 0, `${id} needs a plain-language descriptor`);
    assert.ok(brand.legacyName.length > 0, `${id} needs its compatibility name`);
    assert.equal(
      advancedFeatureLabel(id as keyof typeof ADVANCED_FEATURE_BRANDS),
      `${brand.name} — ${brand.descriptor}`
    );
  }

  assert.equal(
    experimentalFeatureWarning({ capabilities: true, capsules: true }),
    "optional plugin modules enabled: Saga Archive (capsules), Rune Key (capabilities)"
  );
});

test("security guidance distinguishes core services from flag-controlled plugin modules", async () => {
  const security = await readFile(new URL("../SECURITY.md", import.meta.url), "utf8");

  assert.match(security, /core advanced services/u);
  assert.match(security, /available by default and do not use experimental feature flags/u);
  assert.match(security, /optional plugin modules and are disabled by default/u);

  for (const id of CORE_ADVANCED_FEATURES) {
    assert.match(security, new RegExp(ADVANCED_FEATURE_BRANDS[id].name, "u"));
    assert.doesNotMatch(security, new RegExp(`experimental enable ${id}\\b`, "u"));
  }

  for (const id of EXPERIMENTAL_FEATURES) {
    assert.match(security, new RegExp(ADVANCED_FEATURE_BRANDS[id].name, "u"));
    assert.match(security, new RegExp(`experimental enable ${id}\\b`, "u"));
  }
});
