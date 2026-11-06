import {createContext, use, useCallback, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes} from "react";
import {DropdownMenu} from "radix-ui";
import {Expand, MoreHorizontal, Settings2, Trash2, X} from "lucide-react";
import {Button} from "@/components/ui/button";
import {IconButton} from "./react-ui";
import type {PanelFrameProps} from "./panel-types";

interface PanelInteractions {
  workspace: boolean;
  register: (id: string, element: HTMLElement | null) => void;
  handle: (id: string) => ButtonHTMLAttributes<HTMLButtonElement>;
  expanded: string | null;
  dragging: string | null;
  dropBefore: string | null;
  dropAfter: string | null;
  hidden: ReadonlySet<string>;
}

export const PanelInteractionsContext = createContext<PanelInteractions>({
  workspace: false, register: () => {}, handle: () => ({}), expanded: null, dragging: null, dropBefore: null, dropAfter: null, hidden: new Set(),
});

export function PanelFrame({spec, title, unit, refreshing = false, status, path, loaded, view, menuActions, className = "", actions, children, onAction}: PanelFrameProps) {
  const context = use(PanelInteractionsContext);
  const contextRef = useRef(context);
  contextRef.current = context;
  const element = useRef<HTMLElement | null>(null);
  const [height, setHeight] = useState(280);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuPointerDown = useRef(false);
  const menuContent = useRef<HTMLDivElement>(null);
  const register = useCallback((node: HTMLElement | null) => {
    element.current = node; contextRef.current.register(spec.id, node);
  }, [spec.id]);
  const expanded = context.expanded === spec.id;
  useLayoutEffect(() => {
    const node = element.current!;
    const observer = new ResizeObserver(() => {
      if (contextRef.current.expanded !== spec.id && node.getBoundingClientRect().height > 0) setHeight(node.getBoundingClientRect().height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [spec.id]);
  const kind = spec.kind === "chart" ? "chart" : spec.kind === "snapshot-table" && spec.view ? "snapshot" : "table";
  return <>
    {expanded && <div className={`panel-placeholder ${spec.size === "wide" ? "wide" : ""}`} data-panel-size={spec.size} style={{height}} />}
    <div className={expanded ? "panel-frame-host panel-fullscreen" : "panel-frame-host"} role={expanded ? "dialog" : undefined}
      aria-modal={expanded || undefined} aria-label={expanded ? title : undefined}>
      {expanded && <div className="panel-fullscreen-controls"><IconButton label="Close" onClick={() => onAction("expand")}><X /></IconButton></div>}
      <article ref={register} data-panel-id={spec.id} data-section-id={spec.sectionId} data-panel-size={spec.size}
    data-path={path ?? (spec.kind === "metric-table" ? spec.paths[0] : spec.path)} data-loaded={loaded}
    data-view={view ?? (spec.kind === "snapshot-table" ? spec.view?.type : undefined)}
    data-refreshing={refreshing} hidden={context.hidden.has(spec.id)} inert={context.expanded !== null && !expanded}
    className={`chart-card ${kind === "chart" ? "" : "table-card"} ${spec.size === "wide" ? "wide" : ""} ${expanded ? "is-expanded" : ""} ${context.dragging === spec.id ? "is-dragging" : ""} ${context.dropBefore === spec.id ? "drop-before" : ""} ${context.dropAfter === spec.id ? "drop-after" : ""} ${className}`}>
    <header className="chart-header panel-header">
      <div className="metric-heading"><h2 title={title} aria-label={title}>
        {context.workspace ? <button type="button" className="panel-drag-handle" aria-label={`Move ${title}`} title={`${title} · Drag to move, or press Space`}
          disabled={expanded} aria-description="Space picks up this panel. Up/down reorders; left/right changes section. Enter drops; Escape cancels."
          aria-keyshortcuts="Space ArrowUp ArrowDown ArrowLeft ArrowRight Enter Escape"
          aria-pressed={context.dragging === spec.id} {...context.handle(spec.id)}>
          <span className="panel-title-text">{title}</span><span className="metric-unit">{unit ?? ""}</span>
        </button> : <><span className="panel-title-text">{title}</span><span className="metric-unit">{unit ?? ""}</span></>}
      </h2></div>
      <div className="panel-indicators"><span className="chart-status muted" role="status" hidden={!status}>{status ?? ""}</span></div>
      {context.workspace && <div className="panel-actions">
        {actions}
        {kind !== "chart" && <IconButton label={`Edit ${kind}`} onClick={() => onAction("edit")}><Settings2 /></IconButton>}
        <IconButton label={expanded ? "Close fullscreen" : `Expand ${kind}`} onClick={() => onAction("expand")}><Expand /></IconButton>
        <DropdownMenu.Root modal={false} open={menuOpen} onOpenChange={open => {setMenuOpen(open); if (!open) menuPointerDown.current = false;}}>
          <DropdownMenu.Trigger asChild><Button variant="ghost" size="icon-xs" className="menu-trigger" aria-label={`${title} ${kind} options`}><MoreHorizontal /></Button></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content ref={menuContent} className="menu-content react-menu" sideOffset={6} align="end" aria-label={`Actions for ${title}`}
            onCloseAutoFocus={event => {
              event.preventDefault();
              const active = document.activeElement;
              const trigger = element.current?.querySelector<HTMLElement>(".menu-trigger");
              if (!active || active === document.body || active === trigger || menuContent.current?.contains(active)) trigger?.focus({preventScroll: true});
            }}
            onPointerDownCapture={() => {menuPointerDown.current = true;}}
            onPointerUpCapture={() => {menuPointerDown.current = false;}}
            onPointerCancelCapture={() => {menuPointerDown.current = false;}}
            onFocusOutside={event => {if (menuPointerDown.current) event.preventDefault();}}
            onKeyDown={event => {if (event.key === "Tab") setMenuOpen(false);}}>
            <DropdownMenu.Item className="menu-item" onSelect={() => onAction("edit")}><Settings2 />Edit {kind}</DropdownMenu.Item>
            {!expanded && <DropdownMenu.Item className="menu-item" onSelect={() => onAction("expand")}><Expand />Fullscreen</DropdownMenu.Item>}
            {menuActions?.map(action => <DropdownMenu.Item key={action.label} className="menu-item" disabled={action.disabled ?? false} onSelect={action.onSelect}>{action.label}</DropdownMenu.Item>)}
            <DropdownMenu.Item className="menu-item destructive" onSelect={() => onAction("remove")}><Trash2 />Remove {kind}</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>}
    </header>
    {children}
      </article>
    </div>
  </>;
}
