/** Round exact decimal text for display only, without coercing stored integers through Number. */
export function decimalDisplay(text: string, places: number | undefined): string {
  if (places === undefined) return text;
  if (!Number.isInteger(places) || places < 0 || places > 20) throw new RangeError("Decimal places must be from 0 to 20.");
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new TypeError("Expected exact decimal number text.");
  const fraction = match[3] ?? "", digits = (match[2]! + fraction).replace(/^0+(?=\d)/, "");
  const exponent = Number(match[4] ?? 0);
  const shift = exponent - fraction.length + places;
  let rounded: string;
  if (shift >= 0) {
    // Keep extreme exponents bounded rather than allocating an unbounded fixed-point expansion.
    if (digits.length + shift > 4096) return text;
    rounded = digits + "0".repeat(shift);
  } else {
    const keep = digits.length + shift;
    rounded = keep > 0 ? digits.slice(0, keep) : "0";
    if (keep >= 0 && digits.charCodeAt(keep) >= 53) rounded = (BigInt(rounded) + 1n).toString();
  }
  const padded = rounded.padStart(places + 1, "0");
  const sign = match[1] && /[1-9]/.test(rounded) ? "-" : "";
  return sign + (places ? `${padded.slice(0, -places)}.${padded.slice(-places)}` : padded);
}
