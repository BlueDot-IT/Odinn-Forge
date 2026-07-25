import type { StateSurface } from "../schema-registry.ts";

export type StateMigrationContext = {
  stateRoot: string;
  applicationVersion: string;
  applicationCommit: string;
  minimumApplicationVersion: string;
  targetVersions: Readonly<Record<StateSurface, number>>;
};

export type StateMigrationResult = {
  changed: string[];
  preservedUnknownFields: boolean;
  notes: string[];
};

export type StateMigrationDefinition = {
  id: string;
  surface: StateSurface;
  from: number;
  to: number;
  rollbackCompatible: boolean;
  apply(context: StateMigrationContext): Promise<StateMigrationResult>;
};
