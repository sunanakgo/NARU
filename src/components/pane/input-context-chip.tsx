import type { QuotaWindow } from "@/store/quota";
import { cn } from "@/lib/utils";

export function QuotaPct({ label, w }: { label: string; w: QuotaWindow | null }) {
  if (!w) return null;
  const pct = Math.round(w.used_percent);
  return (
    <span className="inline-flex items-baseline gap-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-semibold",
          pct >= 85 ? "text-t-red" : pct >= 60 ? "text-warn" : "text-t-green"
        )}
      >
        {pct}%
      </span>
    </span>
  );
}

export function Chip({
  className,
  style,
  title,
  onClick,
  children,
}: {
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const Comp = onClick ? "button" : "span";
  return (
    <Comp
      title={title}
      style={style}
      onClick={onClick}
      className={cn(
        "inline-flex max-w-60 items-center gap-1 rounded-md border border-border bg-background/70 px-1.5 py-[2px] font-mono text-[11px] leading-4",
        onClick && "cursor-pointer transition-colors hover:border-ring hover:bg-accent",
        className
      )}
    >
      {children}
    </Comp>
  );
}

