type SourceContext = {source?: string};
type NativeJson = typeof JSON & {rawJSON?: (text: string) => object};

const numericSources = new WeakMap<object, Map<string, string>>();
const unsupported = "Exact snapshot JSON requires native JSON.parse source context and JSON.rawJSON. Update your browser; rounded snapshot data will not be displayed.";

/** Native parsing keeps arithmetic views fast; only changed numeric lexemes need a sidecar. */
export function parseExactJson<T extends object>(text: string): T {
  const native = JSON as NativeJson;
  let hasSourceContext = false;
  native.parse("0", (_key: string, value: unknown, context?: SourceContext) => {
    hasSourceContext = context?.source === "0";
    return value;
  });
  if (!hasSourceContext || typeof native.rawJSON !== "function") throw new Error(unsupported);

  const value: unknown = native.parse(text, function(
    this: object, key: string, value: unknown, context?: SourceContext,
  ): unknown {
    if (typeof value === "number" && context?.source && String(value) !== context.source) {
      let sources = numericSources.get(this);
      if (!sources) numericSources.set(this, sources = new Map());
      sources.set(key, context.source);
    }
    return value;
  });
  if (value === null || typeof value !== "object") throw new Error("Expected a snapshot JSON response object.");
  return value as T;
}

function rawProperty(parent: object, key: string, value: unknown): unknown {
  const source = numericSources.get(parent)?.get(key);
  if (source === undefined || typeof value !== "number" || !Object.is(value, Number(source))) return value;
  const native = JSON as NativeJson;
  if (typeof native.rawJSON !== "function") throw new Error(unsupported);
  return native.rawJSON(source);
}

/** Emits JSON numbers, never quoted strings or rounded replacements. */
export function stringifyExact(value: unknown, space?: number): string {
  const text = JSON.stringify(value, function(this: object, key: string, item: unknown): unknown {
    return rawProperty(this, key, item);
  }, space);
  if (text === undefined) throw new Error("Cannot serialize an absent JSON value.");
  return text;
}

/** Retains the parent sidecar when the selected field is itself a number. */
export function exactProperty(parent: object, key: string, space?: number): string {
  const value = (parent as Record<string, unknown>)[key];
  return stringifyExact(rawProperty(parent, key, value), space);
}
