import type {ComponentProps} from "react";
import {cn} from "cn";
import {Dialog as DialogPrimitive} from "radix-ui";
import {X} from "lucide-react";
import {Button} from "./button";

const Dialog = DialogPrimitive.Root;
const DialogTitle = DialogPrimitive.Title;
const DialogDescription = DialogPrimitive.Description;

function DialogContent({className, children, onOpenAutoFocus, ...props}: ComponentProps<typeof DialogPrimitive.Content>) {
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay data-slot="dialog-overlay" className="fixed inset-0 z-50 bg-black/10" />
    <DialogPrimitive.Content data-slot="dialog-content" className={cn(
      "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none sm:max-w-sm",
      className,
    )} {...props} onOpenAutoFocus={event => {
      onOpenAutoFocus?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (event.target instanceof HTMLElement) event.target.focus({preventScroll: true});
    }}>
      {children}
      <DialogPrimitive.Close asChild>
        <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2" aria-label="Close"><X /></Button>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>;
}

export {Dialog, DialogContent, DialogTitle, DialogDescription};
