export function expectedReleaseCommit(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const declared = env.ODINN_RELEASE_COMMIT?.trim() || env.GITHUB_SHA?.trim();
  if (!declared) return undefined;
  if (!/^[0-9a-f]{40}$/iu.test(declared)) {
    throw new Error("release package commit declaration is not a full Git SHA");
  }
  return declared.toLowerCase();
}

export function assertReleaseCommit(actual: string, env: NodeJS.ProcessEnv = process.env): void {
  const expected = expectedReleaseCommit(env);
  if (expected && expected !== actual.trim().toLowerCase()) {
    throw new Error(`release package commit mismatch: expected=${expected} HEAD=${actual.trim()}`);
  }
}
