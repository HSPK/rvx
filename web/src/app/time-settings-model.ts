import type {RangeState} from "./model";
import {formatTimeBound, parseTimeBound} from "./time";

export type TimeSettingsResult = {ok: true; range: RangeState} | {ok: false; error: string; field: "from" | "to" | "format"};

/** Unchanged displayed dates must retain their original subsecond nanosecond coordinates. */
export function timeSettingsRange(range: RangeState, bounds: {from?: number; to?: number}, axis: string,
  from: string, to: string, format: string): TimeSettingsResult {
  const texts = [from, to], values = [bounds.from, bounds.to];
  const originals = values.map(value => formatTimeBound(value, range.axis));
  const retainable = originals.map(text => parseTimeBound(text, range.axis).ok);
  const parsed: (number | undefined)[] = [];
  for (const [index, text] of texts.entries()) {
    const result = retainable[index] && axis === range.axis && text === originals[index]
      ? {ok: true as const, value: values[index]} : parseTimeBound(text, axis);
    if (!result.ok) return {ok: false, error: result.error, field: index ? "to" : "from"};
    parsed.push(result.value);
  }
  const [start, end] = parsed;
  if (start !== undefined && end !== undefined && start > end) {
    return {ok: false, error: "The end must not be before the start.", field: "to"};
  }
  if (format !== "auto" && format !== "time" && format !== "date") {
    return {ok: false, error: "Choose Auto, Time or Date for X-axis labels.", field: "format"};
  }
  const unchanged = axis === range.axis && texts.every((text, index) => retainable[index] && text === originals[index]);
  const next: RangeState = unchanged ? {...range} : {
    axis, window: start !== undefined || end !== undefined ? "custom" : "all",
    ...(start === undefined ? {} : {from: start}), ...(end === undefined ? {} : {to: end}),
  };
  if (format === "auto") delete next.timeFormat;
  else next.timeFormat = format;
  return {ok: true, range: next};
}
