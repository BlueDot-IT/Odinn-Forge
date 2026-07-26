import assert from "node:assert/strict";
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
