export type BoundResult = {ok: true; value: number | undefined} | {ok: false; error: string};
const units: Record<string, bigint> = {d: 86400_000000000n, h: 3600_000000000n, m: 60_000000000n, s: 1_000000000n, ms: 1_000000n, us: 1_000n, ns: 1n};

/** Keep submitted coordinates within signed storage bounds and serialize them without silent rounding. */
function coordinate(value: bigint): BoundResult {
  if (value < -(1n << 63n) || value > (1n << 63n) - 1n) return {ok: false, error: "This bound is outside the supported range."};
  const number = Number(value);
  if (String(number) !== String(value)) return {ok: false, error: "This bound is too precise for a chart. Use a rounder value."};
  return {ok: true, value: number};
}

/** Parse human durations, local whole-second dates, or logical integers into unchanged API units. */
export function parseTimeBound(input: string, axis: string): BoundResult {
  const text = input.trim();
  if (!text) return {ok: true, value: undefined};
  if (text.length > 128) return {ok: false, error: "This bound is too long."};
  if (axis === "wall_time") {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(text)) return {ok: false, error: "Choose a local date and time, to the nearest second."};
    const date = new Date(text);
    if (!Number.isFinite(date.getTime()) || localDateTime(date) !== (text.length === 16 ? `${text}:00` : text)) {
      return {ok: false, error: "This local date or time does not exist."};
    }
    return coordinate(BigInt(date.getTime()) * 1_000000n);
  }
  if (axis !== "elapsed") {
    if (!/^-?\d+$/.test(text)) return {ok: false, error: "Enter a whole-number coordinate, or leave it blank."};
    return coordinate(BigInt(text));
  }
  const signed = text.startsWith("-") ? -1n : 1n;
  const value = text.replace(/^-/, "").toLowerCase();
  const duration = /^\d+(?:\.\d+)?$/.test(value) ? `${value}s` : value;
  let total = 0n, end = 0;
  for (const match of duration.matchAll(/(\d+(?:\.\d+)?)\s*(ns|us|ms|s|m|h|d)/g)) {
    if (duration.slice(end, match.index).trim()) return {ok: false, error: "Use a duration such as 30s, 5m or 1h 15m."};
    const [whole, fraction = ""] = match[1]!.split(".");
    if (fraction.length > 18) return {ok: false, error: "Use at most 18 decimal places."};
    const scaled = BigInt(`${whole}${fraction}`) * units[match[2]!]!;
    const divisor = 10n ** BigInt(fraction.length);
    if (scaled % divisor) return {ok: false, error: "Duration precision cannot be smaller than a nanosecond."};
    total += scaled / divisor;
    end = match.index! + match[0].length;
  }
  if (!end || duration.slice(end).trim()) return {ok: false, error: "Use a duration such as 30s, 5m or 1h 15m."};
  return coordinate(total * signed);
}

/** Format local date fields without converting their displayed clock to UTC. */
function localDateTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Provide editable human values; callers retain the original bound when this text is unchanged. */
export function formatTimeBound(value: number | undefined, axis: string): string {
  if (value === undefined) return "";
  if (!Number.isInteger(value) || Math.abs(value) > 2 ** 63) return String(value);
  if (axis === "wall_time") return localDateTime(new Date(value / 1e6));
  if (axis !== "elapsed") return String(value);
  let remaining = BigInt(String(value));
  const sign = remaining < 0n ? "-" : "";
  if (remaining < 0n) remaining = -remaining;
  const parts: string[] = [];
  for (const unit of ["d", "h", "m"]) {
    const amount = remaining / units[unit]!;
    remaining %= units[unit]!;
    if (amount) parts.push(`${amount}${unit}`);
  }
  if (remaining || !parts.length) {
    const fraction = String(remaining % units.s!).padStart(9, "0").replace(/0+$/, "");
    parts.push(`${remaining / units.s!}${fraction ? `.${fraction}` : ""}s`);
  }
  return sign + parts.join(" ");
}

/** Offer time-aware steps to uPlot instead of generic increments such as 5,000 seconds. */
export const elapsedIncrements = [
  ...Array.from({length: 9}, (_, index) => [1, 2, 5].map(factor => factor * 10 ** (index - 9))).flat(),
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200,
  ...[1, 2, 7, 14, 30, 60, 180, 365, 730, 3650, 36500, 365000].map(days => days * 86400),
];

/** Label duration ticks compactly, including subsecond observations and zero origin. */
export function elapsedTick(seconds: number): string {
  if (!seconds) return "0s";
  const sign = seconds < 0 ? "-" : "", value = Math.abs(seconds);
  if (value < 1) {
    const [factor, suffix]: [number, string] = value < 1e-6 ? [1e9, "ns"] : value < 1e-3 ? [1e6, "us"] : [1e3, "ms"];
    return `${sign}${Number((value * factor).toFixed(6))}${suffix}`;
  }
  let remaining = value;
  const parts: string[] = [];
  for (const [size, suffix] of [[86400, "d"], [3600, "h"], [60, "m"]] as const) {
    const count = Math.floor(remaining / size);
    remaining -= count * size;
    if (count) parts.push(`${count}${suffix}`);
  }
  const rest = Number(remaining.toFixed(6));
  if (rest) parts.push(`${rest}s`);
  return sign + parts.join(" ");
}
