interface Props {
  x: number;
  y: number;
  zoom: number;
  pointsCount: number;
}

export function StatusBar({ x, y, zoom, pointsCount }: Props) {
  return (
    <footer className="status-bar">
      <span>X: {x.toFixed(2)}</span>
      <span>Y: {y.toFixed(2)}</span>
      <span>Zoom: {(zoom * 100).toFixed(0)}%</span>
      <span>Точек: {pointsCount}</span>
    </footer>
  );
}
