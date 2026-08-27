const DEFAULT_MAXIMUM_BYTES = 4_096;
const DEFAULT_MAXIMUM_DEPTH = 128;
const WINDOWS_INVALID_COMPONENT_CHARACTERS = /[<>:"|?*]/u;
const WINDOWS_RESERVED_DEVICE_STEM = /^(?:AUX|CLOCK\$|CON|CONIN\$|CONOUT\$|NUL|PRN|COM[1-9¹²³]|LPT[1-9¹²³])$/u;

export type PortableArchivePathOptions = {
  maximumBytes?: number;
  maximumDepth?: number;
};

/**
 * Return the single cross-platform spelling used for archive admission and
 * extraction. The contract is deliberately narrower than any one host
 * filesystem so an archive has the same path identity on Unix and Win32.
 */
export function canonicalPortableArchivePath(raw: string, options: PortableArchivePathOptions = {}): string {
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
  const maximumDepth = options.maximumDepth ?? DEFAULT_MAXIMUM_DEPTH;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0
    || !Number.isSafeInteger(maximumDepth) || maximumDepth <= 0
    || !raw
    || Buffer.byteLength(raw, "utf8") > maximumBytes
    || raw.includes("\\")
    || /[\0-\x1f\x7f]/u.test(raw)) {
    throw new Error("unsafe portable archive path");
  }

  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) === 0x2f) end -= 1;
  const withoutDirectoryMarker = end === raw.length ? raw : raw.slice(0, end);
  if (!withoutDirectoryMarker || withoutDirectoryMarker.startsWith("/") || /^[A-Za-z]:/u.test(withoutDirectoryMarker)) {
    throw new Error("unsafe portable archive path");
  }

  const canonical = withoutDirectoryMarker.normalize("NFC");
  const parts = canonical.split("/");
  if (parts.length > maximumDepth) throw new Error("unsafe portable archive path");
  for (const part of parts) {
    if (!part
      || part === "."
      || part === ".."
      || part.endsWith(".")
      || part.endsWith(" ")
      || WINDOWS_INVALID_COMPONENT_CHARACTERS.test(part)) {
      throw new Error("unsafe portable archive path");
    }
    const stem = part.split(".", 1)[0]!.toUpperCase();
    if (WINDOWS_RESERVED_DEVICE_STEM.test(stem)) throw new Error("unsafe portable archive path");
  }
  return canonical;
}

/**
 * A conservative, locale-independent identity. Uppercasing catches Unicode
 * aliases such as long-s/S and sharp-s/SS in addition to ordinary case and
 * canonical-composition collisions.
 */
export function portableArchivePathIdentity(canonicalPath: string): string {
  return canonicalPath.normalize("NFC").toUpperCase().normalize("NFC");
}
