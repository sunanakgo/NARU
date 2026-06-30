import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { motion } from "motion/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Code, ExternalLink, FolderSearch, X } from "lucide-react";

import { ToolButton } from "@/components/common/tool-button";
import { FileIcon } from "@/components/drawer/file-icon";
import { FILE_MANAGER } from "@/lib/platform";
import { useViewer } from "@/store/viewer";
import { useSettings } from "@/store/settings";

const MAX_VIEWER_LINES = 5000;

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

function extOf(p: string): string {
  const name = p.split(/[\\/]/).pop() ?? "";
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

/**
 * Right-side document viewer: json/md/ts/… open here from the explorer and
 * from path links in terminal output. Markdown renders rich by default with
 * a raw-source toggle; everything else gets a line-numbered code view.
 */
export function FileViewer() {
  const path = useViewer((s) => s.path);
  const close = useViewer((s) => s.close);
  const fontFamily = useSettings((s) => s.fontFamily);
  const [content, setContent] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    setContent(null);
    setImageUrl(null);
    setError(null);
    setShowRaw(false);
    if (!path) return;
    let alive = true;
    if (IMAGE_EXTS.has(extOf(path))) {
      void invoke<string>("read_image_data_url", { path })
        .then((u) => alive && setImageUrl(u))
        .catch((e) => alive && setError(String(e)));
    } else {
      void invoke<string>("read_text_file", { path })
        .then((c) => alive && setContent(c))
        .catch((e) => alive && setError(String(e)));
    }
    return () => {
      alive = false;
    };
  }, [path]);

  const name = path?.split(/[\\/]/).pop() ?? "";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const isImage = IMAGE_EXTS.has(ext);
  const isMarkdown = ext === "md" || ext === "mdx" || ext === "markdown";
  const lines = content?.split("\n") ?? [];
  // Cap rendered rows so a large file can't spawn tens of thousands of <tr>s.
  const shownLines = lines.slice(0, MAX_VIEWER_LINES);
  const hiddenLines = lines.length - shownLines.length;

  return (
    <motion.div
      animate={{ width: path ? 440 : 0 }}
      initial={false}
      transition={{ type: "spring", stiffness: 420, damping: 38 }}
      className="h-full shrink-0 overflow-hidden bg-sidebar"
    >
      <div className="flex h-full w-[440px] flex-col border-l border-border/60">
        <div className="flex h-[42px] shrink-0 items-center gap-2 border-b border-border/60 pr-1.5 pl-3">
          {name && <FileIcon name={name} isDir={false} size={15} />}
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={path ?? ""}>
            {name}
          </span>
          {isMarkdown && (
            <ToolButton
              tip={showRaw ? "렌더링 보기" : "원본 보기"}
              size="icon-xs"
              active={showRaw}
              onClick={() => setShowRaw((v) => !v)}
            >
              <Code />
            </ToolButton>
          )}
          <ToolButton
            tip="기본 앱으로 열기"
            size="icon-xs"
            onClick={() => path && void openPath(path).catch(() => {})}
          >
            <ExternalLink />
          </ToolButton>
          <ToolButton
            tip={`${FILE_MANAGER}에서 보기`}
            size="icon-xs"
            onClick={() => path && void revealItemInDir(path).catch(() => {})}
          >
            <FolderSearch />
          </ToolButton>
          <ToolButton tip="닫기" size="icon-xs" onClick={close}>
            <X />
          </ToolButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <p className="px-4 py-6 text-xs text-muted-foreground">{error}</p>
          ) : isImage ? (
            imageUrl === null ? (
              <p className="px-4 py-6 text-xs text-muted-foreground">로딩 중...</p>
            ) : (
              <div className="flex min-h-full items-center justify-center bg-[repeating-conic-gradient(hsl(var(--muted))_0%_25%,transparent_0%_50%)] bg-[length:18px_18px] p-3">
                <img
                  src={imageUrl}
                  alt={name}
                  className="max-h-full max-w-full rounded object-contain shadow-md"
                />
              </div>
            )
          ) : content === null ? (
            <p className="px-4 py-6 text-xs text-muted-foreground">로딩 중...</p>
          ) : isMarkdown && !showRaw ? (
            <div className="naru-md px-5 py-4">
              <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
            </div>
          ) : (
            <table
              className="w-full border-collapse text-[12px] leading-[1.55]"
              style={{ fontFamily }}
            >
              <tbody>
                {shownLines.map((line, i) => (
                  <tr key={i} className="align-top hover:bg-accent/30">
                    <td className="w-10 min-w-10 border-r border-border/40 pr-2 text-right text-[10px] text-muted-foreground/50 select-none">
                      {i + 1}
                    </td>
                    <td className="pl-3 break-all whitespace-pre-wrap">
                      {line || " "}
                    </td>
                  </tr>
                ))}
                {hiddenLines > 0 && (
                  <tr>
                    <td className="w-10 min-w-10 border-r border-border/40 select-none" />
                    <td className="pl-3 py-2 text-[11px] text-muted-foreground/70 italic">
                      … {hiddenLines.toLocaleString()}줄 더 (생략됨)
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </motion.div>
  );
}
