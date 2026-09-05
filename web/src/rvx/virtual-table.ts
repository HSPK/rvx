export interface VirtualColumn<T> {
  id: string;
  label: string;
  width: string;
  render(row: T): string | Node;
}

export interface VirtualTableOptions<T> {
  rowHeight?: number;
  overscan?: number;
  onRowClick?(row: T): void;
  onRowDoubleClick?(row: T): void;
  onRowContextMenu?(event: MouseEvent, row: T): void;
  onSort?(columnId: string): void;
}

export class VirtualTable<T> {
  readonly element = document.createElement("div");
  private readonly header = document.createElement("div");
  private readonly viewport = document.createElement("div");
  private readonly spacer = document.createElement("div");
  private readonly layer = document.createElement("div");
  private readonly rowHeight: number;
  private readonly overscan: number;
  private rows: T[] = [];
  private columns: VirtualColumn<T>[] = [];
  private frame: number | null = null;
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly options: VirtualTableOptions<T> = {}) {
    this.rowHeight = options.rowHeight ?? 25;
    this.overscan = options.overscan ?? 8;
    this.element.className = "rvx-virtual-table";
    this.header.className = "rvx-virtual-header";
    this.viewport.className = "rvx-virtual-viewport";
    this.spacer.className = "rvx-virtual-spacer";
    this.layer.className = "rvx-virtual-layer";
    this.viewport.append(this.spacer, this.layer);
    this.element.append(this.header, this.viewport);
    this.viewport.addEventListener("scroll", () => {
      this.header.scrollLeft = this.viewport.scrollLeft;
      this.scheduleRender();
    });
    this.resizeObserver = new ResizeObserver(() => this.scheduleRender());
    this.resizeObserver.observe(this.viewport);
  }

  setData(rows: T[], columns: VirtualColumn<T>[]): void {
    this.rows = rows;
    this.columns = columns;
    const template = columns.map(column => column.width).join(" ");
    this.element.style.setProperty("--rvx-virtual-columns", template);
    this.spacer.style.height = `${rows.length * this.rowHeight}px`;
    this.renderHeader();
    this.renderRows();
  }

  scrollToTop(): void {
    this.viewport.scrollTop = 0;
    this.renderRows();
  }

  destroy(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.element.remove();
  }

  private renderHeader(): void {
    this.header.replaceChildren();
    for (const column of this.columns) {
      const cell = document.createElement("div");
      cell.dataset.column = column.id;
      if (this.options.onSort && column.id !== "select") {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = column.label;
        button.ariaLabel = `Sort by ${column.label.replace(/[↑↓]/g, "").trim()}`;
        button.addEventListener("click", () => this.options.onSort?.(column.id));
        cell.append(button);
      } else cell.textContent = column.label;
      this.header.append(cell);
    }
  }

  private scheduleRender(): void {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.renderRows();
    });
  }

  private renderRows(): void {
    const viewportHeight = this.viewport.clientHeight || 400;
    const first = Math.max(
      0,
      Math.floor(this.viewport.scrollTop / this.rowHeight) - this.overscan,
    );
    const count =
      Math.ceil(viewportHeight / this.rowHeight) + this.overscan * 2;
    const last = Math.min(this.rows.length, first + count);
    const fragment = document.createDocumentFragment();
    for (let index = first; index < last; index++) {
      const rowValue = this.rows[index]!;
      const row = document.createElement("div");
      row.className = "rvx-virtual-row";
      row.style.height = `${this.rowHeight}px`;
      row.style.transform = `translateY(${index * this.rowHeight}px)`;
      row.dataset.index = String(index);
      for (const column of this.columns) {
        const cell = document.createElement("div");
        cell.dataset.column = column.id;
        const value = column.render(rowValue);
        cell.append(
          typeof value === "string"
            ? document.createTextNode(value)
            : value,
        );
        row.append(cell);
      }
      row.addEventListener("click", () => this.options.onRowClick?.(rowValue));
      row.addEventListener("dblclick", () =>
        this.options.onRowDoubleClick?.(rowValue),
      );
      row.addEventListener("contextmenu", event => {
        event.preventDefault();
        this.options.onRowContextMenu?.(event, rowValue);
      });
      fragment.append(row);
    }
    this.layer.replaceChildren(fragment);
  }
}
