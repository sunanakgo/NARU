import {
  BadgeCheck,
  Braces,
  Database,
  File,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Lock,
  Settings2,
  Table,
  Terminal,
  Type,
} from "lucide-react";
import {
  siBun,
  siC,
  siCplusplus,
  siCss,
  siDart,
  siDocker,
  siDotnet,
  siElixir,
  siEslint,
  siGit,
  siGnubash,
  siGo,
  siGraphql,
  siHtml5,
  siJavascript,
  siJson,
  siKotlin,
  siLua,
  siMarkdown,
  siNodedotjs,
  siOpenjdk,
  siPhp,
  siPrettier,
  siPrisma,
  siPython,
  siReact,
  siRuby,
  siRust,
  siSvelte,
  siSvg,
  siSwift,
  siTailwindcss,
  siTauri,
  siToml,
  siTypescript,
  siVite,
  siVuedotjs,
  siYaml,
  siZig,
  type SimpleIcon,
} from "simple-icons";

import { Si } from "@/components/common/tech-icon";

/** Warp/VSCode-material-style file & folder icons: real logos for known
 * types, tinted filled folders with special-cased project directories. */

type IconDef = { icon: SimpleIcon; color?: string };

// ── folders ──────────────────────────────────────────────────────────────────

/** Special project folders get their own tint (material-icon-theme vibes). */
const FOLDER_COLORS: Record<string, string> = {
  src: "#c792ea",
  app: "#c792ea",
  components: "#42a5f5",
  pages: "#42a5f5",
  lib: "#26a69a",
  utils: "#26a69a",
  hooks: "#26a69a",
  store: "#ffa726",
  stores: "#ffa726",
  public: "#fdd835",
  static: "#fdd835",
  assets: "#ec407a",
  images: "#ec407a",
  img: "#ec407a",
  styles: "#42a5f5",
  scripts: "#4db6ac",
  test: "#ef5350",
  tests: "#ef5350",
  __tests__: "#ef5350",
  e2e: "#ef5350",
  docs: "#29b6f6",
  config: "#90a4ae",
  ".vscode": "#42a5f5",
  ".github": "#90a4ae",
  ".git": "#f4511e",
  node_modules: "#66bb6a",
  dist: "#757575",
  build: "#757575",
  out: "#757575",
  target: "#757575",
  "src-tauri": "#ffc131",
};

const DEFAULT_FOLDER = "#7aa2d4";

// ── files by exact name ──────────────────────────────────────────────────────

const BY_NAME: Record<string, IconDef> = {
  "package.json": { icon: siNodedotjs },
  "package-lock.json": { icon: siNodedotjs, color: "#7a7a7a" },
  "bun.lockb": { icon: siBun, color: "#f9f1e1" },
  "bun.lock": { icon: siBun, color: "#f9f1e1" },
  "cargo.toml": { icon: siRust, color: "#f74c00" },
  "cargo.lock": { icon: siRust, color: "#7a7a7a" },
  "go.mod": { icon: siGo },
  "go.sum": { icon: siGo, color: "#7a7a7a" },
  ".gitignore": { icon: siGit },
  ".gitattributes": { icon: siGit },
  dockerfile: { icon: siDocker },
  "docker-compose.yml": { icon: siDocker },
  "vite.config.ts": { icon: siVite },
  "vite.config.js": { icon: siVite },
  "tauri.conf.json": { icon: siTauri, color: "#ffc131" },
  "tailwind.config.js": { icon: siTailwindcss },
  "tailwind.config.ts": { icon: siTailwindcss },
  ".eslintrc": { icon: siEslint },
  "eslint.config.js": { icon: siEslint },
  ".prettierrc": { icon: siPrettier },
  "schema.prisma": { icon: siPrisma, color: "#5a67d8" },
};

// ── files by extension ───────────────────────────────────────────────────────

const BY_EXT: Record<string, IconDef> = {
  ts: { icon: siTypescript },
  mts: { icon: siTypescript },
  cts: { icon: siTypescript },
  tsx: { icon: siReact, color: "#61dafb" },
  jsx: { icon: siReact, color: "#61dafb" },
  js: { icon: siJavascript },
  mjs: { icon: siJavascript },
  cjs: { icon: siJavascript },
  json: { icon: siJson, color: "#cbcb41" },
  jsonc: { icon: siJson, color: "#cbcb41" },
  md: { icon: siMarkdown, color: "#519aba" },
  mdx: { icon: siMarkdown, color: "#519aba" },
  rs: { icon: siRust, color: "#f74c00" },
  py: { icon: siPython },
  go: { icon: siGo },
  css: { icon: siCss },
  scss: { icon: siCss, color: "#cd6799" },
  html: { icon: siHtml5 },
  htm: { icon: siHtml5 },
  vue: { icon: siVuedotjs },
  svelte: { icon: siSvelte },
  php: { icon: siPhp, color: "#8993be" },
  java: { icon: siOpenjdk, color: "#e76f00" },
  kt: { icon: siKotlin, color: "#7f52ff" },
  swift: { icon: siSwift },
  rb: { icon: siRuby },
  lua: { icon: siLua, color: "#51a0cf" },
  dart: { icon: siDart },
  ex: { icon: siElixir },
  exs: { icon: siElixir },
  zig: { icon: siZig, color: "#f7a41d" },
  c: { icon: siC, color: "#5c6bc0" },
  h: { icon: siC, color: "#9fa8da" },
  cpp: { icon: siCplusplus, color: "#5c6bc0" },
  hpp: { icon: siCplusplus, color: "#9fa8da" },
  cs: { icon: siDotnet, color: "#512bd4" },
  graphql: { icon: siGraphql },
  gql: { icon: siGraphql },
  prisma: { icon: siPrisma, color: "#5a67d8" },
  yml: { icon: siYaml, color: "#cb171e" },
  yaml: { icon: siYaml, color: "#cb171e" },
  toml: { icon: siToml, color: "#9c4221" },
  svg: { icon: siSvg, color: "#ffb13b" },
  sh: { icon: siGnubash, color: "#89e051" },
  bash: { icon: siGnubash, color: "#89e051" },
};

export function FileIcon({
  name,
  isDir,
  open = false,
  size = 15,
}: {
  name: string;
  isDir: boolean;
  open?: boolean;
  size?: number;
}) {
  const lower = name.toLowerCase();

  if (isDir) {
    const F = open ? FolderOpen : Folder;
    const color = FOLDER_COLORS[lower] ?? DEFAULT_FOLDER;
    // filled folder = the Warp/material look
    return <F size={size} color={color} fill={open ? "transparent" : color} fillOpacity={0.55} />;
  }

  const named = BY_NAME[lower];
  if (named) return <Si icon={named.icon} size={size - 2} color={named.color} />;

  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  const byExt = BY_EXT[ext];
  if (byExt) return <Si icon={byExt.icon} size={size - 2} color={byExt.color} />;

  if (lower.startsWith("readme"))
    return <FileText size={size} className="text-sky-400" />;
  if (lower.startsWith("license") || lower.startsWith("copying"))
    return <BadgeCheck size={size} className="text-amber-400" />;
  if (lower.startsWith(".env"))
    return <Settings2 size={size} className="text-yellow-400" />;
  if (["png", "jpg", "jpeg", "gif", "webp", "ico", "icns", "bmp", "avif"].includes(ext))
    return <ImageIcon size={size} className="text-violet-400" />;
  if (["woff", "woff2", "ttf", "otf", "eot"].includes(ext))
    return <Type size={size} className="text-red-400" />;
  if (["sql", "db", "sqlite"].includes(ext))
    return <Database size={size} className="text-orange-300" />;
  if (["csv", "tsv", "xlsx"].includes(ext))
    return <Table size={size} className="text-emerald-400" />;
  if (["lock", "lockb"].includes(ext))
    return <Lock size={size} className="text-muted-foreground" />;
  if (["ps1", "bat", "cmd"].includes(ext))
    return <Terminal size={size} className="text-emerald-400" />;
  if (["xml", "plist"].includes(ext))
    return <Braces size={size} className="text-orange-300" />;
  if (["txt", "log"].includes(ext))
    return <FileText size={size} className="text-muted-foreground" />;
  if (["conf", "ini"].includes(ext))
    return <Settings2 size={size} className="text-muted-foreground" />;
  return <File size={size} className="text-muted-foreground" />;
}
