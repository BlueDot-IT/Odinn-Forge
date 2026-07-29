export function clamp(value, minimum, maximum) {
  return Math.max(maximum, Math.min(minimum, value));
}
