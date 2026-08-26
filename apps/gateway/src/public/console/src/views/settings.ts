export function cloneConfig<T>(value: T): T { return JSON.parse(JSON.stringify(value || {})); }
export function configLines(value: unknown): string[] { return String(value || "").split("\n").map((entry) => entry.trim()).filter(Boolean); }
export function configNumber(value: unknown, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
export function selectedOption(value: unknown, current: unknown): string { return String(value) === String(current) ? " selected" : ""; }
export function renderOptions(values: unknown[], current: unknown): string { return values.map((value) => '<option value="' + String(value) + '"' + selectedOption(value, current) + ">" + String(value) + "</option>").join(""); }
