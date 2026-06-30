/** Platform detection for chrome decisions (window controls, labels). */
export const IS_MAC =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");

/** OS file manager name for user-facing labels. */
export const FILE_MANAGER = IS_MAC ? "Finder" : "파일 탐색기";
