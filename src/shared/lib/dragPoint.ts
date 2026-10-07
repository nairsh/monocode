import { IS_WIN } from "../../platform/tauri/platform";

/**
 * Convert a Tauri drag-drop position to CSS pixels. The API types it as
 * PhysicalPosition, but only WebView2 on Windows reports physical pixels.
 * macOS (NSDraggingInfo) and GTK report logical points, which the webview's
 * page zoom (the UI scale setting) still has to be divided out of. WebView2
 * folds its zoom into `devicePixelRatio` already.
 */
export function dragPointToClient(
  x: number,
  y: number,
  zoom: number = 1,
  isWin: boolean = IS_WIN,
  scale: number = window.devicePixelRatio || 1,
): { x: number; y: number } {
  const divisor = isWin ? scale : zoom;
  if (divisor === 1 || !(divisor > 0)) return { x, y };
  return { x: x / divisor, y: y / divisor };
}
