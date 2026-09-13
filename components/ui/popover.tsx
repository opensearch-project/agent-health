/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { cn } from "@/lib/utils"

// Anchored on Radix's Popover primitive (already a project dependency via
// Select/DropdownMenu) instead of hand-rolled `position: absolute; top-full`
// CSS. The old implementation positioned its panel relative to a wrapper div
// that lived inside a `position: sticky` toolbar; that combination is a
// well-known class of browser layout footguns (subpixel/containing-block
// edge cases around sticky ancestors, no collision detection, no viewport
// flip) and manifested as the run-selector panel rendering detached from its
// trigger on /compare. Radix's Popover.Content uses Floating UI under the
// hood — portaled to <body>, position computed from the trigger's live
// getBoundingClientRect() and kept in sync via scroll/resize listeners — so
// it can't detach the way the CSS-relative version could. It also already
// coordinates correctly with nested Radix portals (e.g. a <Select> inside a
// PopoverContent, as in AgentTracesPage's filter panel), which is exactly
// what the old manual click-outside listener was working around by
// special-casing `[data-radix-popper-content-wrapper]`.

const Popover = PopoverPrimitive.Root;

// All current call sites pass a single interactive element (a <Button> or
// <button>) as the trigger's child, whether or not they set `asChild` —
// the old implementation always rendered a wrapping <div onClick>` (ignoring
// `asChild` entirely) so callers never relied on a real, unwrapped trigger
// element. Always slotting via Radix's `asChild` preserves that behavior
// (no extra wrapper, no nested <button>) without touching call sites.
const PopoverTrigger = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Trigger>,
  Omit<React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>, 'asChild'> & { asChild?: boolean }
>(({ children, asChild: _asChild, ...props }, ref) => (
  <PopoverPrimitive.Trigger ref={ref} asChild {...props}>
    {children}
  </PopoverPrimitive.Trigger>
));
PopoverTrigger.displayName = "PopoverTrigger";

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'start', sideOffset = 4, collisionPadding = 8, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      side="bottom"
      align={align}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        "z-50 min-w-[280px] max-lg:max-w-[calc(100vw-0.5rem)] rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = "PopoverContent";

export { Popover, PopoverTrigger, PopoverContent };
