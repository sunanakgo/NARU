import { useTheme } from "@/store/theme";
import naruWhite from "@/assets/naru-white.png";
import naruBlack from "@/assets/naru-black.png";

/**
 * The NARU mark (two overlapping panels), theme-aware: white on dark themes,
 * black on light. Use anywhere the brand NAME would otherwise be written out.
 * (A full-color mark also lives in src/assets if ever needed.)
 */
export function NaruLogo({ className }: { className?: string }) {
  const theme = useTheme((s) => s.theme);
  return (
    <img
      src={theme === "dark" ? naruWhite : naruBlack}
      alt="NARU"
      draggable={false}
      className={className}
    />
  );
}
