export function logicalBound(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  if (!/^[+-]?\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error("Logical bounds must be signed safe integers between -9007199254740991 and 9007199254740991.");
  }
  return Number(text);
}
