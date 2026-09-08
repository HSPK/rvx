import type {SnapshotQueryResponse} from "../domain/snapshots";

type SourceContext = {source?: string};
type NativeJson = typeof JSON & {rawJSON?: (text: string) => object};

const numericSources = new WeakMap<object, Map<string, string>>();
const unsupported = "Exact snapshot JSON requires native JSON.parse source context and JSON.rawJSON. Update your browser; rounded snapshot data will not be displayed.";

/** Identify a missing native precision feature without treating programming errors as recoverable JSON input. */
export class ExactJsonUnavailable extends Error {
  /** Preserve a recognizable capability error for exact-text display surfaces. */
  constructor() {super(unsupported); this.name = "ExactJsonUnavailable";}
}

/** Native parsing keeps arithmetic views fast; only changed numeric lexemes need a sidecar. */
export function parseExactJson<T extends object>(text: string): T {
  const native = JSON as NativeJson;
  let hasSourceContext = false;
  native.parse("0", (_key: string, value: unknown, context?: SourceContext) => {
    hasSourceContext = context?.source === "0";
    return value;
  });
  if (!hasSourceContext || typeof native.rawJSON !== "function") throw new ExactJsonUnavailable();

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
  if (typeof native.rawJSON !== "function") throw new ExactJsonUnavailable();
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

/** Large projections are decoded one trace per task, retaining every numeric sidecar. */
export async function parseExactProjection(text: string, signal?: AbortSignal): Promise<SnapshotQueryResponse> {
  const response = JSON.parse(text) as SnapshotQueryResponse;
  if (!response || typeof response.axis !== "string" || !Array.isArray(response.series)) throw new Error("Invalid chart projection response.");
  const expected = response.series.length;
  const matches = [...text.matchAll(/"series"\s*:\s*\[/g)];
  if (matches.length !== 1) throw new Error("Invalid projection series array.");
  const start = matches[0]!.index! + matches[0]![0].length;
  let inString = false, escaped = false, depth = 0, objectStart = -1, index = 0;
  for (let cursor = start; cursor < text.length; cursor++) {
    const character = text[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === "{") {if (depth++ === 0) objectStart = cursor;}
    else if (character === "}") {
      if (--depth === 0) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        response.series[index++] = parseExactJson(text.slice(objectStart, cursor + 1));
        await yieldToBrowser();
      }
    } else if (character === "]" && depth === 0) break;
  }
  if (index !== expected) throw new Error("Invalid projection trace.");
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return response;
}

/** Let input and painting run between trace decodes without cloning exact numeric sidecars. */
export async function yieldToBrowser(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & {scheduler?: {yield: () => Promise<void>}}).scheduler;
  if (scheduler?.yield) await scheduler.yield();
  else await new Promise<void>(resolve => setTimeout(resolve, 0));
}
