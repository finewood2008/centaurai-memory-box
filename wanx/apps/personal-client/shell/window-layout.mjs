// Electron uses logical pixels; large displays should leave room around the app.
export function mainWindowBounds(area) {
  if (!area || ![area.x, area.y, area.width, area.height].every(Number.isFinite) || area.width <= 0 || area.height <= 0) {
    throw new TypeError("A valid display work area is required");
  }
  const width = Math.max(1, Math.min(1100, Math.round(area.width * 0.9)));
  const height = Math.max(1, Math.min(880, Math.round(area.height * 0.9)));
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    minWidth: Math.min(760, width),
    minHeight: Math.min(560, height),
  };
}
