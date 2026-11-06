import {useId, type ComponentProps, type ReactNode} from "react";
import {Tooltip as TooltipPrimitive} from "radix-ui";
import {Button} from "@/components/ui/button";
import {Dialog, DialogContent, DialogDescription, DialogTitle} from "@/components/ui/dialog";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import mark from "../assets/rvx-mark.svg";

export function Brand() {
  return <span className="brand" role="img" aria-label="RVX">
    <img className="brand-icon" src={mark} alt="" width={28} height={28} />
    <svg className="brand-wordmark" viewBox="0 0 42 21" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
        d="M3 16V5m0 5c0-3 2-5 5-5h2M14 5l5 11 5-11M29 5l10 11M39 5 29 16" />
    </svg>
  </span>;
}

export function Tooltip({label, children, side = "top"}: {label: ReactNode; children: ReactNode; side?: "top" | "right" | "bottom" | "left"}) {
  return <TooltipPrimitive.Root>
    <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content side={side} sideOffset={8} className="rvx-tooltip">{label}</TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>;
}

export function IconButton({label, children, ...props}: Omit<ComponentProps<typeof Button>, "children"> & {label: string; children: ReactNode}) {
  return <Tooltip label={label}><Button variant="ghost" size="icon-sm" aria-label={label} {...props}>{children}</Button></Tooltip>;
}

export function Message({title, description, children}: {title: string; description?: string; children?: ReactNode}) {
  return <div className="empty-state"><h2>{title}</h2>{description && <p className="muted">{description}</p>}{children}</div>;
}

export function Field({label, children}: {label: string; children: ReactNode}) {
  return <label className="field"><span className="field-label">{label}</span>{children}</label>;
}

export function Modal({title, description, children, onClose, className = ""}: {
  title: string; description?: string; children: ReactNode; onClose: () => void; className?: string;
}) {
  return <Dialog open onOpenChange={open => {if (!open) onClose();}}>
    <DialogContent className={`react-dialog ${className}`} aria-describedby={description ? undefined : ""}>
      <DialogTitle>{title}</DialogTitle>
      {description && <DialogDescription>{description}</DialogDescription>}
      <div className="dialog-body">{children}</div>
    </DialogContent>
  </Dialog>;
}

export function SelectControl({label, title = label, options, value, onChange, onReselect, className = "", disabled = false, icon}: {
  label: string; options: readonly (readonly [string, string, boolean?])[]; value: string;
  onChange: (value: string) => void; onReselect?: (value: string) => void; className?: string; disabled?: boolean; title?: string;
  icon?: ReactNode;
}) {
  const empty = useId();
  const choices = options.some(([id]) => id === value) ? options : [...options, [value, `Unavailable ${label.toLowerCase()}`] as const];
  return <Select value={value || empty} onValueChange={value => onChange(value === empty ? "" : value)} disabled={disabled}>
    <SelectTrigger aria-label={label} title={title} data-value={value} className={`select ${className}`} showIcon={!icon}>
      {icon ? <><span className="sr-only"><SelectValue /></span>{icon}</> : <SelectValue />}
    </SelectTrigger>
    <SelectContent position="popper">
      {choices.map(([id, name, disabled]) => <SelectItem key={id} value={id || empty} data-value={id} disabled={disabled ?? false}
        onPointerUp={event => {if (event.pointerType === "mouse" && id === value) onReselect?.(id);}}
        onClick={event => {
          if ("pointerType" in event.nativeEvent && event.nativeEvent.pointerType !== "mouse" && id === value) onReselect?.(id);
        }} onKeyDown={event => {if (["Enter", " "].includes(event.key) && id === value) onReselect?.(id);}}>{name}</SelectItem>)}
    </SelectContent>
  </Select>;
}
