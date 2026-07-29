import { Buffer } from "node:buffer";
import { SkillPackageStore } from "./skill-packages.ts";

const SKILL_ID = /^[a-z0-9][a-z0-9-]{1,63}$/u;

export type SkillCatalogEntry = {
  id: string;
  version: string;
  name: string;
  description: string;
  requestedTools: string[];
  requestedCapabilities: string[];
};

export type HydratedSkill = SkillCatalogEntry & {
  integrity: string;
  skillMarkdown: string;
};

export type SkillDisclosureLimits = {
  maxCatalogEntries?: number;
  maxCatalogBytes?: number;
  maxHydratedBytes?: number;
};

export class SkillDisclosureError extends Error {
  readonly code: "INVALID_ID" | "CATALOG_COUNT_LIMIT" | "CATALOG_BYTE_LIMIT" | "HYDRATION_REJECTED";

  constructor(code: SkillDisclosureError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SkillDisclosureError";
    this.code = code;
  }
}

export class ProgressiveSkillDisclosure {
  readonly store: SkillPackageStore;
  readonly limits: Required<SkillDisclosureLimits>;

  constructor(store: SkillPackageStore, limits: SkillDisclosureLimits = {}) {
    this.store = store;
    this.limits = {
      maxCatalogEntries: positiveLimit(limits.maxCatalogEntries, 128, "catalog entry"),
      maxCatalogBytes: positiveLimit(limits.maxCatalogBytes, 64 * 1024, "catalog byte"),
      maxHydratedBytes: positiveLimit(limits.maxHydratedBytes, 256 * 1024, "hydrated content byte")
    };
  }

  async catalog(): Promise<SkillCatalogEntry[]> {
    const eligible = await this.store.listDisclosureMetadata(this.limits.maxCatalogEntries);
    if (eligible.length > this.limits.maxCatalogEntries) {
      throw new SkillDisclosureError(
        "CATALOG_COUNT_LIMIT",
        `skill catalog contains ${eligible.length} entries; limit is ${this.limits.maxCatalogEntries}`
      );
    }
    eligible.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const catalog = eligible.map((record) => ({
      id: record.id,
      version: record.version,
      name: record.name,
      description: record.description,
      requestedTools: [...record.requestedTools].sort(),
      requestedCapabilities: [...record.requestedCapabilities].sort()
    }));
    const bytes = Buffer.byteLength(JSON.stringify(catalog), "utf8");
    if (bytes > this.limits.maxCatalogBytes) {
      throw new SkillDisclosureError(
        "CATALOG_BYTE_LIMIT",
        `skill catalog is ${bytes} UTF-8 bytes; limit is ${this.limits.maxCatalogBytes}`
      );
    }
    return catalog;
  }

  async hydrate(id: string): Promise<HydratedSkill> {
    if (!SKILL_ID.test(id)) {
      throw new SkillDisclosureError(
        "INVALID_ID",
        "skill id must be exact and contain only 2-64 lowercase letters, digits, or hyphens"
      );
    }
    try {
      const skill = await this.store.readEnabledContent(id, this.limits.maxHydratedBytes);
      return {
        id: skill.id,
        version: skill.version,
        name: skill.name,
        description: skill.description,
        requestedTools: [...skill.requestedTools].sort(),
        requestedCapabilities: [...skill.requestedCapabilities].sort(),
        integrity: skill.integrity,
        skillMarkdown: skill.content
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SkillDisclosureError("HYDRATION_REJECTED", `skill hydration rejected for ${id}: ${reason}`, { cause: error });
    }
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} limit must be a positive safe integer`);
  return resolved;
}
