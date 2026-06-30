import * as React from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type ButtonComponentProps = React.ComponentProps<typeof Button>;

interface ToolButtonProps extends ButtonComponentProps {
  /** Accessible label (no visible hover tooltip — those were removed). */
  tip: string;
  /** Accepted for call-site compatibility; unused. */
  tipSide?: "top" | "right" | "bottom" | "left";
  /** Highlight as an active/toggled control. */
  active?: boolean;
}

/**
 * NARU's standard icon button: a shadcn `Button` (ghost) with muted chrome
 * styling. No hover tooltip — `tip` is used only as an accessible label.
 */
export function ToolButton({
  tip,
  tipSide: _tipSide,
  active,
  size = "icon-sm",
  className,
  onMouseDown,
  ...props
}: ToolButtonProps) {
  return (
    <Button
      aria-label={tip}
      variant="ghost"
      size={size}
      onMouseDown={(e) => {
        e.stopPropagation();
        onMouseDown?.(e);
      }}
      className={cn(
        "text-muted-foreground hover:text-accent-foreground",
        active && "bg-primary/15 text-primary hover:text-primary",
        className
      )}
      {...props}
    />
  );
}
