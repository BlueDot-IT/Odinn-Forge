export function auditFacetLabel(facet: string, value: unknown): string {
  const text = String(value || "");
  if (!text) return "All";
  if (facet === "outcome") return text === "ok" ? "Completed" : text === "failed" ? "Needs attention" : text;
  if (facet === "actor") return text.replace(/^channel:/, "").replace(/^user:/, "");
  return text.replaceAll(".", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
