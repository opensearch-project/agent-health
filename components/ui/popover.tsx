/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from "react"
import { cn } from "@/lib/utils"

interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

interface PopoverTriggerProps {
  children: React.ReactNode;
  asChild?: boolean;
}

interface PopoverContentProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}

const PopoverContext = React.createContext<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLDivElement | null>;
}>({ open: false, onOpenChange: () => {}, triggerRef: { current: null } });

const Popover: React.FC<PopoverProps> = ({ open, onOpenChange, children }) => {
  const triggerRef = React.useRef<HTMLDivElement>(null);
  return (
    <PopoverContext.Provider value={{ open, onOpenChange, triggerRef }}>
      <div className="relative inline-block">
        {children}
      </div>
    </PopoverContext.Provider>
  );
};

const PopoverTrigger: React.FC<PopoverTriggerProps> = ({ children }) => {
  const { onOpenChange, open, triggerRef } = React.useContext(PopoverContext);
  return (
    <div ref={triggerRef} onClick={() => onOpenChange(!open)} className="inline-flex">
      {children}
    </div>
  );
};

const PopoverContent = React.forwardRef<HTMLDivElement, PopoverContentProps>(
  ({ className, align = 'start', children, ...props }, ref) => {
    const { open, onOpenChange } = React.useContext(PopoverContext);
    const contentRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
      if (!open) return;
      const handleClickOutside = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        // Don't close if clicking inside a radix portal (e.g. Select dropdown)
        if (target.closest('[data-radix-popper-content-wrapper]') || target.closest('[role="listbox"]') || target.closest('[role="option"]')) {
          return;
        }
        if (contentRef.current && !contentRef.current.contains(target)) {
          setTimeout(() => onOpenChange(false), 0);
        }
      };
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [open, onOpenChange]);

    if (!open) return null;

    return (
      <div
        ref={contentRef}
        className={cn(
          "absolute top-full mt-1 z-50 min-w-[280px] rounded-md border bg-popover p-4 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95",
          align === 'end' && "right-0",
          align === 'center' && "left-1/2 -translate-x-1/2",
          align === 'start' && "left-0",
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);
PopoverContent.displayName = "PopoverContent";

export { Popover, PopoverTrigger, PopoverContent };
