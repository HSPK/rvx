export type RunParameterValue = string | number | boolean;

export function parseRunParameters(
  config: string,
): Record<string, RunParameterValue> {
  try {
    return flattenParameters(JSON.parse(config));
  } catch {
    return {};
  }
}

export function commonRunParameters(
  parameters: Array<Record<string, RunParameterValue>>,
): string[] {
  const counts = new Map<string, number>();
  for (const values of parameters) {
    for (const name of Object.keys(values)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name]) => name);
}

function flattenParameters(
  value: unknown,
  prefix = "",
  output: Record<string, RunParameterValue> = {},
): Record<string, RunParameterValue> {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (prefix) output[prefix] = value;
    return output;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;
  for (const [key, nested] of Object.entries(value)) {
    flattenParameters(nested, prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}
