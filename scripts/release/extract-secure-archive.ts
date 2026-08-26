import { resolve } from "node:path";
import { extractSecureArchive } from "../../packages/kernel/src/secure-archive.ts";

const [archiveArgument, destinationArgument, expectedRoot] = process.argv.slice(2);
if (!archiveArgument || !destinationArgument || !expectedRoot || process.argv.length !== 5) {
  throw new Error("usage: extract-secure-archive.ts ARCHIVE DESTINATION EXPECTED_ROOT");
}

await extractSecureArchive(resolve(archiveArgument), resolve(destinationArgument), { expectedRoot });
console.log(`securely extracted ${expectedRoot}`);
