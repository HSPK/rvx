import type {SnapshotAggregateResponse} from "../../domain/snapshot-views";
import type {TableCell} from "../../domain/tables";

interface Decimal {coefficient: bigint; digits: string; exponent: bigint; magnitude: bigint; text: string}
export interface ShadeDomain {
  bounds: {minimum: Decimal; maximum: Decimal; origin: bigint; low: bigint; span: bigint} | null;
  unavailable: number;
  scale: "linear" | "log";
  anchor: Decimal | null;
  logUnit: bigint;
  logSpan: number;
}

/** Decode bounded exact decimal cells without overflowing large exponents or rounding adjacent u64s. */
function decimal(cell: TableCell | undefined): Decimal | null {
  if (cell?.kind !== "number" || cell.truncated) return null;
  const match = cell.text.length <= 1024 && /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(cell.text);
  if (!match) throw new Error("Shade values must contain valid exact numeric text.");
  const fraction = match[3] ?? "", digits = (match[2]! + fraction).replace(/^0+/, "") || "0";
  const coefficient = BigInt(digits) * (match[1] ? -1n : 1n);
  const exponent = coefficient === 0n ? 0n : BigInt(match[4] ?? "0") - BigInt(fraction.length);
  return {coefficient, digits, exponent, magnitude: exponent + BigInt(digits.length), text: cell.text};
}

/** Compare scientific decimal representations without expanding their exponent-sized zero padding. */
function compare(a: Decimal, b: Decimal): number {
  if (a.coefficient === 0n) return b.coefficient === 0n ? 0 : b.coefficient < 0n ? 1 : -1;
  if (b.coefficient === 0n) return a.coefficient < 0n ? -1 : 1;
  if ((a.coefficient < 0n) !== (b.coefficient < 0n)) return a.coefficient < 0n ? -1 : 1;
  const sign = a.coefficient < 0n ? -1 : 1;
  if (a.magnitude !== b.magnitude) return (a.magnitude < b.magnitude ? -1 : 1) * sign;
  const length = Math.max(a.digits.length, b.digits.length), left = a.digits.padEnd(length, "0"), right = b.digits.padEnd(length, "0");
  return (left < right ? -1 : left > right ? 1 : 0) * sign;
}

/** Retain a bounded significant-digit window before subtraction, preserving close large-value differences. */
function scaled(value: Decimal, origin: bigint): bigint {
  if (value.coefficient === 0n) return 0n;
  const shift = value.exponent - origin;
  if (shift >= 0n) {
    if (shift > 4096n) throw new Error("Shade scaling exceeded its bounded precision window.");
    return value.coefficient * 10n ** shift;
  }
  return -shift >= BigInt(value.digits.length) ? 0n : value.coefficient / 10n ** -shift;
}

/** Work with magnitudes without changing exact numeric readouts or expanding scientific notation. */
function absolute(value: Decimal): Decimal {
  return value.coefficient < 0n ? {...value, coefficient: -value.coefficient} : value;
}

/** Subtract before logarithms so close large values do not collapse to identical browser floats. */
function combine(a: Decimal, b: Decimal, subtract = false): Decimal {
  if (b.coefficient === 0n) return a;
  if (a.coefficient === 0n) return subtract ? {...b, coefficient: -b.coefficient} : b;
  const magnitude = a.magnitude > b.magnitude ? a.magnitude : b.magnitude;
  const exponent = magnitude - BigInt(Math.max(a.digits.length, b.digits.length) + 12);
  const coefficient = scaled(a, exponent) + (subtract ? -1n : 1n) * scaled(b, exponent);
  const digits = (coefficient < 0n ? -coefficient : coefficient).toString();
  return {coefficient, digits, exponent, magnitude: exponent + BigInt(digits.length), text: ""};
}

/** Evaluate log1p(numerator/denominator) in shared decade units, including enormous exponents. */
function logRatio(numerator: Decimal, denominator: Decimal, unit: bigint): number {
  if (numerator.coefficient === 0n) return 0;
  const delta = numerator.magnitude - denominator.magnitude;
  const mantissa = (value: Decimal): number => {
    const prefix = value.digits.slice(0, 16);
    return Number(prefix) / 10 ** (prefix.length - 1);
  };
  const remainder = Math.log(mantissa(numerator)) - Math.log(mantissa(denominator));
  if (delta > 20n) return Number(delta * 1_000_000_000_000_000n / unit) / 1e15 * Math.LN10 + remainder / Number(unit);
  if (delta < -324n) return 0;
  return Math.log1p(Math.exp(Number(delta) * Math.LN10 + remainder)) / Number(unit);
}

/** Signed log1p preserves zero and negative values using the full dataset's smallest nonzero magnitude. */
function logDistance(low: Decimal, high: Decimal, anchor: Decimal, unit: bigint): number {
  if (low.coefficient >= 0n) return logRatio(combine(high, low, true), combine(anchor, low), unit);
  if (high.coefficient <= 0n) return logRatio(combine(high, low, true), combine(anchor, absolute(high)), unit);
  return logRatio(absolute(low), anchor, unit) + logRatio(high, anchor, unit);
}

/** Validate and combine pinned full-dataset extrema; missing values never become numeric zero. */
export function statusShadeDomain(response: SnapshotAggregateResponse, scale: ShadeDomain["scale"] = "linear"): ShadeDomain {
  let minimum: Decimal | null = null, maximum: Decimal | null = null, anchor: Decimal | null = null, numeric = 0;
  for (const group of response.groups) for (const series of group.series) {
    const low = series.measures.shade_min, high = series.measures.shade_max;
    if (!low || !high || !Number.isSafeInteger(low.count) || low.count < 0 || low.count !== high.count
      || low.count > Number(series.measures.count?.value.text)) throw new Error("Task shade range is incomplete.");
    if (!low.count) {
      if (low.value.kind !== "missing" || high.value.kind !== "missing") throw new Error("Empty task shade ranges must remain missing.");
      continue;
    }
    const a = decimal(low.value), b = decimal(high.value);
    if (!a || !b || compare(a, b) > 0) throw new Error("Task shade range is invalid or truncated.");
    if (scale === "log" && (a.coefficient !== 0n || b.coefficient !== 0n)) {
      const magnitude = decimal(low.minimum_magnitude);
      if (!magnitude || magnitude.coefficient <= 0n
        || compare(magnitude, absolute(a)) > 0 && compare(magnitude, absolute(b)) > 0) throw new Error("Task logarithmic shade magnitude is incomplete.");
      if (!anchor || compare(magnitude, anchor) < 0) anchor = magnitude;
    }
    numeric += low.count;
    if (!minimum || compare(a, minimum) < 0) minimum = a;
    if (!maximum || compare(b, maximum) > 0) maximum = b;
  }
  if (numeric > response.matched_rows) throw new Error("Task shade counts exceed the filtered dataset.");
  const unavailable = response.matched_rows - numeric;
  if (!minimum || !maximum) return {bounds: null, unavailable, scale, anchor, logUnit: 1n, logSpan: 0};
  const magnitude = minimum.coefficient === 0n ? maximum.magnitude : maximum.coefficient === 0n ? minimum.magnitude
    : minimum.magnitude > maximum.magnitude ? minimum.magnitude : maximum.magnitude;
  const origin = magnitude - BigInt(Math.max(minimum.digits.length, maximum.digits.length) + 6);
  const low = scaled(minimum, origin), span = scaled(maximum, origin) - low;
  const decades = anchor ? magnitude - anchor.magnitude : 0n, logUnit = decades > 1n ? decades : 1n;
  const logSpan = anchor ? logDistance(minimum, maximum, anchor, logUnit) : 0;
  return {bounds: {minimum, maximum, origin, low, span}, unavailable, scale, anchor, logUnit, logSpan};
}

/** Map cached exact values to a shared scale, retaining a neutral midpoint for constant fields. */
export function statusShade(cell: TableCell | undefined, domain: ShadeDomain): number | null {
  const value = decimal(cell);
  if (!value) return null;
  const bounds = domain.bounds;
  if (!bounds || compare(value, bounds.minimum) < 0 || compare(value, bounds.maximum) > 0) throw new Error("Task shade range does not cover the record page.");
  if (compare(bounds.minimum, bounds.maximum) === 0) return .5;
  if (bounds.span <= 0n) throw new Error("Task shade range lost numeric precision.");
  if (domain.scale === "log") {
    if (!domain.anchor || value.coefficient !== 0n && compare(absolute(value), domain.anchor) < 0) throw new Error("Task logarithmic shade magnitude does not cover the record page.");
    // Below this relative span, log1p and linear differ by less than the rendered intensity precision.
    if (domain.logSpan >= 1e-8) return Math.max(0, Math.min(1, logDistance(bounds.minimum, value, domain.anchor, domain.logUnit) / domain.logSpan));
  }
  const numerator = scaled(value, bounds.origin) - bounds.low;
  return Math.max(0, Math.min(1, Number(numerator * 1_000_000n / bounds.span) / 1_000_000));
}
