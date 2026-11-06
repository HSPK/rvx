import type uPlot from "uplot";
import type {ChartRow} from "./chart-panel-model";

/** Compose a portable chart image without allocating or mounting any UI DOM. */
export async function chartPanelPng(chart: uPlot, title: string, rows: ChartRow[], view: string): Promise<Blob> {
  const source = chart.ctx.canvas;
  if (typeof OffscreenCanvas === "undefined") {
    return new Promise((resolve, reject) => source.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not encode chart PNG.")), "image/png"));
  }
  const ratio = source.width / chart.width;
  const labels = rows.slice(0, 24), remainder = rows.length - labels.length;
  const header = 34 + labels.length * 18 + (remainder ? 18 : 0) + (view ? 18 : 0);
  const canvas = new OffscreenCanvas(source.width, Math.ceil((header + chart.height + 8) * ratio));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PNG export is unavailable.");
  const style = getComputedStyle(chart.root);
  const foreground = style.getPropertyValue("--text").trim() || style.color;
  context.scale(ratio, ratio);
  context.fillStyle = style.getPropertyValue("--surface").trim() || "#fff";
  context.fillRect(0, 0, chart.width, canvas.height / ratio);
  context.fillStyle = foreground;
  const font = style.fontFamily || "system-ui, sans-serif";
  context.font = `600 12px ${font}`;
  function fitText(text: string, width: number) {
    if (context!.measureText(text).width <= width) return text;
    let low = 0, high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (context!.measureText(text.slice(0, middle) + "…").width <= width) low = middle;
      else high = middle - 1;
    }
    return text.slice(0, low) + "…";
  }
  context.fillText(fitText(title, chart.width - 24), 12, 20);
  context.font = `11px ${font}`;
  labels.forEach((row, index) => {
    const y = 38 + index * 18;
    context.strokeStyle = row.color; context.lineWidth = 2;
    context.setLineDash(row.trace?.dash ?? []);
    context.beginPath(); context.moveTo(12, y - 4); context.lineTo(24, y - 4); context.stroke();
    context.setLineDash([]); context.fillStyle = foreground;
    context.fillText(fitText(`${row.label}${row.legendState ? ` · ${row.legendState}` : ""}`, chart.width - 46), 30, y);
  });
  if (remainder) context.fillText(`+${remainder} more traces`, 12, 38 + labels.length * 18);
  if (view) context.fillText(fitText(view, chart.width - 24), 12, header - 6);
  context.drawImage(source, 0, header, chart.width, chart.height);
  return canvas.convertToBlob({type: "image/png"});
}
