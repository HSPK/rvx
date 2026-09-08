import {axisLabel, type RangeState} from "./model";
import {formatTimeBound, parseTimeBound} from "./time";
import {button, el, field, select, type dialog} from "./ui";

/** Edit alignment and human bounds without changing chart state until the user applies them. */
export function renderTimeSettings(modal: ReturnType<typeof dialog>, axes: string[], range: RangeState, applyRange: (range: RangeState) => void,
  initialBounds: Pick<RangeState, "from" | "to"> = range): void {
  const from = el("input", "text-input"), to = el("input", "text-input");
  const inputs = [from, to], bounds = [initialBounds.from, initialBounds.to];
  const originals = bounds.map(value => formatTimeBound(value, range.axis));
  const retainable = originals.map(value => parseTimeBound(value, range.axis).ok);
  const note = el("p", "muted"), error = el("p", "error-text");
  error.setAttribute("role", "alert");
  for (const input of inputs) input.addEventListener("input", () => {error.textContent = "";});
  const fromField = field("From", from), toField = field("To", to);
  const alignment = select("Alignment", axes.map(axis => [axis, axisLabel(axis)]),
    axes.includes(range.axis) ? range.axis : axes[0] ?? "elapsed", () => update(false));
  const update = (initial: boolean): void => {
    const axis = alignment.value, wall = axis === "wall_time", elapsed = axis === "elapsed";
    for (const [index, input] of inputs.entries()) {
      input.type = wall ? "datetime-local" : "text";
      input.step = "1"; input.maxLength = 128;
      input.inputMode = wall || elapsed ? "text" : "numeric";
      input.value = initial && axis === range.axis ? originals[index]! : "";
      if (initial && axis === range.axis) originals[index] = input.value;
      input.placeholder = elapsed ? (index ? "e.g. 2h" : "e.g. 30m") : "No limit";
      const label = `${index ? "To" : "From"} (${wall ? "local time" : elapsed ? "elapsed" : axisLabel(axis)})`;
      input.setAttribute("aria-label", label);
      [fromField, toField][index]!.querySelector("span")!.textContent = label;
    }
    note.textContent = wall
      ? `Local time (${Intl.DateTimeFormat().resolvedOptions().timeZone}). Leave either bound blank for no limit.`
      : elapsed ? "From each run's first observation. Use 30s, 5m or 1h 15m; blank means no limit."
      : `Use recorded ${axisLabel(axis)} coordinates. Blank means no limit.`;
    error.textContent = initial && retainable.some(valid => !valid) ? "The current range contains an unsupported bound. Enter a new value or clear it." : "";
  };
  const apply = button("Apply", () => {
    const parsed: (number | undefined)[] = [];
    for (const [index, input] of inputs.entries()) {
      const result = retainable[index] && alignment.value === range.axis && input.value === originals[index]
        ? {ok: true as const, value: bounds[index]} : parseTimeBound(input.value, alignment.value);
      if (!result.ok) {error.textContent = result.error; input.focus(); return;}
      parsed.push(result.value);
    }
    const [start, end] = parsed;
    if (start !== undefined && end !== undefined && start > end) {
      error.textContent = "The end must not be before the start."; to.focus(); return;
    }
    const unchanged = alignment.value === range.axis && inputs.every((input, index) => retainable[index] && input.value === originals[index]);
    applyRange(unchanged ? {...range} : {axis: alignment.value, window: start !== undefined || end !== undefined ? "custom" : "all",
      ...(start === undefined ? {} : {from: start}), ...(end === undefined ? {} : {to: end})});
    modal.close();
  }, "button primary");
  apply.setAttribute("aria-label", "Apply time settings");
  const alignmentRow = el("div", "time-alignment-row"), boundsRow = el("div", "time-bounds");
  alignmentRow.append(field("Alignment", alignment), apply); boundsRow.append(fromField, toField);
  note.classList.add("sr-only");
  modal.body.append(alignmentRow, note, boundsRow, error);
  update(true);
}
