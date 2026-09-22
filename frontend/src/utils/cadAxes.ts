export function cadAxisPlacement(origin: { x: number; y: number }, width: number, height: number) {
  const atOrigin = Number.isFinite(origin.x) && Number.isFinite(origin.y)
    && origin.x >= 0 && origin.x <= width && origin.y >= 0 && origin.y <= height;
  const x = atOrigin ? origin.x : Math.min(28, width / 2);
  const y = atOrigin ? origin.y : Math.max(60, height - 30);
  return {
    x, y, atOrigin,
    xLength: Math.min(48, Math.max(0, width - x - 16)),
    yLength: Math.min(44, Math.max(0, y - 16)),
    xLabel: { x: Math.min(width - 16, x + 54), y: Math.min(height - 16, Math.max(2, y - 8)) },
    yLabel: { x: Math.max(2, x - 5), y: Math.max(2, y - 62) }
  };
}
