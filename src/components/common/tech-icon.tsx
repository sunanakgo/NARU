import {
  siBun,
  siDeno,
  siGo,
  siNodedotjs,
  siPython,
  siRust,
  type SimpleIcon,
} from "simple-icons";

/** Render a simple-icons brand glyph in its official color. */
export function Si({
  icon,
  size = 14,
  color,
  className,
}: {
  icon: SimpleIcon;
  size?: number;
  color?: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill={color ?? `#${icon.hex}`}
      aria-label={icon.title}
    >
      <path d={icon.path} />
    </svg>
  );
}

const RUNTIME_ICONS: Record<string, { icon: SimpleIcon; color?: string }> = {
  node: { icon: siNodedotjs },
  bun: { icon: siBun, color: "#f9f1e1" },
  deno: { icon: siDeno, color: "#ffffff" },
  rust: { icon: siRust, color: "#f74c00" },
  go: { icon: siGo },
  python: { icon: siPython },
};

/** Real logo for a detected runtime (node/bun/deno/rust/go/python). */
export function TechIcon({ kind, size = 14 }: { kind: string; size?: number }) {
  const def = RUNTIME_ICONS[kind];
  if (!def) return null;
  return <Si icon={def.icon} size={size} color={def.color} />;
}
