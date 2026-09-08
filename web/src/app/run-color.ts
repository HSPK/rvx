import {palette} from "./model";
import {button, dialog, el, field} from "./ui";

/** Pick a Run's display color without changing its status or recorded experiment configuration. */
export function runColorDialog(current: string, choose: (color: string | null) => boolean, onClose: () => void): ReturnType<typeof dialog> {
  const modal = dialog("Run color", "run-color-dialog", onClose);
  const swatches = el("div", "run-color-palette");
  const select = (value: string | null): void => {if (choose(value)) modal.close();};
  for (const color of palette) {
    const swatch = button(color, () => select(color), "run-color-swatch");
    swatch.style.setProperty("--swatch-color", color);
    swatch.setAttribute("aria-label", `Use ${color}`);
    swatch.setAttribute("aria-pressed", String(current.toLowerCase() === color));
    swatches.append(swatch);
  }
  const custom = el("input"); custom.type = "color"; custom.value = current;
  custom.setAttribute("aria-label", "Custom run color");
  custom.addEventListener("change", () => select(custom.value));
  const controls = el("div", "run-color-controls");
  controls.append(field("Custom", custom), button("Automatic", () => select(null), "button quiet"));
  modal.body.append(swatches, controls);
  return modal;
}
