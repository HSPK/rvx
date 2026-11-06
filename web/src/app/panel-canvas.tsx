import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from "react";
import {ChevronDown, Plus} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {PanelInteractionsContext} from "./panel-frame";
import {copyLayout, movePanel, removeSection, type PanelSpec, type WorkspaceLayout} from "./panels";
import {Field, IconButton, Modal} from "./react-ui";

function scrollOwner(node: HTMLElement) {
  const scroller = node.closest<HTMLElement>(".chart-scroll");
  return scroller && getComputedStyle(scroller).overflowY === "visible"
    ? scroller.closest<HTMLElement>(".app-content") : scroller;
}

interface Drag {
  id: string; sectionId: string; index: number; keyboard: boolean; active: boolean; valid: boolean;
  x: number; y: number; startX: number; startY: number;
}

export function PanelCanvas({layout, onChange, onAdd, expanded, onExpandedChange, onVisibleChange, renderPanel}: {
  layout: WorkspaceLayout; onChange: (layout: WorkspaceLayout) => void; onAdd: (sectionId: string) => void;
  expanded: string | null; onExpandedChange: (id: string | null) => void; onVisibleChange: (ids: Set<string>) => void;
  renderPanel: (panel: PanelSpec) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const views = useRef(new Map<string, HTMLElement>());
  const observer = useRef<IntersectionObserver | null>(null);
  const visible = useRef(new Set<string>());
  const callbacks = useRef({onChange, onVisibleChange, onExpandedChange, layout});
  callbacks.current = {onChange, onVisibleChange, onExpandedChange, layout};
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragging = useRef(drag); dragging.current = drag;
  const [announcement, setAnnouncement] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const frame = useRef(0);
  const register = useCallback((id: string, node: HTMLElement | null) => {
    const old = views.current.get(id);
    if (old) observer.current?.unobserve(old);
    if (node) {views.current.set(id, node); observer.current?.observe(node);}
    else {
      views.current.delete(id);
      if (visible.current.delete(id)) callbacks.current.onVisibleChange(new Set(visible.current));
    }
  }, []);
  useEffect(() => {
    const instance = new IntersectionObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.panelId;
        if (!id) continue;
        if (entry.isIntersecting && !visible.current.has(id)) {visible.current.add(id); changed = true;}
        else if (!entry.isIntersecting && visible.current.delete(id)) changed = true;
      }
      if (changed) callbacks.current.onVisibleChange(new Set(visible.current));
    }, {threshold: .01});
    observer.current = instance;
    for (const node of views.current.values()) instance.observe(node);
    return () => {instance.disconnect(); observer.current = null; cancelAnimationFrame(frame.current);};
  }, []);
  useLayoutEffect(() => {
    if (!expanded) return;
    const node = views.current.get(expanded);
    if (!node) {onExpandedChange(null); return;}
    const dialog = node.closest<HTMLElement>(".panel-fullscreen") ?? node;
    const viewport = scrollOwner(node);
    const position = viewport ? {top: viewport.scrollTop, left: viewport.scrollLeft} : null;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.querySelector<HTMLElement>('button[aria-label="Close"]')?.focus({preventScroll: true});
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {event.preventDefault(); callbacks.current.onExpandedChange(null); return;}
      if (event.key !== "Tab" || document.querySelector('[data-slot="dialog-content"]')) return;
      const choices = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]')]
        .filter(item => item.getClientRects().length > 0);
      const current = choices.indexOf(document.activeElement as HTMLElement), index = current + (event.shiftKey ? -1 : 1);
      if (index < 0 || index >= choices.length || current < 0) {event.preventDefault(); choices[event.shiftKey ? choices.length - 1 : 0]?.focus();}
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      const target = previous?.isConnected && previous !== document.body ? previous
        : node.isConnected ? node.querySelector<HTMLElement>(".menu-trigger") : null;
      target?.focus({preventScroll: true});
      if (node.isConnected && viewport?.isConnected && position) viewport.scrollTo({...position, behavior: "instant"});
    };
  }, [expanded, onExpandedChange]);
  function commitMove() {
    const current = dragging.current;
    if (!current?.active || !current.valid) {setDrag(null); return;}
    const next = copyLayout(callbacks.current.layout);
    const panels = next.panels.filter(panel => panel.sectionId === current.sectionId && panel.id !== current.id);
    movePanel(next, current.id, current.sectionId, panels[current.index]?.id);
    const section = next.sections.find(section => section.id === current.sectionId);
    if (section) section.collapsed = false;
    setDrag(null); dragging.current = null; cancelAnimationFrame(frame.current); frame.current = 0;
    onChange(next); setAnnouncement(`Panel moved to ${section?.name || "initial section"}, position ${current.index + 1}.`);
    queueMicrotask(() => views.current.get(current.id)?.querySelector<HTMLElement>(".panel-drag-handle")?.focus({preventScroll: true}));
  }
  function target(current: Drag) {
    const node = root.current!, area = node.getBoundingClientRect();
    const owner = scrollOwner(node)!;
    const viewport = owner.getBoundingClientRect();
    const valid = current.x >= Math.max(area.left, viewport.left) && current.x <= Math.min(area.right, viewport.right)
      && current.y >= Math.max(area.top, viewport.top) && current.y <= Math.min(area.bottom, viewport.bottom);
    const hit = document.elementFromPoint(current.x, current.y)?.closest<HTMLElement>("[data-section-id]");
    if (!valid || !hit) return {...current, valid: false};
    const sectionId = hit.dataset.sectionId!;
    const panels = layout.panels.filter(panel => panel.sectionId === sectionId && panel.id !== current.id);
    const index = panels.findIndex(panel => panel.id === hit.dataset.panelId);
    const rect = hit.getBoundingClientRect();
    const after = current.y > rect.top + rect.height * .75 || current.y >= rect.top + rect.height * .25 && current.x > rect.left + rect.width / 2;
    return {...current, valid: true, sectionId, index: index < 0 ? panels.length : index + Number(after)};
  }
  function autoscroll() {
    frame.current = 0;
    const current = dragging.current;
    if (!current?.active || current.keyboard) return;
    const scroll = root.current!.closest<HTMLElement>(".chart-scroll")!;
    const owner = getComputedStyle(scroll).overflowY === "visible" ? scroll.closest<HTMLElement>(".app-content")! : scroll;
    const box = owner.getBoundingClientRect();
    const speed = current.y < box.top + 48 ? -12 : current.y > box.bottom - 48 ? 12 : 0;
    if (speed) {owner.scrollTop += speed; const next = target(current); dragging.current = next; setDrag(next);}
    frame.current = requestAnimationFrame(autoscroll);
  }
  const hidden = useMemo(() => new Set(layout.panels.filter(panel => layout.sections.find(section => section.id === panel.sectionId)?.collapsed).map(panel => panel.id)), [layout]);
  const targets = drag?.valid ? layout.panels.filter(panel => panel.sectionId === drag.sectionId && panel.id !== drag.id) : [];
  const context = {
    workspace: true, register, expanded, hidden, dragging: drag?.active ? drag.id : null,
    dropBefore: targets[drag?.index ?? -1]?.id ?? null,
    dropAfter: drag?.valid && drag.index >= targets.length ? targets.at(-1)?.id ?? null : null,
    handle: (id: string) => ({
      onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0 || expanded) return;
        const panel = layout.panels.find(panel => panel.id === id)!;
        const next: Drag = {id, sectionId: panel.sectionId, index: 0, keyboard: false, active: false, valid: false,
          x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY};
        dragging.current = next; setDrag(next); event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => {
        const current = dragging.current;
        if (!current || current.id !== id || current.keyboard) return;
        if (!current.active && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return;
        const next = target({...current, active: true, x: event.clientX, y: event.clientY});
        dragging.current = next; setDrag(next);
        if (!frame.current) frame.current = requestAnimationFrame(autoscroll);
      },
      onPointerUp: () => commitMove(),
      onPointerCancel: () => {setDrag(null); dragging.current = null; cancelAnimationFrame(frame.current); frame.current = 0;},
      onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
        const current = dragging.current;
        if (event.key === "Escape" && current) {event.preventDefault(); setDrag(null); dragging.current = null; setAnnouncement("Move canceled."); return;}
        if ([" ", "Enter"].includes(event.key) && current?.id === id) {event.preventDefault(); commitMove(); return;}
        if (event.key === " " && !current) {
          event.preventDefault();
          const panel = layout.panels.find(panel => panel.id === id)!;
          const next: Drag = {id, sectionId: panel.sectionId, index: layout.panels.filter(item => item.sectionId === panel.sectionId).findIndex(item => item.id === id),
            keyboard: true, active: true, valid: true, x: 0, y: 0, startX: 0, startY: 0};
          dragging.current = next; setDrag(next); return;
        }
        if (!current?.keyboard || current.id !== id || !event.key.startsWith("Arrow")) return;
        event.preventDefault();
        const next = {...current};
        if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
          const index = Math.max(0, Math.min(layout.sections.length - 1, layout.sections.findIndex(section => section.id === current.sectionId) + (event.key === "ArrowRight" ? 1 : -1)));
          next.sectionId = layout.sections[index]!.id; next.index = 0;
        } else next.index = Math.max(0, Math.min(layout.panels.filter(panel => panel.sectionId === current.sectionId && panel.id !== id).length,
          current.index + (event.key === "ArrowDown" ? 1 : -1)));
        dragging.current = next; setDrag(next);
        setAnnouncement(`Move to ${layout.sections.find(section => section.id === next.sectionId)?.name || "initial section"}, position ${next.index + 1}. Enter drops; Escape cancels.`);
      },
    }),
  };
  const items: ReactNode[] = [];
  for (const section of layout.sections) {
    const panels = layout.panels.filter(panel => panel.sectionId === section.id);
    items.push(<section key={`section:${section.id}`} className={`workspace-section section-header ${drag?.valid && drag.sectionId === section.id && !targets.length ? "drop-empty" : ""}`}
      data-section-id={section.id} hidden={layout.sections.length === 1 && !section.name}>
      <IconButton label={`${section.collapsed ? "Expand" : "Collapse"} section ${section.name || "Untitled"}`} className={`section-toggle ${section.collapsed ? "collapsed" : ""}`}
        aria-expanded={!section.collapsed} onClick={() => {const next = copyLayout(layout); next.sections.find(item => item.id === section.id)!.collapsed = !section.collapsed; onChange(next);}}><ChevronDown /></IconButton>
      <Button variant="ghost" className="section-name" onClick={() => {setEditing(section.id); setName(section.name);}}>{section.name || "Untitled section"}</Button>
      <IconButton label={`Add to section ${section.name || "Untitled"}`} onClick={() => onAdd(section.id)}><Plus /></IconButton>
    </section>);
    for (const panel of panels) items.push(<PanelSlot key={panel.id}>{renderPanel(panel)}</PanelSlot>);
    if (!panels.length && !section.collapsed) items.push(<div key={`empty:${section.id}`} className="section-empty" data-section-id={section.id}>
      <Button variant="ghost" onClick={() => onAdd(section.id)}><Plus />Add panel</Button>
    </div>);
  }
  return <PanelInteractionsContext value={context}>
    {expanded && <div className="panel-fullscreen-backdrop" onClick={() => onExpandedChange(null)} />}
    <div ref={root} className="section-stack chart-grid section-grid react-panel-grid">
      <span className="sr-only" role="status">{announcement || (drag && !drag.valid ? "Outside the workspace. Release to cancel." : "")}</span>
      {items}
    </div>
    {editing && <Modal title="Section" onClose={() => setEditing(null)}>
      <Field label="Name"><Input aria-label="Section name" value={name} maxLength={100} onChange={event => setName(event.target.value)} /></Field>
      <footer className="section-editor-actions">
        <Button variant="ghost" onClick={() => {const next = copyLayout(layout); removeSection(next, editing); onChange(next); setEditing(null);}}>Delete section</Button>
        <Button onClick={() => {const next = copyLayout(layout); next.sections.find(section => section.id === editing)!.name = name.trim(); onChange(next); setEditing(null);}}>Save</Button>
      </footer>
    </Modal>}
  </PanelInteractionsContext>;
}

function PanelSlot({children}: {children: ReactNode}) {return children;}
