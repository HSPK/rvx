export function denseTable(headers: string[]): HTMLTableElement {
  const table = document.createElement("table");
  table.className = "rvx-table";
  const head = document.createElement("thead");
  const row = document.createElement("tr");
  for (const header of headers) {
    const cell = document.createElement("th");
    cell.textContent = header;
    row.append(cell);
  }
  head.append(row);
  table.append(head, document.createElement("tbody"));
  return table;
}

export function appendRow(
  table: HTMLTableElement,
  values: Array<string | number>,
): HTMLTableRowElement {
  const row = document.createElement("tr");
  for (const value of values) {
    const cell = document.createElement("td");
    cell.textContent = String(value);
    row.append(cell);
  }
  table.tBodies[0]!.append(row);
  return row;
}

export function runSection(
  title: string,
  content: HTMLElement,
  open = true,
): HTMLElement {
  const section = document.createElement("details");
  section.className = "rvx-run-section";
  section.open = open;
  const summary = document.createElement("summary");
  summary.textContent = title;
  const body = document.createElement("div");
  body.className = "rvx-run-section-body";
  body.append(content);
  section.append(summary, body);
  return section;
}

export function summaryStrip(
  fields: Array<[string, string | number]>,
): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "rvx-summary-strip";
  for (const [label, value] of fields) {
    const item = document.createElement("span");
    const name = document.createElement("small");
    const content = document.createElement("strong");
    name.textContent = label;
    content.textContent = String(value);
    item.append(name, content);
    strip.append(item);
  }
  return strip;
}

export function formatNs(value: number): string {
  return new Date(value / 1_000_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

export function formatValue(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
}
