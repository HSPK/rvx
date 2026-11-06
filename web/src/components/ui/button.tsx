import * as React from "react";
import {cva, type VariantProps} from "class-variance-authority";
import {cn} from "cn";
import {Slot} from "radix-ui";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline: "border-border bg-background hover:bg-muted hover:text-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-muted",
        ghost: "hover:bg-muted hover:text-foreground",
      },
      size: {
        default: "h-8 gap-1.5 px-2.5",
        sm: "h-7 gap-1 rounded-md px-2.5 text-xs",
        icon: "size-8",
        "icon-sm": "size-7 rounded-md",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
      },
    },
    defaultVariants: {variant: "default", size: "default"},
  },
);

function Button({className, variant, size, asChild = false, ...props}:
  React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & {asChild?: boolean}) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp type="button" data-slot="button" className={cn(buttonVariants({variant, size, className}))} {...props} />;
}

export {Button, buttonVariants};
