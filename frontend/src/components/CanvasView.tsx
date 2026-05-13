import { useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Layer, Line, Rect, Stage, Text } from 'react-konva';
import { KonvaEventObject } from 'konva/lib/Node';
import { useProjectStore } from '../store/useProjectStore';

interface Props {
  width: number;
  height: number;
  onPointerUpdate: (x: number, y: number) => void;
}

interface ScreenPoint {
  x: number;
  y: number;
}

interface WorldPoint {
  x: number;
  y: number;
}

type GroupOutlineSnapKind = 'free' | 'point' | 'vertex' | 'ortho' | 'point_ortho' | 'vertex_ortho';

interface GroupOutlineHoverPoint {
  point: WorldPoint;
  screen: ScreenPoint;
  snapScreen?: ScreenPoint;
  kind: GroupOutlineSnapKind;
}

interface VectorHoverPoint {
  point: WorldPoint;
  screen: ScreenPoint;
  kind: 'free' | 'ortho';
}

interface VectorExtendState {
  groupId: string;
  anchorIndex: number;
  basePoint: WorldPoint;
  draft: WorldPoint[];
}

type SelectionMode = 'add' | 'subtract';

interface SelectionRectState {
  x: number;
  y: number;
  w: number;
  h: number;
  mode: SelectionMode;
  label?: string;
}

const AXIS_X_COLOR = '#ef4444';
const AXIS_Y_COLOR = '#22c55e';

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleaned = hex.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null;
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16)
  };
}

function readableTextColors(background: string) {
  const rgb = hexToRgb(background);
  if (!rgb) return { fill: '#f8fafc', stroke: '#020617', bubble: 'rgba(2,6,23,0.72)' };
  const toLinear = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
  return luminance > 0.45
    ? { fill: '#020617', stroke: '#ffffff', bubble: 'rgba(255,255,255,0.82)' }
    : { fill: '#ffffff', stroke: '#020617', bubble: 'rgba(2,6,23,0.78)' };
}

function clamp255(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function applyBrightness(hex: string, multiplier: number) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const safe = Number.isFinite(multiplier) ? Math.max(0.35, Math.min(2.5, multiplier)) : 1;
  return `#${clamp255(rgb.r * safe).toString(16).padStart(2, '0')}${clamp255(rgb.g * safe).toString(16).padStart(2, '0')}${clamp255(rgb.b * safe).toString(16).padStart(2, '0')}`;
}

function hexToRgba(hex: string, alpha: number) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 'rgba(96,165,250,0.035)';
  const safeAlpha = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 0.035;
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${safeAlpha})`;
}

function textWidth(text: string, fontSize: number) {
  return Math.max(16, Math.ceil(text.length * fontSize * 0.68));
}

function distance2(a: ScreenPoint, b: ScreenPoint) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function pointToSegmentDistancePx(point: ScreenPoint, a: ScreenPoint, b: ScreenPoint) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 <= 1e-9) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2));
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  return Math.hypot(point.x - px, point.y - py);
}

function closestPointOnSegmentWorld(point: WorldPoint, a: WorldPoint, b: WorldPoint): WorldPoint {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 <= 1e-9) return { x: a.x, y: a.y };
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function getDragSelectionMode(startX: number, currentX: number, configuredMode: string): SelectionMode {
  const leftToRight = currentX >= startX;

  if (configuredMode === 'left_subtract_right_add') {
    return leftToRight ? 'subtract' : 'add';
  }

  return leftToRight ? 'add' : 'subtract';
}

function rectContains(rect: SelectionRectState, point: ScreenPoint) {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}


function cross(o: ScreenPoint, a: ScreenPoint, b: ScreenPoint) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function convexHull(points: ScreenPoint[]) {
  const unique = Array.from(
    new Map(points.map((p) => [`${Math.round(p.x * 1000)}:${Math.round(p.y * 1000)}`, p])).values()
  ).sort((a, b) => (a.x - b.x) || (a.y - b.y));

  if (unique.length <= 2) return unique;

  const lower: ScreenPoint[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }

  const upper: ScreenPoint[] = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const point = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }

  return lower.slice(0, -1).concat(upper.slice(0, -1));
}


function orthogonalUnionOutlineWorld(rects: Array<{ left: number; right: number; top: number; bottom: number }>) {
  const clean = rects
    .map((rect) => ({
      left: Math.min(rect.left, rect.right),
      right: Math.max(rect.left, rect.right),
      bottom: Math.min(rect.bottom, rect.top),
      top: Math.max(rect.bottom, rect.top)
    }))
    .filter((rect) => rect.right > rect.left && rect.top > rect.bottom);
  if (clean.length === 0) return [] as WorldPoint[];

  const xs = Array.from(new Set(clean.flatMap((rect) => [rect.left, rect.right]))).sort((a, b) => a - b);
  const ys = Array.from(new Set(clean.flatMap((rect) => [rect.bottom, rect.top]))).sort((a, b) => a - b);
  if (xs.length < 2 || ys.length < 2) return [];

  const filled = new Set<string>();
  const cellKey = (xi: number, yi: number) => `${xi}:${yi}`;
  for (let xi = 0; xi < xs.length - 1; xi += 1) {
    for (let yi = 0; yi < ys.length - 1; yi += 1) {
      const cx = (xs[xi] + xs[xi + 1]) / 2;
      const cy = (ys[yi] + ys[yi + 1]) / 2;
      if (clean.some((rect) => cx >= rect.left - 1e-9 && cx <= rect.right + 1e-9 && cy >= rect.bottom - 1e-9 && cy <= rect.top + 1e-9)) {
        filled.add(cellKey(xi, yi));
      }
    }
  }

  const vertexKey = (x: number, y: number) => `${x.toFixed(6)}:${y.toFixed(6)}`;
  const vertices = new Map<string, WorldPoint>();
  const adjacency = new Map<string, Set<string>>();
  const addVertex = (point: WorldPoint) => {
    const key = vertexKey(point.x, point.y);
    vertices.set(key, point);
    if (!adjacency.has(key)) adjacency.set(key, new Set());
    return key;
  };
  const addEdge = (a: WorldPoint, b: WorldPoint) => {
    const ak = addVertex(a);
    const bk = addVertex(b);
    adjacency.get(ak)?.add(bk);
    adjacency.get(bk)?.add(ak);
  };

  for (let xi = 0; xi < xs.length - 1; xi += 1) {
    for (let yi = 0; yi < ys.length - 1; yi += 1) {
      if (!filled.has(cellKey(xi, yi))) continue;
      const left = xs[xi];
      const right = xs[xi + 1];
      const bottom = ys[yi];
      const top = ys[yi + 1];
      if (!filled.has(cellKey(xi - 1, yi))) addEdge({ x: left, y: bottom }, { x: left, y: top });
      if (!filled.has(cellKey(xi + 1, yi))) addEdge({ x: right, y: top }, { x: right, y: bottom });
      if (!filled.has(cellKey(xi, yi - 1))) addEdge({ x: right, y: bottom }, { x: left, y: bottom });
      if (!filled.has(cellKey(xi, yi + 1))) addEdge({ x: left, y: top }, { x: right, y: top });
    }
  }

  const visited = new Set<string>();
  const loops: WorldPoint[][] = [];
  const edgeKey = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`;

  for (const start of adjacency.keys()) {
    const neighbors = adjacency.get(start);
    if (!neighbors || neighbors.size === 0) continue;
    const firstNeighbor = Array.from(neighbors).find((next) => !visited.has(edgeKey(start, next)));
    if (!firstNeighbor) continue;

    const loopKeys = [start];
    let prev = start;
    let current = firstNeighbor;
    visited.add(edgeKey(prev, current));
    let guard = 0;
    while (guard < 5000) {
      guard += 1;
      loopKeys.push(current);
      if (current === start) break;
      const nextCandidates = Array.from(adjacency.get(current) ?? []).filter((next) => next !== prev && !visited.has(edgeKey(current, next)));
      const next = nextCandidates[0] ?? Array.from(adjacency.get(current) ?? []).find((item) => item !== prev);
      if (!next) break;
      prev = current;
      current = next;
      visited.add(edgeKey(prev, current));
    }
    const loop = loopKeys.map((key) => vertices.get(key)).filter((point): point is WorldPoint => Boolean(point));
    if (loop.length >= 4) loops.push(loop);
  }

  const area = (loop: WorldPoint[]) => Math.abs(loop.reduce((sum, point, index) => {
    const next = loop[(index + 1) % loop.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2);
  const best = loops.sort((a, b) => area(b) - area(a))[0] ?? [];
  return best.length > 1 && Math.abs(best[0].x - best[best.length - 1].x) < 1e-9 && Math.abs(best[0].y - best[best.length - 1].y) < 1e-9
    ? best.slice(0, -1)
    : best;
}

function makeGroupOutline(points: ScreenPoint[], padding: number) {
  if (points.length === 0) return [] as ScreenPoint[];

  const finitePoints = points.filter(isFinitePoint);
  if (finitePoints.length === 0) return [];

  const xs = finitePoints.map((point) => point.x);
  const ys = finitePoints.map((point) => point.y);
  const minX = Math.min(...xs) - padding;
  const maxX = Math.max(...xs) + padding;
  const minY = Math.min(...ys) - padding;
  const maxY = Math.max(...ys) + padding;

  if (finitePoints.length <= 2) {
    return [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY }
    ];
  }

  const sorted = [...finitePoints].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const rowTolerance = Math.max(18, padding * 1.45);
  const rows: Array<{ centerY: number; points: ScreenPoint[] }> = [];

  for (const point of sorted) {
    const row = rows.find((item) => Math.abs(item.centerY - point.y) <= rowTolerance);
    if (row) {
      row.points.push(point);
      row.centerY = row.points.reduce((sum, p) => sum + p.y, 0) / row.points.length;
    } else {
      rows.push({ centerY: point.y, points: [point] });
    }
  }

  rows.sort((a, b) => a.centerY - b.centerY);

  if (rows.length <= 1) {
    const row = rows[0];
    const rowXs = row.points.map((point) => point.x);
    return [
      { x: Math.min(...rowXs) - padding, y: row.centerY - padding },
      { x: Math.max(...rowXs) + padding, y: row.centerY - padding },
      { x: Math.max(...rowXs) + padding, y: row.centerY + padding },
      { x: Math.min(...rowXs) - padding, y: row.centerY + padding }
    ];
  }

  const bands = rows.map((row, index) => {
    const rowXs = row.points.map((point) => point.x);
    const prev = rows[index - 1];
    const next = rows[index + 1];
    const top = prev ? (prev.centerY + row.centerY) / 2 : row.centerY - padding;
    const bottom = next ? (row.centerY + next.centerY) / 2 : row.centerY + padding;
    return {
      top,
      bottom,
      left: Math.min(...rowXs) - padding,
      right: Math.max(...rowXs) + padding
    };
  });

  const leftSide: ScreenPoint[] = [{ x: bands[0].left, y: bands[0].top }];
  for (let i = 0; i < bands.length; i += 1) {
    const current = bands[i];
    leftSide.push({ x: current.left, y: current.bottom });
    const next = bands[i + 1];
    if (next) leftSide.push({ x: next.left, y: current.bottom });
  }

  const last = bands[bands.length - 1];
  const rightSide: ScreenPoint[] = [{ x: last.right, y: last.bottom }];
  for (let i = bands.length - 1; i >= 0; i -= 1) {
    const current = bands[i];
    rightSide.push({ x: current.right, y: current.top });
    const prev = bands[i - 1];
    if (prev) rightSide.push({ x: prev.right, y: current.top });
  }

  const polygon = [...leftSide, ...rightSide];
  const simplified: ScreenPoint[] = [];
  for (const point of polygon) {
    const prev = simplified[simplified.length - 1];
    if (prev && Math.abs(prev.x - point.x) < 0.001 && Math.abs(prev.y - point.y) < 0.001) continue;
    simplified.push(point);
    while (simplified.length >= 3) {
      const a = simplified[simplified.length - 3];
      const b = simplified[simplified.length - 2];
      const c = simplified[simplified.length - 1];
      const sameX = Math.abs(a.x - b.x) < 0.001 && Math.abs(b.x - c.x) < 0.001;
      const sameY = Math.abs(a.y - b.y) < 0.001 && Math.abs(b.y - c.y) < 0.001;
      if (!sameX && !sameY) break;
      simplified.splice(simplified.length - 2, 1);
    }
  }

  return simplified.length >= 3 ? simplified : [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY }
  ];
}


function median(values: number[]) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return 0;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function simplifyOrthogonalScreenOutline(points: ScreenPoint[], tolerance = 0.5) {
  const cleaned: ScreenPoint[] = [];
  for (const point of points) {
    if (!isFinitePoint(point)) continue;
    const prev = cleaned[cleaned.length - 1];
    if (prev && Math.abs(prev.x - point.x) <= tolerance && Math.abs(prev.y - point.y) <= tolerance) continue;
    cleaned.push(point);
    while (cleaned.length >= 3) {
      const a = cleaned[cleaned.length - 3];
      const b = cleaned[cleaned.length - 2];
      const c = cleaned[cleaned.length - 1];
      const sameX = Math.abs(a.x - b.x) <= tolerance && Math.abs(b.x - c.x) <= tolerance;
      const sameY = Math.abs(a.y - b.y) <= tolerance && Math.abs(b.y - c.y) <= tolerance;
      if (!sameX && !sameY) break;
      cleaned.splice(cleaned.length - 2, 1);
    }
  }
  if (cleaned.length >= 3) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.abs(first.x - last.x) <= tolerance && Math.abs(first.y - last.y) <= tolerance) cleaned.pop();
  }
  return cleaned;
}

function makeGroupOutlineScreenCorridor(points: ScreenPoint[], paddingPx: number, snapPx: number) {
  const finitePoints = points.filter(isFinitePoint);
  if (finitePoints.length === 0) return [] as ScreenPoint[];

  const xs = finitePoints.map((point) => point.x);
  const ys = finitePoints.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = Math.max(7, Math.min(48, Number.isFinite(paddingPx) ? paddingPx : 22));

  if (finitePoints.length <= 2) {
    return [
      { x: minX - pad, y: minY - pad },
      { x: maxX + pad, y: minY - pad },
      { x: maxX + pad, y: maxY + pad },
      { x: minX - pad, y: maxY + pad }
    ];
  }

  const nearestDistances = finitePoints.map((point, index) => {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < finitePoints.length; i += 1) {
      if (i === index) continue;
      const other = finitePoints[i];
      best = Math.min(best, Math.hypot(point.x - other.x, point.y - other.y));
    }
    return best;
  }).filter((value) => Number.isFinite(value) && value > 0);

  const typical = Math.max(1, median(nearestDistances) || pad * 2);
  const clusterTolerance = Math.max(7, Math.min(52, Math.max(pad * 0.85, typical * 0.42)));
  const bandHalf = Math.max(7, Math.min(44, pad * 0.86));
  const pointHalf = Math.max(6, Math.min(38, pad * 0.72));
  const runGap = Math.max(
    pad * 5.6,
    typical * 2.9,
    Number.isFinite(snapPx) ? Math.min(Math.max(snapPx, 34), 220) : 54
  );

  type Rect = { left: number; right: number; top: number; bottom: number };
  type ClusterItem = { point: ScreenPoint; index: number };
  const rects: Rect[] = [];
  const connectorRects: Rect[] = []; // contract anchor: мосты между CAD-полосами, не между каждой сваей.
  const covered = new Set<number>();

  const normalizeRect = (rect: Rect): Rect => ({
    left: Math.min(rect.left, rect.right),
    right: Math.max(rect.left, rect.right),
    bottom: Math.min(rect.bottom, rect.top),
    top: Math.max(rect.bottom, rect.top)
  });
  const addRect = (rect: Rect) => {
    const clean = normalizeRect(rect);
    if (clean.right - clean.left < 1 || clean.top - clean.bottom < 1) return;
    rects.push(clean);
  };

  const makeClusters = (axis: 'x' | 'y') => {
    const sorted = finitePoints
      .map((point, index) => ({ point, index }))
      .sort((a, b) => (axis === 'x' ? a.point.x - b.point.x : a.point.y - b.point.y));
    const clusters: Array<{ center: number; items: ClusterItem[] }> = [];
    for (const item of sorted) {
      const value = axis === 'x' ? item.point.x : item.point.y;
      const cluster = clusters.find((candidate) => Math.abs(candidate.center - value) <= clusterTolerance);
      if (cluster) {
        cluster.items.push(item);
        cluster.center = cluster.items.reduce((sum, current) => sum + (axis === 'x' ? current.point.x : current.point.y), 0) / cluster.items.length;
      } else {
        clusters.push({ center: value, items: [item] });
      }
    }
    return clusters;
  };

  const splitRuns = (items: ClusterItem[], axis: 'x' | 'y') => {
    const sorted = [...items].sort((a, b) => (axis === 'x' ? a.point.x - b.point.x : a.point.y - b.point.y));
    const runs: ClusterItem[][] = [];
    let current: ClusterItem[] = [];
    for (const item of sorted) {
      const prev = current[current.length - 1];
      const gap = prev ? Math.abs((axis === 'x' ? item.point.x - prev.point.x : item.point.y - prev.point.y)) : 0;
      if (prev && gap > runGap) {
        runs.push(current);
        current = [];
      }
      current.push(item);
    }
    if (current.length) runs.push(current);
    return runs;
  };

  for (const row of makeClusters('y')) {
    for (const run of splitRuns(row.items, 'x')) {
      if (run.length < 2) continue;
      const runXs = run.map((item) => item.point.x);
      const centerY = run.reduce((sum, item) => sum + item.point.y, 0) / run.length;
      addRect({
        left: Math.min(...runXs) - pad,
        right: Math.max(...runXs) + pad,
        bottom: centerY - bandHalf,
        top: centerY + bandHalf
      });
      run.forEach((item) => covered.add(item.index));
    }
  }

  for (const column of makeClusters('x')) {
    for (const run of splitRuns(column.items, 'y')) {
      if (run.length < 2) continue;
      const runYs = run.map((item) => item.point.y);
      const centerX = run.reduce((sum, item) => sum + item.point.x, 0) / run.length;
      addRect({
        left: centerX - bandHalf,
        right: centerX + bandHalf,
        bottom: Math.min(...runYs) - pad,
        top: Math.max(...runYs) + pad
      });
      run.forEach((item) => covered.add(item.index));
    }
  }

  finitePoints.forEach((point, index) => {
    if (covered.has(index)) return;
    addRect({
      left: point.x - pointHalf,
      right: point.x + pointHalf,
      bottom: point.y - pointHalf,
      top: point.y + pointHalf
    });
  });

  const centers = () => rects.map((rect, index) => ({
    index,
    x: (rect.left + rect.right) / 2,
    y: (rect.bottom + rect.top) / 2,
    rect
  }));
  const rectGap = (a: Rect, b: Rect) => {
    const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
    const dy = Math.max(0, Math.max(a.bottom - b.top, b.bottom - a.top));
    return Math.hypot(dx, dy);
  };
  const intersectsOrTouches = (a: Rect, b: Rect, expand = 0) => !(
    a.right + expand < b.left || b.right + expand < a.left || a.top + expand < b.bottom || b.top + expand < a.bottom
  );

  const buildComponents = () => {
    const parent = rects.map((_, index) => index);
    const find = (value: number): number => parent[value] === value ? value : (parent[value] = find(parent[value]));
    const unite = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        if (intersectsOrTouches(rects[i], rects[j], 1.5)) unite(i, j);
      }
    }
    const groups = new Map<number, number[]>();
    rects.forEach((_, index) => {
      const root = find(index);
      groups.set(root, [...(groups.get(root) ?? []), index]);
    });
    return Array.from(groups.values());
  };

  let guard = 0;
  while (rects.length > 1 && guard < Math.min(160, Math.max(48, rects.length * 2))) {
    guard += 1;
    const components = buildComponents();
    if (components.length <= 1) break;
    let best: { a: number; b: number; gap: number } | null = null;
    for (let ci = 0; ci < components.length; ci += 1) {
      for (let cj = ci + 1; cj < components.length; cj += 1) {
        for (const a of components[ci]) {
          for (const b of components[cj]) {
            const gap = rectGap(rects[a], rects[b]);
            if (!best || gap < best.gap) best = { a, b, gap };
          }
        }
      }
    }
    if (!best) break;
    const a = centers()[best.a];
    const b = centers()[best.b];
    const half = Math.max(5, bandHalf * 0.74);
    const horizontalFirst = Math.abs(a.x - b.x) >= Math.abs(a.y - b.y);
    if (horizontalFirst) {
      const turn = { x: b.x, y: a.y };
      connectorRects.push(normalizeRect({ left: Math.min(a.x, turn.x) - half, right: Math.max(a.x, turn.x) + half, bottom: a.y - half, top: a.y + half }));
      connectorRects.push(normalizeRect({ left: b.x - half, right: b.x + half, bottom: Math.min(turn.y, b.y) - half, top: Math.max(turn.y, b.y) + half }));
    } else {
      const turn = { x: a.x, y: b.y };
      connectorRects.push(normalizeRect({ left: a.x - half, right: a.x + half, bottom: Math.min(a.y, turn.y) - half, top: Math.max(a.y, turn.y) + half }));
      connectorRects.push(normalizeRect({ left: Math.min(turn.x, b.x) - half, right: Math.max(turn.x, b.x) + half, bottom: b.y - half, top: b.y + half }));
    }
    rects.push(...connectorRects.splice(0));
  }

  const outline = orthogonalUnionOutlineWorld(rects).map((point) => ({ x: point.x, y: point.y }));
  const simplified = simplifyOrthogonalScreenOutline(outline, 0.5);
  if (simplified.length >= 3) return simplified;

  return [
    { x: minX - pad, y: minY - pad },
    { x: maxX + pad, y: minY - pad },
    { x: maxX + pad, y: maxY + pad },
    { x: minX - pad, y: maxY + pad }
  ];
}

function makeGroupOutlineWorldRows(points: WorldPoint[], paddingWorld: number, rowToleranceWorld: number, snapToleranceWorld: number) {
  if (points.length === 0) return [] as WorldPoint[];
  const finitePoints = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (finitePoints.length === 0) return [];

  const xs = finitePoints.map((point) => point.x);
  const ys = finitePoints.map((point) => point.y);
  const minX = Math.min(...xs) - paddingWorld;
  const maxX = Math.max(...xs) + paddingWorld;
  const minY = Math.min(...ys) - paddingWorld;
  const maxY = Math.max(...ys) + paddingWorld;

  if (finitePoints.length <= 2) {
    return [
      { x: minX, y: maxY },
      { x: maxX, y: maxY },
      { x: maxX, y: minY },
      { x: minX, y: minY }
    ];
  }

  const sorted = [...finitePoints].sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const safeTolerance = Math.max(1e-9, Number.isFinite(rowToleranceWorld) ? rowToleranceWorld : 250);
  const rows: Array<{ centerY: number; points: WorldPoint[] }> = [];

  for (const point of sorted) {
    const row = rows.find((item) => Math.abs(item.centerY - point.y) <= safeTolerance);
    if (row) {
      row.points.push(point);
      row.centerY = row.points.reduce((sum, p) => sum + p.y, 0) / row.points.length;
    } else {
      rows.push({ centerY: point.y, points: [point] });
    }
  }

  rows.sort((a, b) => b.centerY - a.centerY);

  if (rows.length <= 1) {
    const row = rows[0];
    const rowXs = row.points.map((point) => point.x);
    return [
      { x: Math.min(...rowXs) - paddingWorld, y: row.centerY + paddingWorld },
      { x: Math.max(...rowXs) + paddingWorld, y: row.centerY + paddingWorld },
      { x: Math.max(...rowXs) + paddingWorld, y: row.centerY - paddingWorld },
      { x: Math.min(...rowXs) - paddingWorld, y: row.centerY - paddingWorld }
    ];
  }

  const rawBands = rows.map((row, index) => {
    const rowXs = row.points.map((point) => point.x);
    const prev = rows[index - 1];
    const next = rows[index + 1];
    const top = prev ? (prev.centerY + row.centerY) / 2 : row.centerY + paddingWorld;
    const bottom = next ? (row.centerY + next.centerY) / 2 : row.centerY - paddingWorld;
    return {
      top,
      bottom,
      left: Math.min(...rowXs) - paddingWorld,
      right: Math.max(...rowXs) + paddingWorld
    };
  });

  // Убираем мелкие зубцы контура: одиночные выбросы и небольшие отличия
  // границ между соседними рядами дают визуальный шум, особенно на больших полях.
  // Большие уступы при этом сохраняются, поэтому форма остаётся многоугольной,
  // но выглядит как аккуратный прямоугольный CAD-контур.
  const notchTolerance = Math.max(
    safeTolerance * 1.2,
    paddingWorld * 1.15,
    Number.isFinite(snapToleranceWorld) ? snapToleranceWorld : 0
  );

  const snapSide = (values: number[], side: 'left' | 'right') => {
    const clusters: Array<{ min: number; max: number; values: number[] }> = [];
    for (const value of values) {
      const cluster = clusters.find((item) => value >= item.min - notchTolerance && value <= item.max + notchTolerance);
      if (cluster) {
        cluster.values.push(value);
        cluster.min = Math.min(cluster.min, value);
        cluster.max = Math.max(cluster.max, value);
      } else {
        clusters.push({ min: value, max: value, values: [value] });
      }
    }
    const levelFor = (value: number) => {
      const cluster = clusters.find((item) => value >= item.min - notchTolerance && value <= item.max + notchTolerance);
      if (!cluster) return value;
      // Для левой границы безопаснее брать самую левую линию кластера,
      // для правой — самую правую. Контур получается более прямоугольным
      // и не врезается внутрь группы.
      return side === 'left' ? Math.min(...cluster.values) : Math.max(...cluster.values);
    };
    return values.map((value, index, source) => {
      const prev = source[index - 1];
      const next = source[index + 1];
      if (typeof prev === 'number' && typeof next === 'number' && Math.abs(prev - next) <= notchTolerance && Math.abs(value - prev) <= notchTolerance * 1.75) {
        return levelFor((prev + next) / 2);
      }
      return levelFor(value);
    });
  };

  const smoothedLeft = snapSide(rawBands.map((band) => band.left), 'left');
  const smoothedRight = snapSide(rawBands.map((band) => band.right), 'right');
  const bands = rawBands.map((band, index) => ({
    ...band,
    left: smoothedLeft[index],
    right: smoothedRight[index]
  }));

  const leftSide: WorldPoint[] = [{ x: bands[0].left, y: bands[0].top }];
  for (let i = 0; i < bands.length; i += 1) {
    const current = bands[i];
    leftSide.push({ x: current.left, y: current.bottom });
    const next = bands[i + 1];
    if (next) leftSide.push({ x: next.left, y: current.bottom });
  }

  const last = bands[bands.length - 1];
  const rightSide: WorldPoint[] = [{ x: last.right, y: last.bottom }];
  for (let i = bands.length - 1; i >= 0; i -= 1) {
    const current = bands[i];
    rightSide.push({ x: current.right, y: current.top });
    const prev = bands[i - 1];
    if (prev) rightSide.push({ x: prev.right, y: current.top });
  }

  // v49: один автоматический контур должен включать все точки группы.
  // Если соседние ряды/полосы не пересекаются по X, чистая union-геометрия
  // распадается на несколько контуров и раньше выбирала только самый большой
  // кусок. Добавляем узкие ортогональные перемычки между соседними полосами:
  // так контур остаётся CAD-прямоугольным, но не теряет нижнюю/верхнюю ветку
  // L/U-образного свайного поля.
  const connectorRects: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  const connectorHalfHeight = Math.max(1, Math.min(Math.abs(paddingWorld), safeTolerance * 0.18, Math.max(1, paddingWorld * 0.85)));
  for (let i = 0; i < bands.length - 1; i += 1) {
    const current = bands[i];
    const next = bands[i + 1];
    const sharedY = (current.bottom + next.top) / 2;
    const overlapLeft = Math.max(current.left, next.left);
    const overlapRight = Math.min(current.right, next.right);

    if (overlapRight > overlapLeft) {
      connectorRects.push({
        left: overlapLeft,
        right: overlapRight,
        top: sharedY + connectorHalfHeight,
        bottom: sharedY - connectorHalfHeight
      });
      continue;
    }

    const currentIsLeft = current.right < next.left;
    const left = currentIsLeft ? current.right : next.right;
    const right = currentIsLeft ? next.left : current.left;
    connectorRects.push({
      left: Math.min(left, right) - Math.max(1, paddingWorld * 0.15),
      right: Math.max(left, right) + Math.max(1, paddingWorld * 0.15),
      top: sharedY + connectorHalfHeight,
      bottom: sharedY - connectorHalfHeight
    });
  }

  const unionOutline = orthogonalUnionOutlineWorld([...bands, ...connectorRects]);
  const polygon = unionOutline.length >= 4 ? unionOutline : [...leftSide, ...rightSide];
  const simplified: WorldPoint[] = [];
  for (const point of polygon) {
    const prev = simplified[simplified.length - 1];
    if (prev && Math.abs(prev.x - point.x) < 1e-9 && Math.abs(prev.y - point.y) < 1e-9) continue;
    simplified.push(point);
    while (simplified.length >= 3) {
      const a = simplified[simplified.length - 3];
      const b = simplified[simplified.length - 2];
      const c = simplified[simplified.length - 1];
      const sameX = Math.abs(a.x - b.x) < 1e-9 && Math.abs(b.x - c.x) < 1e-9;
      const sameY = Math.abs(a.y - b.y) < 1e-9 && Math.abs(b.y - c.y) < 1e-9;
      if (!sameX && !sameY) break;
      simplified.splice(simplified.length - 2, 1);
    }
  }

  return simplified.length >= 3 ? simplified : [
    { x: minX, y: maxY },
    { x: maxX, y: maxY },
    { x: maxX, y: minY },
    { x: minX, y: minY }
  ];
}

interface OutlineRectWorld {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

interface AxisClusterWorld {
  center: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  count: number;
  width: number;
  height: number;
  points: WorldPoint[];
}

function medianNumber(values: number[]) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return 0;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function estimateNearestSpacingWorld(points: WorldPoint[]) {
  const finitePoints = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (finitePoints.length <= 1) return 1000;

  const best = finitePoints.map(() => Number.POSITIVE_INFINITY);
  const updateBest = (sorted: Array<{ point: WorldPoint; index: number }>) => {
    const window = 10;
    for (let i = 0; i < sorted.length; i += 1) {
      const current = sorted[i];
      for (let j = Math.max(0, i - window); j <= Math.min(sorted.length - 1, i + window); j += 1) {
        if (i === j) continue;
        const other = sorted[j];
        const dx = current.point.x - other.point.x;
        const dy = current.point.y - other.point.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 1e-6 && dist < best[current.index]) best[current.index] = dist;
      }
    }
  };

  updateBest(finitePoints.map((point, index) => ({ point, index })).sort((a, b) => a.point.x - b.point.x || a.point.y - b.point.y));
  updateBest(finitePoints.map((point, index) => ({ point, index })).sort((a, b) => a.point.y - b.point.y || a.point.x - b.point.x));

  const nearest = best.filter((value) => Number.isFinite(value) && value > 1e-6);
  const xs = finitePoints.map((point) => point.x);
  const ys = finitePoints.map((point) => point.y);
  const spanFallback = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / Math.max(3, Math.sqrt(finitePoints.length));
  const medianNearest = medianNumber(nearest);
  return Math.max(100, medianNearest || spanFallback || 1000);
}

function clusterWorldPointsByAxis(points: WorldPoint[], axis: 'x' | 'y', tolerance: number) {
  const sorted = [...points].filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)).sort((a, b) => (a[axis] - b[axis]) || (axis === 'x' ? a.y - b.y : a.x - b.x));
  const clusters: AxisClusterWorld[] = [];

  const pushCluster = (items: WorldPoint[]) => {
    if (items.length === 0) return;
    const xs = items.map((point) => point.x);
    const ys = items.map((point) => point.y);
    clusters.push({
      center: items.reduce((sum, point) => sum + point[axis], 0) / items.length,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      count: items.length,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      points: items
    });
  };

  let current: WorldPoint[] = [];
  let center = 0;
  for (const point of sorted) {
    const value = point[axis];
    if (current.length === 0) {
      current = [point];
      center = value;
      continue;
    }
    if (Math.abs(value - center) <= tolerance) {
      current.push(point);
      center = current.reduce((sum, item) => sum + item[axis], 0) / current.length;
    } else {
      pushCluster(current);
      current = [point];
      center = value;
    }
  }
  pushCluster(current);
  return clusters;
}

function normalizeOutlineRectWorld(rect: OutlineRectWorld): OutlineRectWorld {
  return {
    left: Math.min(rect.left, rect.right),
    right: Math.max(rect.left, rect.right),
    bottom: Math.min(rect.bottom, rect.top),
    top: Math.max(rect.bottom, rect.top)
  };
}

function outlineRectArea(rect: OutlineRectWorld) {
  return Math.max(0, rect.right - rect.left) * Math.max(0, rect.top - rect.bottom);
}

function outlineRectCenter(rect: OutlineRectWorld): WorldPoint {
  return { x: (rect.left + rect.right) / 2, y: (rect.bottom + rect.top) / 2 };
}

function outlineRectContainsPoint(rect: OutlineRectWorld, point: WorldPoint, tolerance = 1e-6) {
  return point.x >= rect.left - tolerance && point.x <= rect.right + tolerance && point.y >= rect.bottom - tolerance && point.y <= rect.top + tolerance;
}

function outlineRectsTouch(a: OutlineRectWorld, b: OutlineRectWorld, tolerance: number) {
  return !(a.right < b.left - tolerance || b.right < a.left - tolerance || a.top < b.bottom - tolerance || b.top < a.bottom - tolerance);
}

function outlineRectDistance(a: OutlineRectWorld, b: OutlineRectWorld) {
  const dx = Math.max(a.left - b.right, b.left - a.right, 0);
  const dy = Math.max(a.bottom - b.top, b.bottom - a.top, 0);
  return Math.hypot(dx, dy);
}

function makeBridgeRectsBetween(a: OutlineRectWorld, b: OutlineRectWorld, halfWidth: number) {
  const ac = outlineRectCenter(a);
  const bc = outlineRectCenter(b);
  const half = Math.max(1, halfWidth);
  const horizontalFirst = Math.abs(bc.x - ac.x) >= Math.abs(bc.y - ac.y);

  if (horizontalFirst) {
    const turn = { x: bc.x, y: ac.y };
    return [
      normalizeOutlineRectWorld({ left: Math.min(ac.x, turn.x) - half, right: Math.max(ac.x, turn.x) + half, bottom: ac.y - half, top: ac.y + half }),
      normalizeOutlineRectWorld({ left: bc.x - half, right: bc.x + half, bottom: Math.min(turn.y, bc.y) - half, top: Math.max(turn.y, bc.y) + half })
    ];
  }

  const turn = { x: ac.x, y: bc.y };
  return [
    normalizeOutlineRectWorld({ left: ac.x - half, right: ac.x + half, bottom: Math.min(ac.y, turn.y) - half, top: Math.max(ac.y, turn.y) + half }),
    normalizeOutlineRectWorld({ left: Math.min(turn.x, bc.x) - half, right: Math.max(turn.x, bc.x) + half, bottom: bc.y - half, top: bc.y + half })
  ];
}

function connectOutlineRects(rects: OutlineRectWorld[], bridgeHalfWidth: number) {
  const clean = rects.map(normalizeOutlineRectWorld).filter((rect) => rect.right > rect.left && rect.top > rect.bottom);
  if (clean.length <= 1) return clean;

  const sorted = [...clean].sort((a, b) => outlineRectArea(b) - outlineRectArea(a));
  const connected: OutlineRectWorld[] = [sorted[0]];
  const connectors: OutlineRectWorld[] = [];

  for (const rect of sorted.slice(1)) {
    if (connected.some((item) => outlineRectsTouch(item, rect, bridgeHalfWidth * 0.15))) {
      connected.push(rect);
      continue;
    }

    let nearest = connected[0];
    let nearestDistance = outlineRectDistance(rect, nearest);
    for (const candidate of connected.slice(1)) {
      const distance = outlineRectDistance(rect, candidate);
      if (distance < nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
      }
    }
    connectors.push(...makeBridgeRectsBetween(nearest, rect, bridgeHalfWidth));
    connected.push(rect);
  }

  return [...clean, ...connectors];
}

function simplifyOrthogonalWorldOutline(points: WorldPoint[], tolerance = 1e-6) {
  const cleaned: WorldPoint[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const prev = cleaned[cleaned.length - 1];
    if (prev && Math.abs(prev.x - point.x) <= tolerance && Math.abs(prev.y - point.y) <= tolerance) continue;
    cleaned.push(point);
    while (cleaned.length >= 3) {
      const a = cleaned[cleaned.length - 3];
      const b = cleaned[cleaned.length - 2];
      const c = cleaned[cleaned.length - 1];
      const sameX = Math.abs(a.x - b.x) <= tolerance && Math.abs(b.x - c.x) <= tolerance;
      const sameY = Math.abs(a.y - b.y) <= tolerance && Math.abs(b.y - c.y) <= tolerance;
      if (!sameX && !sameY) break;
      cleaned.splice(cleaned.length - 2, 1);
    }
  }
  if (cleaned.length >= 3) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.abs(first.x - last.x) <= tolerance && Math.abs(first.y - last.y) <= tolerance) cleaned.pop();
  }
  return cleaned;
}

function makeGroupOutlineWorldCadBands(points: WorldPoint[], paddingSetting: number) {
  const finitePoints = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (finitePoints.length === 0) return [] as WorldPoint[];

  const xs = finitePoints.map((point) => point.x);
  const ys = finitePoints.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const spacing = estimateNearestSpacingWorld(finitePoints);
  const settingScale = Math.sqrt(Math.max(0.45, Math.min(2.5, (Number.isFinite(paddingSetting) ? paddingSetting : 28) / 28)));
  const paddingWorld = Math.max(600, Math.min(Math.max(spanX, spanY) * 0.18, spacing * 2.05 * settingScale));

  if (finitePoints.length <= 2 || spanX <= spacing * 1.2 || spanY <= spacing * 1.2) {
    return [
      { x: minX - paddingWorld, y: maxY + paddingWorld },
      { x: maxX + paddingWorld, y: maxY + paddingWorld },
      { x: maxX + paddingWorld, y: minY - paddingWorld },
      { x: minX - paddingWorld, y: minY - paddingWorld }
    ];
  }

  const axisTolerance = Math.max(250, spacing * 0.32);
  const rowClusters = clusterWorldPointsByAxis(finitePoints, 'y', axisTolerance).sort((a, b) => a.center - b.center);
  const colClusters = clusterWorldPointsByAxis(finitePoints, 'x', axisTolerance).sort((a, b) => a.center - b.center);
  const minHorizontalSpan = Math.max(spacing * 4.5, spanX * 0.14);
  const minVerticalSpan = Math.max(spacing * 5, spanY * 0.18);
  const minCount = Math.max(4, Math.ceil(finitePoints.length * 0.035));

  const horizontalRows = rowClusters.filter((row) => row.width >= minHorizontalSpan || row.count >= minCount + 2);
  const verticalCols = colClusters.filter((col) => col.height >= minVerticalSpan || col.count >= minCount + 2);

  const rects: OutlineRectWorld[] = [];
  const mergeGapY = spacing * 4.4;
  const horizontalBands: AxisClusterWorld[][] = [];
  for (const row of horizontalRows) {
    const current = horizontalBands[horizontalBands.length - 1];
    if (!current || row.center - current[current.length - 1].center > mergeGapY) horizontalBands.push([row]);
    else current.push(row);
  }

  for (const band of horizontalBands) {
    rects.push(normalizeOutlineRectWorld({
      left: Math.min(...band.map((row) => row.minX)) - paddingWorld,
      right: Math.max(...band.map((row) => row.maxX)) + paddingWorld,
      bottom: Math.min(...band.map((row) => row.center)) - paddingWorld,
      top: Math.max(...band.map((row) => row.center)) + paddingWorld
    }));
  }

  const mergeGapX = spacing * 3.0;
  const verticalBands: AxisClusterWorld[][] = [];
  for (const col of verticalCols) {
    const current = verticalBands[verticalBands.length - 1];
    if (!current || col.center - current[current.length - 1].center > mergeGapX) verticalBands.push([col]);
    else current.push(col);
  }

  for (const band of verticalBands) {
    rects.push(normalizeOutlineRectWorld({
      left: Math.min(...band.map((col) => col.center)) - paddingWorld,
      right: Math.max(...band.map((col) => col.center)) + paddingWorld,
      bottom: Math.min(...band.map((col) => col.minY)) - paddingWorld,
      top: Math.max(...band.map((col) => col.maxY)) + paddingWorld
    }));
  }

  if (rects.length === 0) {
    return [
      { x: minX - paddingWorld, y: maxY + paddingWorld },
      { x: maxX + paddingWorld, y: maxY + paddingWorld },
      { x: maxX + paddingWorld, y: minY - paddingWorld },
      { x: minX - paddingWorld, y: minY - paddingWorld }
    ];
  }

  for (const point of finitePoints) {
    if (rects.some((rect) => outlineRectContainsPoint(rect, point))) continue;

    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < rects.length; i += 1) {
      const rect = rects[i];
      const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
      const dy = Math.max(rect.bottom - point.y, 0, point.y - rect.top);
      const distance = Math.hypot(dx, dy);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    if (bestDistance <= spacing * 5.5) {
      const rect = rects[bestIndex];
      rect.left = Math.min(rect.left, point.x - paddingWorld);
      rect.right = Math.max(rect.right, point.x + paddingWorld);
      rect.bottom = Math.min(rect.bottom, point.y - paddingWorld);
      rect.top = Math.max(rect.top, point.y + paddingWorld);
    } else {
      rects.push(normalizeOutlineRectWorld({
        left: point.x - paddingWorld,
        right: point.x + paddingWorld,
        bottom: point.y - paddingWorld,
        top: point.y + paddingWorld
      }));
    }
  }

  const connectedRects = connectOutlineRects(rects, Math.max(1, paddingWorld * 0.42));
  const unionOutline = orthogonalUnionOutlineWorld(connectedRects);
  const outline = simplifyOrthogonalWorldOutline(unionOutline, Math.max(1e-6, spacing * 0.001));

  return outline.length >= 3 ? outline : [
    { x: minX - paddingWorld, y: maxY + paddingWorld },
    { x: maxX + paddingWorld, y: maxY + paddingWorld },
    { x: maxX + paddingWorld, y: minY - paddingWorld },
    { x: minX - paddingWorld, y: minY - paddingWorld }
  ];
}


function simplifyScreenOutline(points: ScreenPoint[], minSegmentPx: number) {
  if (points.length < 4) return points;
  const threshold = Math.max(2, Number.isFinite(minSegmentPx) ? minSegmentPx : 0);
  let result = points.filter(isFinitePoint);

  const isShort = (a: ScreenPoint, b: ScreenPoint) => Math.hypot(a.x - b.x, a.y - b.y) < threshold;

  for (let pass = 0; pass < 4 && result.length > 4; pass += 1) {
    const next: ScreenPoint[] = [];
    for (let i = 0; i < result.length; i += 1) {
      const prev = result[(i - 1 + result.length) % result.length];
      const current = result[i];
      const following = result[(i + 1) % result.length];
      if (isShort(prev, current) && isShort(current, following)) continue;
      next.push(current);
    }
    if (next.length === result.length) break;
    result = next;
  }

  const collapsed: ScreenPoint[] = [];
  for (const point of result) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && Math.abs(prev.x - point.x) < 0.001 && Math.abs(prev.y - point.y) < 0.001) continue;
    collapsed.push(point);
    while (collapsed.length >= 3) {
      const a = collapsed[collapsed.length - 3];
      const b = collapsed[collapsed.length - 2];
      const c = collapsed[collapsed.length - 1];
      const sameX = Math.abs(a.x - b.x) < 0.001 && Math.abs(b.x - c.x) < 0.001;
      const sameY = Math.abs(a.y - b.y) < 0.001 && Math.abs(b.y - c.y) < 0.001;
      if (!sameX && !sameY) break;
      collapsed.splice(collapsed.length - 2, 1);
    }
  }
  return collapsed.length >= 3 ? collapsed : points;
}

function flattenPoints(points: ScreenPoint[]) {
  return points.flatMap((point) => [point.x, point.y]);
}

function isFinitePoint(point: ScreenPoint | null | undefined): point is ScreenPoint {
  if (!point) return false;
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function buildArrowHead(start: ScreenPoint, end: ScreenPoint, size = 9) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 10) return null;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  return [
    end.x - ux * size + px * (size * 0.52),
    end.y - uy * size + py * (size * 0.52),
    end.x,
    end.y,
    end.x - ux * size - px * (size * 0.52),
    end.y - uy * size - py * (size * 0.52)
  ];
}


function readMetaOffset(meta: Record<string, unknown> | undefined, key: string): ScreenPoint {
  const raw = meta?.[key];
  if (!raw || typeof raw !== 'object') return { x: 0, y: 0 };
  const value = raw as { x?: unknown; y?: unknown };
  const x = typeof value.x === 'number' && Number.isFinite(value.x) ? value.x : 0;
  const y = typeof value.y === 'number' && Number.isFinite(value.y) ? value.y : 0;
  return { x, y };
}

function readWorldPointList(value: unknown): WorldPoint[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as { x?: unknown; y?: unknown };
      const x = Number(raw.x);
      const y = Number(raw.y);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    })
    .filter((point): point is WorldPoint => Boolean(point));
}

function compactCanvasWorldPath(points: WorldPoint[], minDistance = 1): WorldPoint[] {
  const clean = readWorldPointList(points);
  if (clean.length <= 2) return clean.map((point) => ({ x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 }));
  const result: WorldPoint[] = [];
  for (const point of clean) {
    const next = { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 };
    const prev = result[result.length - 1];
    if (!prev || Math.hypot(prev.x - next.x, prev.y - next.y) >= minDistance) result.push(next);
  }
  const last = clean[clean.length - 1];
  const currentLast = result[result.length - 1];
  if (last && (!currentLast || Math.hypot(last.x - currentLast.x, last.y - currentLast.y) > 1e-6)) {
    result.push({ x: Math.round(last.x * 100) / 100, y: Math.round(last.y * 100) / 100 });
  }
  return result;
}

function makeOrthogonalDraftPoint(previous: WorldPoint | undefined, current: WorldPoint): WorldPoint {
  if (!previous) return current;
  const dx = current.x - previous.x;
  const dy = current.y - previous.y;
  // Shift в ручном контуре работает как ortho-режим CAD: следующий сегмент
  // принудительно горизонтальный или вертикальный по большей проекции курсора.
  return Math.abs(dx) >= Math.abs(dy)
    ? { x: current.x, y: previous.y }
    : { x: previous.x, y: current.y };
}

function manualLinkKey(fromId: string, toId: string) {
  return `${fromId}->${toId}`;
}


export function CanvasView({ width, height, onPointerUpdate }: Props) {
  const stageRef = useRef<any>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const {
    project,
    selectedPointIds,
    selectedGroupId,
    autoAssignSelection,
    pointInfoVisible,
    editPointPickMode,
    numberingPickMode,
    numberingPreview,
    numberingLinkFromId,
    numberingLinkToId,
    manualLinkClearMode,
    manualLinkClearSelection,
    groupOutlineDrawMode,
    groupOutlineDraft,
    vectorPathDrawMode,
    vectorPathEditMode,
    vectorPathDraft,
    copyBasePointId,
    propertySourcePointId,
    setSelection,
    togglePointSelection,
    setSelectedGroup,
    assignPointIdsToGroup,
    handleCanvasEditPoint,
    copyGroupPropertyToTargets,
    handleNumberingPickPoint,
    startNumberingManualLinkEdit,
    toggleManualLinkClearSelection,
    setManualLinkClearSelection,
    addGroupOutlineDraftPoint,
    closeGroupOutlineDrawing,
    cancelGroupOutlineDrawing,
    addVectorPathDraftPoint,
    undoLastVectorPathDraftPoint,
    finishVectorPathDrawing,
    cancelVectorPathDrawing,
    startVectorPathEdit,
    cancelVectorPathEdit,
    updateVectorPathPoint,
    insertVectorPathPoint,
    deleteVectorPathPoint,
    updateGroupMeta,
    updateGroupNumbering,
    updatePointNumberLabelOffset,
    setPointManualNumber,
    clearPointManualNumber,
    pushHistory,
    recordOperation,
    settingsHoverTarget,
    updateView
  } = useProjectStore();

  const [selectionRect, setSelectionRect] = useState<SelectionRectState | null>(null);
  const [selectionStart, setSelectionStart] = useState<ScreenPoint | null>(null);
  const [panStart, setPanStart] = useState<{ pointer: ScreenPoint; panX: number; panY: number } | null>(null);
  const [previewStep, setPreviewStep] = useState(0);
  const [manualLinkDraft, setManualLinkDraft] = useState<{ screen: ScreenPoint; targetId: string | null; allowed: boolean } | null>(null);
  const [groupOutlineHoverPoint, setGroupOutlineHoverPoint] = useState<GroupOutlineHoverPoint | null>(null);
  const [vectorHoverPoint, setVectorHoverPoint] = useState<VectorHoverPoint | null>(null);
  const [vectorSelectedIndex, setVectorSelectedIndex] = useState<number | null>(null);
  const [vectorSelectedSegmentIndex, setVectorSelectedSegmentIndex] = useState<number | null>(null);
  const [vectorExtendState, setVectorExtendState] = useState<VectorExtendState | null>(null);
  const [vectorExtendHoverPoint, setVectorExtendHoverPoint] = useState<VectorHoverPoint | null>(null);
  const [vectorPointerDown, setVectorPointerDown] = useState(false);
  const [pointEditDialog, setPointEditDialog] = useState<{ pointId: string; value: string } | null>(null);

  useEffect(() => {
    if (!groupOutlineDrawMode) {
      setGroupOutlineHoverPoint(null);
      return;
    }

    canvasWrapRef.current?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      const isEscape = event.key === 'Escape' || event.key === 'Esc' || event.code === 'Escape';
      const isEnter = event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter';
      if (!isEscape && !isEnter) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (isEscape) cancelGroupOutlineDrawing();
      else closeGroupOutlineDrawing();
    };

    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyDown, true);
    window.addEventListener('keyup', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyDown, true);
      window.removeEventListener('keyup', onKeyDown, true);
    };
  }, [cancelGroupOutlineDrawing, closeGroupOutlineDrawing, groupOutlineDrawMode]);

  useEffect(() => {
    if (numberingPickMode !== 'manual_link_target') {
      setManualLinkDraft(null);
      setSelectionRect(null);
      setSelectionStart(null);
    }
  }, [numberingPickMode]);

  useEffect(() => {
    if (!vectorPathDrawMode) {
      setVectorPointerDown(false);
      setVectorHoverPoint(null);
      return;
    }

    canvasWrapRef.current?.focus({ preventScroll: true });

    const stopStroke = () => setVectorPointerDown(false);
    const onKeyDown = (event: KeyboardEvent) => {
      const isEscape = event.key === 'Escape' || event.key === 'Esc' || event.code === 'Escape';
      const isEnter = event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter';
      const isUndo = (event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'z' || event.code === 'KeyZ');
      if (!isEscape && !isEnter && !isUndo) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setVectorPointerDown(false);
      if (isUndo) undoLastVectorPathDraftPoint();
      else if (isEscape) cancelVectorPathDrawing();
      else finishVectorPathDrawing();
    };

    window.addEventListener('mouseup', stopStroke, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('mouseup', stopStroke, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [cancelVectorPathDrawing, finishVectorPathDrawing, undoLastVectorPathDraftPoint, vectorPathDrawMode]);

  useEffect(() => {
    if (!vectorPathEditMode) {
      setVectorSelectedIndex(null);
      setVectorSelectedSegmentIndex(null);
      setVectorExtendState(null);
      setVectorExtendHoverPoint(null);
      return;
    }
    canvasWrapRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      const isEscape = event.key === 'Escape' || event.key === 'Esc' || event.code === 'Escape';
      const isDelete = event.key === 'Delete' || event.key === 'Backspace';
      const isEnter = event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter';
      const isUndo = (event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'z' || event.code === 'KeyZ');

      if (vectorExtendState && (isEscape || isEnter || isUndo)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (isUndo) undoVectorExtensionPoint();
        else if (isEnter) finishVectorExtension();
        else cancelVectorExtension();
        return;
      }

      if (!isEscape && !isDelete) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (isEscape) {
        cancelVectorPathEdit();
        return;
      }
      const editGroupId = selectedGroupId ?? project.groups[0]?.id ?? null;
      if (!editGroupId) return;
      if (vectorSelectedIndex != null) deleteVectorPathPoint(editGroupId, vectorSelectedIndex);
      else if (vectorSelectedSegmentIndex != null) deleteVectorPathPoint(editGroupId, vectorSelectedSegmentIndex + 1);
      setVectorSelectedIndex(null);
      setVectorSelectedSegmentIndex(null);
    };
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [cancelVectorPathEdit, deleteVectorPathPoint, project.groups, selectedGroupId, vectorPathEditMode, vectorSelectedIndex, vectorSelectedSegmentIndex, vectorExtendState]);

  const { zoom, panX, panY } = project.viewSettings;
  const rawNumberText = project.viewSettings.numberTextMode === 'manual'
    ? {
        fill: project.viewSettings.numberTextColor || '#ffffff',
        stroke: project.viewSettings.numberTextStrokeColor || '#020617',
        bubble: 'rgba(2,6,23,0.72)'
      }
    : readableTextColors(project.viewSettings.backgroundColor);

  const numberText = {
    ...rawNumberText,
    fill: applyBrightness(rawNumberText.fill, project.viewSettings.numberTextBrightness ?? 1),
    stroke: project.viewSettings.numberTextStrokeEnabled === false ? 'transparent' : rawNumberText.stroke,
    bubble: project.viewSettings.numberTextBubbleEnabled === false ? 'rgba(0,0,0,0)' : (project.viewSettings.numberTextBubbleColor || rawNumberText.bubble),
    bubbleStroke: project.viewSettings.numberTextBubbleStrokeColor || rawNumberText.stroke
  };
  const numberFontSize = Math.max(7, Math.min(48, project.viewSettings.numberTextFontSize ?? 13));
  const numberStrokeWidth = project.viewSettings.numberTextStrokeEnabled === false ? 0 : Math.max(0, Math.min(5, project.viewSettings.numberTextStrokeWidth ?? 0.8));
  const numberFontFamily = project.viewSettings.numberTextFontFamily || 'Tahoma, Segoe UI, Arial, sans-serif';
  const markerFontSize = Math.max(8, Math.min(42, project.viewSettings.markerTextFontSize ?? 12));
  const markerFontFamily = project.viewSettings.markerTextFontFamily || 'Tahoma, Segoe UI, Arial, sans-serif';
  const markerStrokeWidth = project.viewSettings.markerTextStrokeEnabled === false ? 0 : Math.max(0, Math.min(5, project.viewSettings.markerTextStrokeWidth ?? 0.9));
  const markerFill = applyBrightness(project.viewSettings.markerTextColor || '#bfdbfe', project.viewSettings.markerTextBrightness ?? 1);
  const markerStroke = project.viewSettings.markerTextStrokeEnabled === false ? 'transparent' : (project.viewSettings.markerTextStrokeColor || '#020617');
  const markerLabelsVisible = project.viewSettings.showMarkerLabels !== false;
  const previewLabelFontSize = Math.max(7, Math.min(42, project.viewSettings.previewPointLabelFontSize ?? 12));
  const previewLabelStrokeWidth = Math.max(0, Math.min(5, project.viewSettings.previewPointLabelStrokeWidth ?? 1));
  const previewLabelFill = applyBrightness(project.viewSettings.previewPointLabelColor || '#ede9fe', project.viewSettings.previewPointLabelBrightness ?? 1);
  const previewLabelBubble = project.viewSettings.previewPointLabelBubbleEnabled !== false ? (project.viewSettings.previewPointLabelBubbleColor || '#020617') : 'rgba(0,0,0,0)';
  const hoverNumbers = settingsHoverTarget === 'number_text';
  const hoverPathNumbers = settingsHoverTarget === 'path_numbers';
  const hoverMarkers = settingsHoverTarget === 'markers';
  const hoverGroupOutline = settingsHoverTarget === 'group_outline';
  const hoverPreviewLines = settingsHoverTarget === 'preview_lines';

  const worldToScreen = (x: number, y: number): ScreenPoint => ({ x: x * zoom + panX, y: -y * zoom + panY });
  const screenToWorld = (x: number, y: number): ScreenPoint => ({ x: (x - panX) / zoom, y: -(y - panY) / zoom });

  const pointer = (): ScreenPoint | null => {
    const stage = stageRef.current;
    const pos = stage?.getPointerPosition();
    return pos ? { x: pos.x, y: pos.y } : null;
  };

  const findNearestPoint = (screenPos: ScreenPoint, maxDistancePx?: number) => {
    if (!project.points.length) return null;
    let nearest: { id: string; x: number; y: number; groupId?: string | null } | null = null;
    let best = Number.POSITIVE_INFINITY;

    for (const point of project.points) {
      const sp = worldToScreen(point.x, point.y);
      const d = distance2(sp, screenPos);
      if (d < best) {
        best = d;
        nearest = { id: point.id, x: point.x, y: point.y, groupId: point.groupId };
      }
    }

    if (!nearest) return null;
    if (typeof maxDistancePx === 'number' && best > maxDistancePx * maxDistancePx) return null;
    return nearest;
  };

  const selectNearestPoint = (screenPos: ScreenPoint) => {
    const nearest = findNearestPoint(screenPos);
    if (!nearest) return;
    setSelection([nearest.id]);
    if (nearest.groupId) setSelectedGroup(nearest.groupId);
  };

  const resolveGroupOutlineSnap = (screenPos: ScreenPoint, rawWorld: WorldPoint, forceOrtho: boolean) => {
    let snapTarget: WorldPoint | null = null;
    let snapScreen: ScreenPoint | undefined;
    let kind: GroupOutlineSnapKind = 'free';
    const snapRadiusPx = forceOrtho ? 42 : 16;

    // CAD-like object snap for manual contours.
    // Без Shift точка ставится прямо в найденную вершину/сваю.
    // С Shift курсор выбирает опорную вершину/сваю, а итоговая фантомная
    // точка ставится в её ортогональную проекцию на ось от предыдущей вершины.
    // Это даёт именно пересечение "ось Shift" × "уровень/координата найденной точки".
    const draftVertex = groupOutlineDraft
      .map((point) => ({ point, screen: worldToScreen(point.x, point.y) }))
      .filter((item) => isFinitePoint(item.screen))
      .sort((a, b) => distance2(a.screen, screenPos) - distance2(b.screen, screenPos))[0];
    if (draftVertex && distance2(draftVertex.screen, screenPos) <= snapRadiusPx * snapRadiusPx) {
      snapTarget = { x: draftVertex.point.x, y: draftVertex.point.y };
      snapScreen = draftVertex.screen;
      kind = 'vertex';
    } else {
      const nearest = findNearestPoint(screenPos, snapRadiusPx);
      if (nearest) {
        snapTarget = { x: nearest.x, y: nearest.y };
        snapScreen = worldToScreen(nearest.x, nearest.y);
        kind = 'point';
      }
    }

    let point = snapTarget ?? rawWorld;
    if (forceOrtho) {
      const previous = groupOutlineDraft[groupOutlineDraft.length - 1];
      if (previous) {
        const dx = rawWorld.x - previous.x;
        const dy = rawWorld.y - previous.y;
        const horizontal = Math.abs(dx) >= Math.abs(dy);
        if (snapTarget) {
          point = horizontal
            ? { x: snapTarget.x, y: previous.y }
            : { x: previous.x, y: snapTarget.y };
        } else {
          point = makeOrthogonalDraftPoint(previous, rawWorld);
        }
      } else {
        point = snapTarget ?? rawWorld;
      }
    }

    const screen = worldToScreen(point.x, point.y);
    const finalKind: GroupOutlineSnapKind = forceOrtho
      ? (kind === 'point' ? 'point_ortho' : kind === 'vertex' ? 'vertex_ortho' : 'ortho')
      : kind;
    return { point, screen, snapScreen, kind: finalKind };
  };

  const snapGroupOutlinePoint = (screenPos: ScreenPoint, rawWorld: WorldPoint, forceOrtho: boolean): WorldPoint => resolveGroupOutlineSnap(screenPos, rawWorld, forceOrtho).point;

  const resolveVectorDraftPoint = (rawWorld: WorldPoint, forceOrtho: boolean): VectorHoverPoint => {
    const previous = vectorPathDraft[vectorPathDraft.length - 1];
    const point = previous && forceOrtho ? makeOrthogonalDraftPoint(previous, rawWorld) : rawWorld;
    return { point, screen: worldToScreen(point.x, point.y), kind: previous && forceOrtho ? 'ortho' : 'free' };
  };

  const getIdsInRect = (rect: SelectionRectState) => project.points
    .filter((p) => rectContains(rect, worldToScreen(p.x, p.y)))
    .map((p) => p.id);

  const activeNumberingGroup = project.groups.find((g) => g.id === selectedGroupId) ?? project.groups[0] ?? null;
  const numberingStartPointId = activeNumberingGroup?.numbering.startPointId ?? null;
  const numberingEndPointId = activeNumberingGroup?.numbering.endPointId ?? null;

  const storedPreviewRoutePoints = numberingPreview.routePointIds
    .map((id) => project.points.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  const previewPoints = numberingPreview.visible ? storedPreviewRoutePoints : [];

  const activeGroupPoints = activeNumberingGroup
    ? project.points.filter((p) => p.groupId === activeNumberingGroup.id)
    : [];

  // v61: правка вектора работает только через режим «Редактировать».
  // v60: нарисованный вектор больше не является одноразовым draft-слоем.
  // Он хранится в настройках группы, постоянно отображается на поле и даёт
  // характерные точки, которые можно немного подтянуть без перерисовки всего пути.
  const vectorPathVisible = project.viewSettings.showVectorPath !== false || vectorPathDrawMode || vectorPathEditMode || Boolean(vectorExtendState);
  const activeVectorPathPoints = activeNumberingGroup?.numbering.method === 'vector' && vectorPathVisible
    ? readWorldPointList(activeNumberingGroup.numbering.vectorPath)
    : [];
  const activeVectorPathScreenPoints = activeVectorPathPoints
    .map((point, index) => ({ point, index, screen: worldToScreen(point.x, point.y) }))
    .filter((item) => isFinitePoint(item.screen));

  const findNearestVectorHit = (screen: ScreenPoint): { kind: 'point'; index: number; distance: number } | { kind: 'segment'; index: number; distance: number } | null => {
    if (!vectorPathEditMode || activeVectorPathScreenPoints.length < 2) return null;
    const pointHitRadius = 22;
    const segmentHitRadius = 52;

    let nearestPoint: { index: number; distance: number } | null = null;
    for (const item of activeVectorPathScreenPoints) {
      const distance = Math.sqrt(distance2(item.screen, screen));
      if (!nearestPoint || distance < nearestPoint.distance) nearestPoint = { index: item.index, distance };
    }
    if (nearestPoint && nearestPoint.distance <= pointHitRadius) {
      return { kind: 'point', index: nearestPoint.index, distance: nearestPoint.distance };
    }

    let nearestSegment: { index: number; distance: number } | null = null;
    for (let index = 0; index < activeVectorPathScreenPoints.length - 1; index += 1) {
      const a = activeVectorPathScreenPoints[index];
      const b = activeVectorPathScreenPoints[index + 1];
      const distance = pointToSegmentDistancePx(screen, a.screen, b.screen);
      if (!nearestSegment || distance < nearestSegment.distance) nearestSegment = { index, distance };
    }
    if (nearestSegment && nearestSegment.distance <= segmentHitRadius) {
      return { kind: 'segment', index: nearestSegment.index, distance: nearestSegment.distance };
    }
    return null;
  };

  const updateActiveVectorHandle = (index: number, screen: ScreenPoint, commit = false) => {
    if (!activeNumberingGroup || activeNumberingGroup.locked) return;
    const world = screenToWorld(screen.x, screen.y);
    if (!Number.isFinite(world.x) || !Number.isFinite(world.y)) return;
    updateVectorPathPoint(activeNumberingGroup.id, index, world);
    if (commit) {
      recordOperation('group_vector_path_point_moved', { groupId: activeNumberingGroup.id, groupName: activeNumberingGroup.name, index: index + 1 });
      if (numberingPreview.visible && numberingPreview.groupId === activeNumberingGroup.id) requestAnimationFrame(() => useProjectStore.getState().buildNumberingPreview());
    }
  };

  const insertVectorPointFromScreen = (segmentIndex: number, screen: ScreenPoint) => {
    if (!activeNumberingGroup || activeNumberingGroup.locked) return;
    const rawWorld = screenToWorld(screen.x, screen.y);
    const a = activeVectorPathPoints[segmentIndex];
    const b = activeVectorPathPoints[segmentIndex + 1];
    const world = a && b ? closestPointOnSegmentWorld(rawWorld, a, b) : rawWorld;
    insertVectorPathPoint(activeNumberingGroup.id, segmentIndex + 1, world);
  };

  function startVectorExtension(anchorIndex: number) {
    if (!activeNumberingGroup || activeNumberingGroup.locked) return;
    const sourcePath = readWorldPointList(activeNumberingGroup.numbering.vectorPath);
    if (sourcePath.length < 2 || anchorIndex < 0 || anchorIndex >= sourcePath.length) return;
    setVectorSelectedIndex(anchorIndex);
    setVectorSelectedSegmentIndex(null);
    setVectorExtendHoverPoint(null);
    setVectorExtendState({
      groupId: activeNumberingGroup.id,
      anchorIndex,
      basePoint: sourcePath[anchorIndex],
      draft: []
    });
  }

  function cancelVectorExtension() {
    setVectorExtendState(null);
    setVectorExtendHoverPoint(null);
  }

  function undoVectorExtensionPoint() {
    setVectorExtendState((state) => state ? { ...state, draft: state.draft.slice(0, -1) } : state);
  }

  function resolveVectorExtensionPoint(rawWorld: WorldPoint, forceOrtho: boolean): VectorHoverPoint | null {
    if (!vectorExtendState) return null;
    const previous = vectorExtendState.draft[vectorExtendState.draft.length - 1] ?? vectorExtendState.basePoint;
    const point = forceOrtho ? makeOrthogonalDraftPoint(previous, rawWorld) : rawWorld;
    return { point, screen: worldToScreen(point.x, point.y), kind: forceOrtho ? 'ortho' : 'free' };
  }

  function addVectorExtensionPoint(point: WorldPoint) {
    setVectorExtendState((state) => {
      if (!state) return state;
      const nextPoint = { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 };
      const previous = state.draft[state.draft.length - 1] ?? state.basePoint;
      if (Math.hypot(previous.x - nextPoint.x, previous.y - nextPoint.y) < 1) return state;
      return { ...state, draft: [...state.draft, nextPoint] };
    });
  }

  function finishVectorExtension() {
    if (!vectorExtendState || vectorExtendState.draft.length === 0) {
      cancelVectorExtension();
      return;
    }
    const group = project.groups.find((item) => item.id === vectorExtendState.groupId);
    if (!group || group.locked) {
      cancelVectorExtension();
      return;
    }
    const sourcePath = readWorldPointList(group.numbering.vectorPath);
    if (sourcePath.length < 2) {
      cancelVectorExtension();
      return;
    }
    const safeAnchor = Math.max(0, Math.min(vectorExtendState.anchorIndex, sourcePath.length - 1));
    const isStart = safeAnchor === 0;
    const extension = compactCanvasWorldPath(vectorExtendState.draft, 1);
    const nextPath = isStart
      ? compactCanvasWorldPath([...extension.slice().reverse(), ...sourcePath], 1)
      : compactCanvasWorldPath([...sourcePath, ...extension], 1);
    pushHistory();
    updateGroupNumbering(group.id, { method: 'vector', vectorPath: nextPath });
    recordOperation('group_vector_path_extended', { groupId: group.id, groupName: group.name, side: isStart ? 'start' : 'end', points: extension.length });
    setVectorExtendState(null);
    setVectorExtendHoverPoint(null);
    setVectorSelectedIndex(isStart ? 0 : nextPath.length - 1);
    setVectorSelectedSegmentIndex(null);
  }

  const activeGroupOutline = useMemo(() => {
    if (!activeNumberingGroup || activeGroupPoints.length === 0 || project.viewSettings.groupOutlineVisible === false) return null;
    try {
      const userPad = project.viewSettings.groupOutlinePadding ?? 28;
      const padPx = Math.max(8, Math.min(120, userPad));
      const manualOutline = readWorldPointList(activeNumberingGroup.meta?.manualOutline);
      const screenPoints = activeGroupPoints.map((p) => worldToScreen(p.x, p.y)).filter(isFinitePoint);
      if (screenPoints.length === 0) return null;

      let outline: ScreenPoint[] = [];
      if (manualOutline.length >= 3) {
        // Для ручного контура первая вершина — осознанная точка привязки выноски.
        outline = manualOutline.map((point) => worldToScreen(point.x, point.y)).filter(isFinitePoint);
      } else {
        // Автоконтур строится в мировых координатах как несколько крупных
        // CAD-прямоугольников: горизонтальные полки + вертикальные стойки.
        // Это стабильнее при zoom/pan, не лагает от сотен мелких свай и не даёт
        // зубчатый corridor по каждой точке. Ручной контур остаётся приоритетным.
        const worldOutline = makeGroupOutlineWorldCadBands(
          activeGroupPoints.map((point) => ({ x: point.x, y: point.y })),
          userPad
        );
        outline = worldOutline.map((point) => worldToScreen(point.x, point.y)).filter(isFinitePoint);
      }

      if (outline.length < 3) return null;
      // Выноска всегда цепляется к первой вершине текущего контура: ручного или авто.
      // Раньше якорь считался от minX/minY, поэтому после перерисовки ручного контура
      // подпись оставалась сбоку и визуально не относилась к выбранной первой точке.
      const anchor = outline.find(isFinitePoint) ?? screenPoints[0];
      const anchorX = anchor.x;
      const anchorY = anchor.y;
      const labelWidth = Math.max(168, activeNumberingGroup.name.length * 8.5 + 92);
      const preferLeft = anchorX > width * 0.72;
      const preferBottom = anchorY < 110;
      const labelBaseX = anchorX + (preferLeft ? -labelWidth - 28 : 28);
      const labelBaseY = anchorY + (preferBottom ? 30 : -Math.max(82, markerFontSize + 66));
      const savedOffsetRaw = activeNumberingGroup.meta?.calloutOffset;
      const savedOffset = savedOffsetRaw && typeof savedOffsetRaw === 'object'
        ? savedOffsetRaw as Partial<ScreenPoint>
        : {};
      return {
        points: flattenPoints(outline),
        anchorX,
        anchorY,
        labelBaseX,
        labelBaseY,
        labelX: labelBaseX + (Number(savedOffset.x) || 0),
        labelY: labelBaseY + (Number(savedOffset.y) || 0),
        labelWidth,
        // Контур активной группы по умолчанию повторяет цвет группы.
        // Настроечный цвет остаётся резервом для старых проектов без цвета группы.
        color: activeNumberingGroup.color || project.viewSettings.groupOutlineStrokeColor || '#60a5fa',
        fill: activeNumberingGroup.color ? hexToRgba(activeNumberingGroup.color, 0.045) : (project.viewSettings.groupOutlineFillColor || 'rgba(96,165,250,0.035)'),
        name: activeNumberingGroup.name,
        count: activeGroupPoints.length,
        groupId: activeNumberingGroup.id,
        manual: manualOutline.length >= 3
      };
    } catch (error) {
      console.warn('Active group outline render failed', error);
      return null;
    }
  }, [activeGroupPoints, activeNumberingGroup, markerFontSize, panX, panY, project.viewSettings.groupOutlineFillColor, project.viewSettings.groupOutlinePadding, project.viewSettings.groupOutlineSimplifyPx, project.viewSettings.groupOutlineSnapPx, project.viewSettings.groupOutlineStrokeColor, project.viewSettings.groupOutlineVisible, width, zoom]);

  const numberedFallbackAutoPoints = [...activeGroupPoints].sort((a, b) => {
    const an = Number(a.number);
    const bn = Number(b.number);
    const aHasNumber = Number.isFinite(an);
    const bHasNumber = Number.isFinite(bn);
    if (aHasNumber && bHasNumber && an !== bn) return an - bn;
    if (aHasNumber !== bHasNumber) return aHasNumber ? -1 : 1;
    return (a.x - b.x) || (b.y - a.y);
  });
  const previewBelongsToActiveGroup = Boolean(activeNumberingGroup && numberingPreview.groupId === activeNumberingGroup.id && storedPreviewRoutePoints.length);
  const effectiveRoutePoints = previewBelongsToActiveGroup ? storedPreviewRoutePoints : numberedFallbackAutoPoints;
  const effectiveNumberingStartPointId = numberingStartPointId ?? effectiveRoutePoints[0]?.id ?? null;
  const effectiveNumberingEndPointId = numberingEndPointId ?? effectiveRoutePoints[effectiveRoutePoints.length - 1]?.id ?? null;

  const previewRouteIndexById = useMemo(() => {
    const map = new Map<string, number>();
    numberingPreview.routePointIds.forEach((id, index) => map.set(id, index));
    return map;
  }, [numberingPreview.routePointIds]);

  const isManualTargetAllowedOnCanvas = (fromId: string | null, toId: string | null) => {
    if (!fromId || !toId || fromId === toId) return false;
    const source = project.points.find((p) => p.id === fromId);
    const target = project.points.find((p) => p.id === toId);
    if (!source || !target || !activeNumberingGroup || source.groupId !== activeNumberingGroup.id || target.groupId !== activeNumberingGroup.id) return false;
    const fromIndex = previewRouteIndexById.get(fromId);
    const toIndex = previewRouteIndexById.get(toId);
    return typeof fromIndex === 'number' && typeof toIndex === 'number' && toIndex > fromIndex;
  };

  const focusedManualLink = Boolean(numberingPickMode === 'manual_link_target' && numberingLinkFromId);
  const previewSegmentsListening = manualLinkClearMode || (!editPointPickMode && !numberingPickMode && !vectorPathDrawMode && !vectorPathEditMode);
  const focusedPointIds = new Set([numberingLinkFromId, numberingLinkToId].filter((id): id is string => Boolean(id)));

  useEffect(() => {
    if (!numberingPreview.visible || previewPoints.length <= 1) {
      setPreviewStep(previewPoints.length);
      return;
    }

    if (numberingPreview.displayMode === 'full') {
      setPreviewStep(previewPoints.length);
      return;
    }

    if (numberingPreview.displayMode === 'paused') {
      setPreviewStep((value) => Math.max(1, Math.min(value || previewPoints.length, previewPoints.length)));
      return;
    }

    setPreviewStep((value) => Math.max(1, Math.min(value || 1, previewPoints.length)));
    const timer = window.setInterval(() => {
      setPreviewStep((value) => {
        if (value >= previewPoints.length) return 1;
        return value + 1;
      });
    }, 420);
    return () => window.clearInterval(timer);
  }, [numberingPreview.displayMode, numberingPreview.generatedAt, numberingPreview.visible, previewPoints.length]);

  const gridLines = useMemo(() => {
    if (zoom <= 0) return [];

    type GridLine = { points: number[]; kind: 'minor' | 'major' | 'axisX' | 'axisY' };
    const lines: GridLine[] = [];
    const topLeft = screenToWorld(0, 0);
    const bottomRight = screenToWorld(width, height);
    const worldMinX = Math.min(topLeft.x, bottomRight.x);
    const worldMaxX = Math.max(topLeft.x, bottomRight.x);
    const worldMinY = Math.min(topLeft.y, bottomRight.y);
    const worldMaxY = Math.max(topLeft.y, bottomRight.y);

    const addVertical = (x: number, kind: GridLine['kind']) => {
      const sx = worldToScreen(x, 0).x;
      lines.push({ points: [sx, 0, sx, height], kind });
    };
    const addHorizontal = (y: number, kind: GridLine['kind']) => {
      const sy = worldToScreen(0, y).y;
      lines.push({ points: [0, sy, width, sy], kind });
    };

    const safeMajorStep = Math.max(1, Number(project.gridSettings.majorStep) || 1000);
    const safeMinorStep = Math.max(1, Number(project.gridSettings.minorStep) || safeMajorStep);
    const isOnMajorLine = (value: number) => {
      if (!Number.isFinite(value) || safeMajorStep <= 0) return false;
      const ratio = value / safeMajorStep;
      return Math.abs(ratio - Math.round(ratio)) < 1e-7;
    };

    const addGridStep = (stepWorld: number, kind: 'minor' | 'major', skipMajorOverlay = false) => {
      const safeStep = Math.max(1, Number(stepWorld) || 0);
      const minPixelStep = kind === 'minor' ? 2 : 4;
      if (!project.gridSettings.enabled || safeStep <= 0 || safeStep * zoom < minPixelStep) return;
      const minX = Math.floor(worldMinX / safeStep) * safeStep;
      const maxX = Math.ceil(worldMaxX / safeStep) * safeStep;
      const minY = Math.floor(worldMinY / safeStep) * safeStep;
      const maxY = Math.ceil(worldMaxY / safeStep) * safeStep;
      const maxLinesPerAxis = 2500;
      let verticalCount = 0;
      for (let x = minX; x <= maxX && verticalCount < maxLinesPerAxis; x += safeStep) {
        verticalCount += 1;
        if (Math.abs(x) <= 1e-9) continue;
        if (skipMajorOverlay && isOnMajorLine(x)) continue;
        addVertical(x, kind);
      }
      let horizontalCount = 0;
      for (let y = minY; y <= maxY && horizontalCount < maxLinesPerAxis; y += safeStep) {
        horizontalCount += 1;
        if (Math.abs(y) <= 1e-9) continue;
        if (skipMajorOverlay && isOnMajorLine(y)) continue;
        addHorizontal(y, kind);
      }
    };

    // Важно: малая сетка должна жить своим шагом, а не выглядеть как дубль
    // основной. Линии, совпадающие с основным шагом, пропускаем у minor-сетки,
    // чтобы пользователь явно видел изменение `minorStep`.
    addGridStep(safeMinorStep, 'minor', true);
    addGridStep(safeMajorStep, 'major');

    if (project.gridSettings.axesEnabled) {
      if (worldMinX <= 0 && worldMaxX >= 0) addVertical(0, 'axisY');
      if (worldMinY <= 0 && worldMaxY >= 0) addHorizontal(0, 'axisX');
    }

    return lines;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    project.gridSettings.enabled,
    project.gridSettings.axesEnabled,
    project.gridSettings.majorStep,
    project.gridSettings.minorStep,
    zoom,
    panX,
    panY,
    width,
    height
  ]);

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();

    // При редактировании ручной связи wheel меняет масштаб/панораму, а не должен
    // оставлять старый draft-жест в экранных координатах. Иначе после zoom
    // появляется визуальный "мираж" дублированных точек/линий до снятия выбора.
    if (numberingPickMode === 'manual_link_target') {
      setManualLinkDraft(null);
      setSelectionRect(null);
      setSelectionStart(null);
    }
    if (vectorPathDrawMode) setVectorPointerDown(false);

    const pos = pointer();
    if (!pos) return;

    const world = screenToWorld(pos.x, pos.y);
    const factor = e.evt.deltaY > 0 ? 1 / 1.12 : 1.12;
    const newZoom = Math.max(0.001, Math.min(200, zoom * factor));
    const newPanX = pos.x - world.x * newZoom;
    const newPanY = pos.y + world.y * newZoom;
    updateView(newZoom, newPanX, newPanY);
  };

  const onMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    const pos = pointer();
    if (!pos) return;

    if (groupOutlineDrawMode) {
      if (e.evt.button === 1 || e.evt.button === 2) {
        setPanStart({ pointer: pos, panX, panY });
        return;
      }
      if (e.evt.button !== 0) return;
      e.cancelBubble = true;
      const first = groupOutlineDraft[0];
      if (first && groupOutlineDraft.length >= 3) {
        const firstScreen = worldToScreen(first.x, first.y);
        if (distance2(firstScreen, pos) <= 22 * 22) {
          closeGroupOutlineDrawing();
          setSelectionRect(null);
          setSelectionStart(null);
          return;
        }
      }
      const rawWorld = screenToWorld(pos.x, pos.y);
      const world = snapGroupOutlinePoint(pos, rawWorld, e.evt.shiftKey);
      addGroupOutlineDraftPoint(world);
      setSelectionRect(null);
      setSelectionStart(null);
      return;
    }

    if (vectorPathDrawMode) {
      if (e.evt.button === 1 || e.evt.button === 2) {
        setPanStart({ pointer: pos, panX, panY });
        return;
      }
      if (e.evt.button !== 0) return;
      e.cancelBubble = true;
      const rawWorld = screenToWorld(pos.x, pos.y);
      const resolved = resolveVectorDraftPoint(rawWorld, e.evt.shiftKey);
      addVectorPathDraftPoint(resolved.point);
      setVectorHoverPoint(resolved);
      setVectorPointerDown(false);
      setSelectionRect(null);
      setSelectionStart(null);
      return;
    }

    if (vectorPathEditMode && vectorExtendState) {
      if (e.evt.button === 1 || e.evt.button === 2) {
        setPanStart({ pointer: pos, panX, panY });
        return;
      }
      if (e.evt.button !== 0) return;
      e.cancelBubble = true;
      const rawWorld = screenToWorld(pos.x, pos.y);
      const resolved = resolveVectorExtensionPoint(rawWorld, e.evt.shiftKey);
      if (resolved) {
        addVectorExtensionPoint(resolved.point);
        setVectorExtendHoverPoint(resolved);
      }
      setSelectionRect(null);
      setSelectionStart(null);
      return;
    }

    if (e.evt.button === 1 || e.evt.button === 2) {
      setPanStart({ pointer: pos, panX, panY });
      return;
    }

    if (e.evt.button !== 0) return;

    if (vectorPathEditMode) {
      // В режиме редактирования вектора рабочее поле не выбирает сваи и не создаёт рамку.
      // Клик рядом с вершиной выбирает вершину; клик рядом с линией выбирает ближайший сегмент.
      e.cancelBubble = true;
      const hit = findNearestVectorHit(pos);
      if (hit?.kind === 'point') {
        setVectorSelectedIndex(hit.index);
        setVectorSelectedSegmentIndex(null);
      } else if (hit?.kind === 'segment') {
        setVectorSelectedSegmentIndex(hit.index);
        setVectorSelectedIndex(null);
      } else {
        setVectorSelectedIndex(null);
        setVectorSelectedSegmentIndex(null);
      }
      setSelectionRect(null);
      setSelectionStart(null);
      return;
    }

    if (editPointPickMode || numberingPickMode) {
      setSelectionStart(pos);
      setSelectionRect(null);
      return;
    }

    if (pointInfoVisible) {
      selectNearestPoint(pos);
      setSelectionRect(null);
      setSelectionStart(null);
      return;
    }

    const clickedEmpty = e.target === e.target.getStage();
    if (!clickedEmpty) return;

    setSelectionStart(pos);
    setSelectionRect({ x: pos.x, y: pos.y, w: 0, h: 0, mode: 'add' });
  };

  const onMouseMove = (event?: KonvaEventObject<MouseEvent>) => {
    const pos = pointer();
    if (!pos) return;
    const world = screenToWorld(pos.x, pos.y);
    onPointerUpdate(world.x, world.y);

    if (groupOutlineDrawMode) {
      const resolved = resolveGroupOutlineSnap(pos, world, Boolean(event?.evt.shiftKey));
      setGroupOutlineHoverPoint(resolved);
      if (!panStart) return;
    }

    if (panStart) {
      updateView(zoom, panStart.panX + pos.x - panStart.pointer.x, panStart.panY + pos.y - panStart.pointer.y);
      return;
    }

    if (vectorPathDrawMode) {
      const resolved = resolveVectorDraftPoint(world, Boolean(event?.evt.shiftKey));
      setVectorHoverPoint(resolved);
      return;
    }

    if (vectorPathEditMode) {
      if (vectorExtendState) {
        const resolved = resolveVectorExtensionPoint(world, Boolean(event?.evt.shiftKey));
        setVectorExtendHoverPoint(resolved);
      }
      setSelectionRect(null);
      setSelectionStart(null);
      return;
    }

    if ((editPointPickMode || numberingPickMode) && selectionStart) {
      if (numberingPickMode === 'manual_link_target') {
        const nearest = findNearestPoint(pos, 34);
        setManualLinkDraft({
          screen: nearest ? worldToScreen(nearest.x, nearest.y) : pos,
          targetId: nearest?.id ?? null,
          allowed: nearest ? isManualTargetAllowedOnCanvas(numberingLinkFromId, nearest.id) : false
        });
        return;
      }

      const canRectanglePickTargets = editPointPickMode === 'props_target';
      const movedEnough = distance2(selectionStart, pos) > 16;
      if (!editPointPickMode) return;
      if (canRectanglePickTargets && movedEnough) {
        setSelectionRect({
          x: Math.min(selectionStart.x, pos.x),
          y: Math.min(selectionStart.y, pos.y),
          w: Math.abs(pos.x - selectionStart.x),
          h: Math.abs(pos.y - selectionStart.y),
          mode: 'add',
          label: 'Приёмники свойств'
        });
      }
      return;
    }

    if (selectionStart && selectionRect) {
      const mode: SelectionMode = getDragSelectionMode(selectionStart.x, pos.x, project.viewSettings.selectionDragMode);
      setSelectionRect({
        x: Math.min(selectionStart.x, pos.x),
        y: Math.min(selectionStart.y, pos.y),
        w: Math.abs(pos.x - selectionStart.x),
        h: Math.abs(pos.y - selectionStart.y),
        mode
      });
    }
  };

  const onMouseUp = () => {
    const pos = pointer();

    if (panStart) {
      setPanStart(null);
      return;
    }

    if (vectorPathDrawMode) {
      setVectorPointerDown(false);
      setSelectionRect(null);
      setSelectionStart(null);
      return;
    }

    if (vectorPathEditMode) {
      setSelectionRect(null);
      setSelectionStart(null);
      return;
    }

    if (numberingPickMode && selectionStart) {
      if (pos) {
        const nearest = numberingPickMode === 'manual_link_target' ? findNearestPoint(pos, 42) : findNearestPoint(pos);
        if (nearest) handleNumberingPickPoint(nearest.id);
      }
      setManualLinkDraft(null);
      setSelectionRect(null);
      setSelectionStart(null);
      return;
    }

    if (editPointPickMode && selectionStart) {
      if (selectionRect && selectionRect.w > 3 && selectionRect.h > 3 && editPointPickMode === 'props_target') {
        const ids = getIdsInRect(selectionRect).filter((id) => id !== propertySourcePointId);
        if (ids.length > 0) {
          setSelection(ids);
          if (propertySourcePointId) copyGroupPropertyToTargets(propertySourcePointId, ids);
        }
      } else if (pos) {
        const nearest = findNearestPoint(pos);
        if (nearest) handleCanvasEditPoint({ x: nearest.x, y: nearest.y }, nearest.id);
      }
      setSelectionRect(null);
      setSelectionStart(null);
      return;
    }

    if (!selectionRect) return;
    const { x, y, w, h, mode } = selectionRect;

    if (manualLinkClearMode) {
      const hitKeys = previewSegments
        .filter((segment) => segment.manualLink)
        .filter((segment) => {
          const [x1, y1, x2, y2] = segment.linePoints;
          const midpoint = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
          return rectContains(selectionRect, midpoint);
        })
        .map((segment) => manualLinkKey(segment.fromId, segment.toId));
      const current = new Set(manualLinkClearSelection);
      for (const key of hitKeys) {
        if (mode === 'subtract') current.delete(key);
        else current.add(key);
      }
      setManualLinkClearSelection(Array.from(current));
      setSelectionRect(null);
      setSelectionStart(null);
      return;
    }

    const ids = project.points
      .filter((p) => {
        const sp = worldToScreen(p.x, p.y);
        return sp.x >= x && sp.x <= x + w && sp.y >= y && sp.y <= y + h;
      })
      .map((p) => p.id);

    const nextSelection = mode === 'add'
      ? Array.from(new Set([...selectedPointIds, ...ids]))
      : selectedPointIds.filter((id) => !ids.includes(id));

    setSelection(nextSelection);

    if (!pointInfoVisible && mode === 'add' && autoAssignSelection && selectedGroupId && ids.length > 0) {
      assignPointIdsToGroup(ids, selectedGroupId);
    }

    setSelectionRect(null);
    setSelectionStart(null);
  };

  const onPointMouseDown = (e: KonvaEventObject<MouseEvent>, pointId: string) => {
    if (!editPointPickMode && !numberingPickMode && !vectorPathDrawMode) return;
    e.cancelBubble = true;
    setManualLinkDraft(null);
    const point = project.points.find((p) => p.id === pointId);
    if (!point) return;
    if (vectorPathDrawMode) {
      addVectorPathDraftPoint({ x: point.x, y: point.y });
      setVectorHoverPoint({ point: { x: point.x, y: point.y }, screen: worldToScreen(point.x, point.y), kind: 'free' });
      return;
    }
    if (editPointPickMode) handleCanvasEditPoint({ x: point.x, y: point.y }, point.id);
    else if (numberingPickMode) handleNumberingPickPoint(point.id);
  };

  const onPointClick = (e: KonvaEventObject<MouseEvent>, pointId: string) => {
    e.cancelBubble = true;
    const point = project.points.find((p) => p.id === pointId);
    if (!point) return;

    if (editPointPickMode || numberingPickMode || vectorPathDrawMode || vectorPathEditMode) return;

    if (point.groupId) {
      setSelectedGroup(point.groupId);
    }
    if (pointInfoVisible) {
      setSelection([pointId]);
      return;
    }
    togglePointSelection(pointId, e.evt.shiftKey, e.evt.ctrlKey);
  };

  const onPointDblClick = (e: KonvaEventObject<MouseEvent>, pointId: string) => {
    e.cancelBubble = true;
    if (editPointPickMode || numberingPickMode || vectorPathEditMode) return;
    const point = project.points.find((p) => p.id === pointId);
    if (!point) return;
    const group = point.groupId ? project.groups.find((g) => g.id === point.groupId) : null;
    if (point.locked || group?.locked) return;
    setSelection([pointId]);
    if (point.groupId) setSelectedGroup(point.groupId);
    setPointEditDialog({ pointId, value: point.number != null ? String(point.number) : '' });
  };

  const clearContextMenu = (e: KonvaEventObject<PointerEvent>) => {
    e.evt.preventDefault();
  };

  const selectionStyle = selectionRect?.mode === 'subtract'
    ? { stroke: '#38bdf8', fill: 'rgba(56,189,248,0.13)', dash: [7, 4], label: selectionRect.label ?? 'Убрать из выбора' }
    : { stroke: '#22c55e', fill: 'rgba(34,197,94,0.13)', dash: [1, 0], label: selectionRect?.label ?? 'Добавить к выбору' };

  const displayedPreviewPoints = previewPoints.slice(0, Math.max(1, Math.min(previewStep, previewPoints.length)));
  const previewSegments = useMemo(() => {
    if (!numberingPreview.visible || project.viewSettings.showNumberingPreview === false || displayedPreviewPoints.length === 0) return [] as Array<{
      key: string;
      fromId: string;
      toId: string;
      linePoints: number[];
      arrowPoints: number[] | null;
      selectedLink: boolean;
      manualSource: boolean;
      manualLink: boolean;
      pendingClear: boolean;
    }>;
    try {
      const manualLinks = new Set((activeNumberingGroup?.numbering.manualLinks ?? []).map((link) => `${link.fromId}->${link.toId}`));
      const segments: Array<{
        key: string;
        fromId: string;
        toId: string;
        linePoints: number[];
        arrowPoints: number[] | null;
        selectedLink: boolean;
        manualSource: boolean;
        manualLink: boolean;
        pendingClear: boolean;
      }> = [];
      for (let index = 1; index < displayedPreviewPoints.length; index += 1) {
        const from = displayedPreviewPoints[index - 1];
        const to = displayedPreviewPoints[index];
        const fromSp = worldToScreen(from.x, from.y);
        const toSp = worldToScreen(to.x, to.y);
        if (!isFinitePoint(fromSp) || !isFinitePoint(toSp)) continue;
        const segmentLength = Math.hypot(toSp.x - fromSp.x, toSp.y - fromSp.y);
        if (!Number.isFinite(segmentLength) || segmentLength <= 2) continue;
        const linePoints = [fromSp.x, fromSp.y, toSp.x, toSp.y];
        const arrowStart = segmentLength > 14 ? { x: fromSp.x * 0.34 + toSp.x * 0.66, y: fromSp.y * 0.34 + toSp.y * 0.66 } : null;
        const arrowEnd = segmentLength > 14 ? { x: fromSp.x * 0.18 + toSp.x * 0.82, y: fromSp.y * 0.18 + toSp.y * 0.82 } : null;
        const key = manualLinkKey(from.id, to.id);
        const manualLink = manualLinks.has(key);
        const selectedLink = numberingLinkFromId === from.id && (!numberingLinkToId || numberingLinkToId === to.id);
        segments.push({
          key,
          fromId: from.id,
          toId: to.id,
          linePoints,
          arrowPoints: arrowStart && arrowEnd ? buildArrowHead(arrowStart, arrowEnd) : null,
          selectedLink,
          manualSource: numberingLinkFromId === from.id,
          manualLink,
          pendingClear: manualLinkClearMode && manualLink && manualLinkClearSelection.includes(key)
        });
      }
      return segments;
    } catch (error) {
      console.warn('Numbering preview render failed', error);
      return [];
    }
  }, [activeNumberingGroup, displayedPreviewPoints, numberingLinkFromId, numberingLinkToId, manualLinkClearMode, manualLinkClearSelection, numberingPreview.visible, panX, panY, project.viewSettings.showNumberingPreview, zoom]);

  const manualLinkClearPointIds = useMemo(() => {
    const ids = new Set<string>();
    if (!manualLinkClearMode || !activeNumberingGroup) return ids;
    for (const link of activeNumberingGroup.numbering.manualLinks ?? []) {
      if (!link.fromId || !link.toId || link.fromId === link.toId) continue;
      ids.add(link.fromId);
      ids.add(link.toId);
    }
    return ids;
  }, [activeNumberingGroup, manualLinkClearMode]);

  const saveActiveGroupCalloutPosition = (nextX: number, nextY: number) => {
    if (!activeGroupOutline) return;
    updateGroupMeta(activeGroupOutline.groupId, {
      calloutOffset: {
        x: nextX - activeGroupOutline.labelBaseX,
        y: nextY - activeGroupOutline.labelBaseY
      }
    });
  };

  const saveMarkerCalloutPosition = (key: string, pointId: string, baseX: number, baseY: number, nextX: number, nextY: number) => {
    if (!activeNumberingGroup) return;
    const raw = activeNumberingGroup.meta?.markerCallouts;
    const current = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    updateGroupMeta(activeNumberingGroup.id, {
      markerCallouts: {
        ...current,
        [key]: {
          mode: 'world',
          pointId,
          x: Math.round(((nextX - baseX) / Math.max(zoom, 1e-9)) * 100) / 100,
          y: Math.round((-(nextY - baseY) / Math.max(zoom, 1e-9)) * 100) / 100
        }
      }
    });
  };

  const renderMarkerCallout = (params: {
    keyId: string;
    pointId: string;
    point: ScreenPoint;
    text: string;
    color: string;
    baseDx: number;
    baseDy: number;
  }) => {
    if (!markerLabelsVisible) return null;
    const baseX = params.point.x + params.baseDx;
    const baseY = params.point.y + params.baseDy;
    const raw = activeNumberingGroup?.meta?.markerCallouts;
    const savedMap = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const savedRaw = savedMap[params.keyId];
    const saved = savedRaw && typeof savedRaw === 'object' ? savedRaw as Partial<ScreenPoint> & { mode?: string; pointId?: unknown } : {};
    // v49: сохранённая выноска старт/финиш больше не применяется к другому
    // автоматическому endpoint. Иначе после смены маршрута подпись «Финиш авто»
    // могла улетать к старой точке и выглядело так, будто маркер стоит не там.
    const savedBelongsToPoint = saved.pointId === params.pointId;
    const savedMode = savedBelongsToPoint && saved.mode === 'world' ? 'world' : 'screen';
    const savedX = savedBelongsToPoint ? Number(saved.x) || 0 : 0;
    const savedY = savedBelongsToPoint ? Number(saved.y) || 0 : 0;
    const labelX = baseX + (savedMode === 'world' ? savedX * zoom : savedX);
    const labelY = baseY + (savedMode === 'world' ? -savedY * zoom : savedY);
    const width = Math.max(74, textWidth(params.text, Math.max(10, markerFontSize - 1)) + 18);
    return (
      <Group>
        <Line
          points={[params.point.x, params.point.y, labelX + 10, labelY + 14]}
          stroke={project.viewSettings.markerLeaderLineColor || params.color}
          strokeWidth={1.1 + (hoverMarkers ? 0.7 : 0)}
          dash={[5, 5]}
          opacity={hoverMarkers ? 0.95 : 0.72}
          listening={false}
        />
        <Group
          x={labelX}
          y={labelY}
          draggable={!activeNumberingGroup?.locked}
          onMouseDown={(event) => { event.cancelBubble = true; }}
          onClick={(event) => { event.cancelBubble = true; }}
          onDragEnd={(event) => { if (!activeNumberingGroup?.locked) saveMarkerCalloutPosition(params.keyId, params.pointId, baseX, baseY, event.target.x(), event.target.y()); }}
        >
          <Rect
            x={0}
            y={0}
            width={width}
            height={26}
            fill={project.viewSettings.markerCalloutBackgroundColor || '#020617'}
            stroke={project.viewSettings.markerCalloutBorderColor || params.color}
            strokeWidth={1.1}
            cornerRadius={7}
            shadowColor="#000"
            shadowBlur={7}
            shadowOpacity={0.25}
          />
          <Text
            x={9}
            y={6}
            text={params.text}
            fill={markerFill}
            stroke={markerStroke}
            strokeWidth={markerStrokeWidth}
            fontSize={Math.max(10, markerFontSize - 1)}
            fontFamily={markerFontFamily}
            fontStyle="bold"
            listening={false}
          />
        </Group>
      </Group>
    );
  };

  const selectPreviewSegment = (event: KonvaEventObject<MouseEvent>, fromId: string, toId: string) => {
    if (event.evt.button !== 0) return;
    if (editPointPickMode || numberingPickMode || vectorPathDrawMode || vectorPathEditMode) return;
    event.cancelBubble = true;
    const key = manualLinkKey(fromId, toId);
    const isManual = Boolean(activeNumberingGroup?.numbering.manualLinks?.some((link) => manualLinkKey(link.fromId, link.toId) === key));
    if (manualLinkClearMode) {
      if (isManual) toggleManualLinkClearSelection(key);
      return;
    }
    if (activeNumberingGroup?.locked) return;
    startNumberingManualLinkEdit(fromId, toId);
  };

  return (
    <div
      ref={canvasWrapRef}
      className="canvas-wrap"
      tabIndex={0}
      onKeyDownCapture={(event) => {
        if (!groupOutlineDrawMode && !vectorPathDrawMode && !vectorPathEditMode) return;
        const isEscape = event.key === 'Escape' || event.key === 'Esc';
        const isEnter = event.key === 'Enter';
        const isUndo = vectorPathDrawMode && (event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'z' || event.code === 'KeyZ');
        if (!isEscape && !isEnter && !isUndo) return;
        event.preventDefault();
        event.stopPropagation();
        if (groupOutlineDrawMode) {
          if (isEscape) cancelGroupOutlineDrawing();
          else closeGroupOutlineDrawing();
          return;
        }
        if (vectorPathEditMode && isEscape) {
          cancelVectorPathEdit();
          return;
        }
        if (isUndo) undoLastVectorPathDraftPoint();
        else if (isEscape) cancelVectorPathDrawing();
        else finishVectorPathDrawing();
      }}
    >
      <Stage
        ref={stageRef}
        width={width}
        height={height}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onContextMenu={clearContextMenu}
        style={{ background: project.viewSettings.backgroundColor, cursor: panStart ? 'grabbing' : vectorPathDrawMode ? 'crosshair' : vectorPathEditMode ? 'default' : editPointPickMode || numberingPickMode ? 'copy' : pointInfoVisible ? 'help' : 'crosshair' }}
      >
        <Layer listening={false}>
          {gridLines.map((line, idx) => {
            const stroke = line.kind === 'axisX' ? AXIS_X_COLOR : line.kind === 'axisY' ? AXIS_Y_COLOR : line.kind === 'major' ? project.gridSettings.color : project.gridSettings.minorColor;
            const strokeWidth = line.kind === 'axisX' || line.kind === 'axisY' ? 1.8 : line.kind === 'major' ? 0.7 : 0.35;
            return <Line key={idx} points={line.points} stroke={stroke} strokeWidth={strokeWidth} />;
          })}
          {project.gridSettings.axesEnabled && (
            <Group x={24} y={Math.max(54, height - 48)} listening={false} opacity={0.96}>
              <Rect x={-10} y={-38} width={92} height={54} cornerRadius={10} fill="rgba(2,6,23,0.64)" stroke="rgba(148,163,184,0.35)" strokeWidth={1} />
              <Line points={[0, 0, 55, 0]} stroke={AXIS_X_COLOR} strokeWidth={2.4} />
              <Line points={[55, 0, 47, -4, 47, 4, 55, 0]} stroke={AXIS_X_COLOR} strokeWidth={2.4} closed />
              <Line points={[0, 0, 0, -32]} stroke={AXIS_Y_COLOR} strokeWidth={2.4} />
              <Line points={[0, -32, -4, -24, 4, -24, 0, -32]} stroke={AXIS_Y_COLOR} strokeWidth={2.4} closed />
              <Circle x={0} y={0} radius={3.4} fill="#f8fafc" stroke="rgba(15,23,42,0.9)" strokeWidth={1} />
              <Text x={61} y={-9} text="X" fill={AXIS_X_COLOR} fontSize={13} fontStyle="bold" />
              <Text x={-5} y={-50} text="Y" fill={AXIS_Y_COLOR} fontSize={13} fontStyle="bold" />
            </Group>
          )}
        </Layer>

        <Layer>
          {activeGroupOutline && activeGroupOutline.points.length >= 6 && (
            <Group>
              <Line
                points={activeGroupOutline.points}
                closed
                fill={activeGroupOutline.fill}
                stroke={activeGroupOutline.color}
                strokeWidth={(project.viewSettings.groupOutlineStrokeWidth ?? 1.7) + (hoverGroupOutline ? 1.2 : 0)}
                dash={[project.viewSettings.groupOutlineDashSize ?? 10, 7]}
                opacity={hoverGroupOutline ? 1 : 0.82}
                listening={false}
              />
              <Line
                points={[
                  activeGroupOutline.anchorX,
                  activeGroupOutline.anchorY,
                  activeGroupOutline.labelX + 18,
                  activeGroupOutline.labelY + 28
                ]}
                stroke={project.viewSettings.markerLeaderLineColor || activeGroupOutline.color}
                strokeWidth={hoverGroupOutline ? 2 : 1.2}
                dash={[5, 5]}
                opacity={0.72}
                listening={false}
              />
              <Group
                x={activeGroupOutline.labelX}
                y={activeGroupOutline.labelY}
                draggable={!activeNumberingGroup?.locked}
                onMouseDown={(e) => { e.cancelBubble = true; }}
                onClick={(e) => { e.cancelBubble = true; }}
                onDragEnd={(e) => { if (!activeNumberingGroup?.locked) saveActiveGroupCalloutPosition(e.target.x(), e.target.y()); }}
              >
                <Rect
                  x={0}
                  y={0}
                  width={activeGroupOutline.labelWidth}
                  height={36}
                  fill={project.viewSettings.markerCalloutBackgroundColor || '#020617'}
                  stroke={project.viewSettings.markerCalloutBorderColor || activeGroupOutline.color}
                  strokeWidth={1.2}
                  cornerRadius={9}
                  shadowColor="#000"
                  shadowBlur={10}
                  shadowOpacity={0.32}
                />
                <Text
                  x={10}
                  y={6}
                  text={`${activeGroupOutline.name} · ${activeGroupOutline.count} точек`}
                  fill={markerFill}
                  stroke={markerStroke}
                  strokeWidth={markerStrokeWidth}
                  fontSize={Math.max(10, markerFontSize - 1)}
                  fontFamily={markerFontFamily}
                  fontStyle="bold"
                  listening={false}
                />
                <Text
                  x={10}
                  y={22}
                  text="выноску можно перетащить"
                  fill="#94a3b8"
                  fontSize={10}
                  fontFamily={markerFontFamily}
                  listening={false}
                />
                <Text
                  x={activeGroupOutline.labelWidth - 24}
                  y={9}
                  text="↕"
                  fill={activeGroupOutline.color}
                  fontSize={16}
                  fontStyle="bold"
                  listening={false}
                />
              </Group>
            </Group>
          )}
        </Layer>

        <Layer>
          {activeNumberingGroup && activeVectorPathScreenPoints.length >= 2 && (
            <Group
              name="active-vector-path-editable-handles"
              listening={vectorPathEditMode && !vectorExtendState && !activeNumberingGroup.locked && !vectorPathDrawMode && !groupOutlineDrawMode && !numberingPickMode && !editPointPickMode}
            >
              {activeVectorPathScreenPoints.slice(1).map((item, segmentOffset) => {
                const previous = activeVectorPathScreenPoints[segmentOffset];
                const selected = vectorSelectedSegmentIndex === segmentOffset;
                return (
                  <Line
                    key={`active-vector-segment-${segmentOffset}`}
                    points={[previous.screen.x, previous.screen.y, item.screen.x, item.screen.y]}
                    stroke={selected ? '#facc15' : '#22d3ee'}
                    strokeWidth={selected ? 4.4 : 2.6}
                    dash={[10, 5]}
                    opacity={vectorPathDrawMode ? 0.30 : 0.82}
                    lineCap="round"
                    lineJoin="round"
                    listening={vectorPathEditMode}
                    hitStrokeWidth={34}
                    onMouseDown={(event) => { event.cancelBubble = true; setVectorSelectedSegmentIndex(segmentOffset); setVectorSelectedIndex(null); }}
                    onClick={(event) => { event.cancelBubble = true; setVectorSelectedSegmentIndex(segmentOffset); setVectorSelectedIndex(null); }}
                    onDblClick={(event) => {
                      event.cancelBubble = true;
                      const pos = pointer();
                      if (pos) insertVectorPointFromScreen(segmentOffset, pos);
                    }}
                  />
                );
              })}
              {!vectorPathEditMode && (
                <Line
                  points={flattenPoints(activeVectorPathScreenPoints.map((item) => item.screen))}
                  stroke="#22d3ee"
                  strokeWidth={2.4}
                  dash={[10, 5]}
                  opacity={vectorPathDrawMode ? 0.30 : 0.74}
                  lineCap="round"
                  lineJoin="round"
                  listening={false}
                />
              )}
              {vectorPathEditMode && !vectorExtendState && vectorSelectedSegmentIndex != null && (() => {
                const segmentIndex = vectorSelectedSegmentIndex;
                if (segmentIndex == null) return null;
                const previous = activeVectorPathScreenPoints[segmentIndex];
                const next = activeVectorPathScreenPoints[segmentIndex + 1];
                if (!previous || !next) return null;
                const midScreen = { x: (previous.screen.x + next.screen.x) / 2, y: (previous.screen.y + next.screen.y) / 2 };
                const midWorld = { x: (previous.point.x + next.point.x) / 2, y: (previous.point.y + next.point.y) / 2 };
                return (
                  <Group
                    key="active-vector-segment-plus"
                    x={midScreen.x}
                    y={midScreen.y}
                    onMouseDown={(event) => { event.cancelBubble = true; }}
                    onClick={(event) => {
                      event.cancelBubble = true;
                      insertVectorPathPoint(activeNumberingGroup.id, segmentIndex + 1, midWorld);
                      setVectorSelectedIndex(segmentIndex + 1);
                      setVectorSelectedSegmentIndex(null);
                    }}
                  >
                    <Circle radius={10} fill="rgba(34,211,238,0.20)" stroke="#22d3ee" strokeWidth={2.2} shadowColor="#22d3ee" shadowBlur={8} shadowOpacity={0.36} />
                    <Text x={-4.5} y={-8.4} text="+" fill="#e0ffff" stroke="#020617" strokeWidth={1.6} fontSize={15} fontStyle="bold" />
                  </Group>
                );
              })()}
              {vectorPathEditMode && !vectorExtendState && activeVectorPathScreenPoints.length >= 2 && [activeVectorPathScreenPoints[0], activeVectorPathScreenPoints[activeVectorPathScreenPoints.length - 1]].map((item, endpointIndex) => {
                const label = endpointIndex === 0 ? 'продлить от старта' : 'продлить от финиша';
                return (
                  <Group
                    key={`active-vector-end-plus-${item.index}`}
                    x={item.screen.x}
                    y={item.screen.y - 22}
                    onMouseDown={(event) => { event.cancelBubble = true; }}
                    onClick={(event) => { event.cancelBubble = true; startVectorExtension(item.index); }}
                  >
                    <Circle radius={10.5} fill="rgba(34,211,238,0.22)" stroke="#22d3ee" strokeWidth={2.3} shadowColor="#22d3ee" shadowBlur={10} shadowOpacity={0.42} />
                    <Text x={-4.5} y={-8.7} text="+" fill="#ecfeff" stroke="#020617" strokeWidth={1.8} fontSize={15} fontStyle="bold" />
                    <Text x={14} y={-7} text={label} fill="#a5f3fc" stroke="#020617" strokeWidth={2} fontSize={10} fontStyle="bold" listening={false} />
                  </Group>
                );
              })}
              {vectorPathEditMode && activeVectorPathScreenPoints.map((item, pathIndex) => {
                const isEnd = pathIndex === 0 || pathIndex === activeVectorPathScreenPoints.length - 1;
                const selected = vectorSelectedIndex === item.index;
                return (
                  <Group key={`active-vector-handle-${item.index}`}>
                    <Circle
                      x={item.screen.x}
                      y={item.screen.y}
                      radius={selected ? 8 : isEnd ? 7 : 5.8}
                      fill={selected ? '#facc15' : isEnd ? '#22d3ee' : '#67e8f9'}
                      stroke="#020617"
                      strokeWidth={1.7}
                      opacity={0.98}
                      draggable={!activeNumberingGroup.locked && vectorPathEditMode && !vectorExtendState}
                      onMouseDown={(e) => { e.cancelBubble = true; setVectorSelectedIndex(item.index); setVectorSelectedSegmentIndex(null); }}
                      onClick={(e) => { e.cancelBubble = true; setVectorSelectedIndex(item.index); setVectorSelectedSegmentIndex(null); }}
                      onContextMenu={(e) => {
                        e.evt.preventDefault();
                        e.cancelBubble = true;
                        deleteVectorPathPoint(activeNumberingGroup.id, item.index);
                        setVectorSelectedIndex(null);
                      }}
                      onDragStart={(e) => { e.cancelBubble = true; pushHistory(); }}
                      onDragMove={(e) => {
                        e.cancelBubble = true;
                        updateActiveVectorHandle(item.index, { x: e.target.x(), y: e.target.y() });
                      }}
                      onDragEnd={(e) => {
                        e.cancelBubble = true;
                        updateActiveVectorHandle(item.index, { x: e.target.x(), y: e.target.y() }, true);
                      }}
                    />
                    <Text
                      x={item.screen.x + 8}
                      y={item.screen.y - 18}
                      text={isEnd ? (pathIndex === 0 ? 'V1' : `V${pathIndex + 1}`) : String(pathIndex + 1)}
                      fill="#a5f3fc"
                      stroke="#020617"
                      strokeWidth={2}
                      fontSize={10}
                      fontStyle="bold"
                      listening={false}
                    />
                  </Group>
                );
              })}
              {vectorPathEditMode && vectorExtendState && (() => {
                const base = worldToScreen(vectorExtendState.basePoint.x, vectorExtendState.basePoint.y);
                const draftScreens = vectorExtendState.draft.map((point) => worldToScreen(point.x, point.y)).filter(isFinitePoint);
                const pathScreens = [base, ...draftScreens].filter(isFinitePoint);
                const last = pathScreens[pathScreens.length - 1];
                return (
                  <Group listening={false}>
                    {pathScreens.length >= 2 && (
                      <Line points={flattenPoints(pathScreens)} stroke="#22d3ee" strokeWidth={3} dash={[10, 5]} opacity={0.96} lineCap="round" lineJoin="round" />
                    )}
                    {last && vectorExtendHoverPoint && isFinitePoint(vectorExtendHoverPoint.screen) && (
                      <Line points={[last.x, last.y, vectorExtendHoverPoint.screen.x, vectorExtendHoverPoint.screen.y]} stroke="#67e8f9" strokeWidth={2.6} dash={vectorExtendHoverPoint.kind === 'ortho' ? [3, 5] : [9, 5]} opacity={0.86} />
                    )}
                    {draftScreens.map((screen, index) => (
                      <Group key={`vector-extend-draft-${index}`}>
                        <Circle x={screen.x} y={screen.y} radius={5.2} fill="#67e8f9" stroke="#020617" strokeWidth={1.3} />
                        <Text x={screen.x + 8} y={screen.y - 15} text={`+${index + 1}`} fill="#a5f3fc" stroke="#020617" strokeWidth={2} fontSize={10} fontStyle="bold" />
                      </Group>
                    ))}
                    {vectorExtendHoverPoint && isFinitePoint(vectorExtendHoverPoint.screen) && (
                      <Circle x={vectorExtendHoverPoint.screen.x} y={vectorExtendHoverPoint.screen.y} radius={6} fill="rgba(34,211,238,0.18)" stroke="#22d3ee" strokeWidth={2} dash={[4, 3]} />
                    )}
                  </Group>
                );
              })()}
              {vectorPathEditMode && (
                <Text
                  x={18}
                  y={Math.max(14, height - 74)}
                  text={vectorExtendState ? "Продолжение вектора: ЛКМ — сегмент, Shift — ортогонально, Ctrl+Z — убрать сегмент, Enter — применить, Esc — отменить" : "Редактирование вектора: + у концов — продолжить, + на выбранном сегменте — вставить вершину, Delete/ПКМ — удалить"}
                  fill="rgba(165,243,252,0.78)"
                  stroke="#020617"
                  strokeWidth={2}
                  fontSize={11}
                  fontStyle="bold"
                  listening={false}
                />
              )}
            </Group>
          )}
        </Layer>

        <Layer>
          {groupOutlineDrawMode && (
            <Group>
              {groupOutlineDraft.length > 0 && (() => {
                const points = groupOutlineDraft.map((point) => worldToScreen(point.x, point.y)).filter(isFinitePoint);
                if (points.length === 0) return null;
                const flat = flattenPoints(points);
                return (
                  <>
                    {points.length >= 2 && (
                      <Line points={flat} stroke="#facc15" strokeWidth={2.2} dash={[9, 5]} opacity={0.95} listening={false} />
                    )}
                    {points.length >= 3 && (
                      <Line points={[...flat, points[0].x, points[0].y]} stroke="#facc15" strokeWidth={1.2} dash={[3, 7]} opacity={0.42} listening={false} />
                    )}
                    {points.map((point, index) => (
                      <Group key={index} listening={false}>
                        <Circle
                          x={point.x}
                          y={point.y}
                          radius={index === 0 ? 6 : 4.5}
                          fill={index === 0 ? '#22d3ee' : '#facc15'}
                          stroke={index === 0 ? '#e0f2fe' : '#020617'}
                          strokeWidth={index === 0 ? 1.6 : 1.1}
                          opacity={0.92}
                        />
                        {index > 0 && (
                          <Text
                            x={point.x + 6}
                            y={point.y - 12}
                            text={String(index + 1)}
                            fill="#cbd5e1"
                            fontSize={9}
                            opacity={0.45}
                          />
                        )}
                      </Group>
                    ))}
                    {groupOutlineHoverPoint && isFinitePoint(groupOutlineHoverPoint.screen) && (() => {
                      const last = points[points.length - 1];
                      const label = groupOutlineHoverPoint.kind === 'free'
                        ? 'свободно'
                        : groupOutlineHoverPoint.kind === 'ortho'
                          ? 'Shift ortho'
                          : groupOutlineHoverPoint.kind === 'point'
                            ? 'привязка к точке'
                            : groupOutlineHoverPoint.kind === 'vertex'
                              ? 'привязка к вершине'
                              : groupOutlineHoverPoint.kind === 'point_ortho'
                                ? 'точка + Shift'
                                : 'вершина + Shift';
                      return (
                        <Group listening={false}>
                          {last && isFinitePoint(last) && (
                            <Line
                              points={[last.x, last.y, groupOutlineHoverPoint.screen.x, groupOutlineHoverPoint.screen.y]}
                              stroke="#fde047"
                              strokeWidth={2}
                              dash={[7, 5]}
                              opacity={0.9}
                            />
                          )}
                          {groupOutlineHoverPoint.snapScreen && isFinitePoint(groupOutlineHoverPoint.snapScreen) && distance2(groupOutlineHoverPoint.snapScreen, groupOutlineHoverPoint.screen) > 9 && (
                            <>
                              <Circle x={groupOutlineHoverPoint.snapScreen.x} y={groupOutlineHoverPoint.snapScreen.y} radius={7} stroke="#38bdf8" strokeWidth={1.6} dash={[3, 3]} opacity={0.75} />
                              <Line points={[groupOutlineHoverPoint.snapScreen.x, groupOutlineHoverPoint.snapScreen.y, groupOutlineHoverPoint.screen.x, groupOutlineHoverPoint.screen.y]} stroke="#38bdf8" strokeWidth={1} dash={[3, 5]} opacity={0.45} />
                            </>
                          )}
                          <Circle
                            x={groupOutlineHoverPoint.screen.x}
                            y={groupOutlineHoverPoint.screen.y}
                            radius={6.5}
                            fill="rgba(250,204,21,0.20)"
                            stroke="#facc15"
                            strokeWidth={2}
                            dash={[4, 3]}
                          />
                          <Text
                            x={groupOutlineHoverPoint.screen.x + 10}
                            y={groupOutlineHoverPoint.screen.y - 18}
                            text={label}
                            fill="#fef08a"
                            stroke="#020617"
                            strokeWidth={2}
                            fontSize={11}
                            fontStyle="bold"
                          />
                        </Group>
                      );
                    })()}
                  </>
                );
              })()}
              <Text
                x={18}
                y={Math.max(14, height - 34)}
                text="Рисование контура: ЛКМ — подтвердить фантомную точку, Shift — ortho-привязка, Enter — замкнуть, Esc — отмена"
                fill="rgba(203,213,225,0.70)"
                stroke="transparent"
                strokeWidth={0}
                fontSize={12}
                fontStyle="normal"
                listening={false}
              />
            </Group>
          )}
        </Layer>

        <Layer>
          {vectorPathDrawMode && (
            <Group listening={false}>
              {vectorPathDraft.length > 0 && (() => {
                const points = vectorPathDraft.map((point) => worldToScreen(point.x, point.y)).filter(isFinitePoint);
                const flat = flattenPoints(points);
                const last = points[points.length - 1];
                return (
                  <>
                    {points.length >= 2 && (
                      <Line
                        points={flat}
                        stroke="#22d3ee"
                        strokeWidth={3}
                        dash={[10, 5]}
                        lineCap="round"
                        lineJoin="round"
                        opacity={0.92}
                      />
                    )}
                    {last && vectorHoverPoint && isFinitePoint(vectorHoverPoint.screen) && (
                      <Line
                        points={[last.x, last.y, vectorHoverPoint.screen.x, vectorHoverPoint.screen.y]}
                        stroke="#67e8f9"
                        strokeWidth={2.5}
                        dash={vectorHoverPoint.kind === 'ortho' ? [3, 5] : [9, 5]}
                        opacity={0.78}
                      />
                    )}
                    {points.map((point, index) => (
                      <Group key={`vector-draft-${index}`} listening={false}>
                        <Circle
                          x={point.x}
                          y={point.y}
                          radius={index === 0 ? 6 : 4.8}
                          fill={index === 0 ? '#22d3ee' : '#67e8f9'}
                          stroke="#020617"
                          strokeWidth={1.2}
                          opacity={0.94}
                        />
                        <Text
                          x={point.x + 8}
                          y={point.y - 15}
                          text={index === 0 ? 'старт линии' : `${index + 1}`}
                          fill="#a5f3fc"
                          stroke="#020617"
                          strokeWidth={2}
                          fontSize={10}
                          fontStyle="bold"
                        />
                      </Group>
                    ))}
                    {vectorHoverPoint && isFinitePoint(vectorHoverPoint.screen) && (
                      <Group listening={false}>
                        <Circle
                          x={vectorHoverPoint.screen.x}
                          y={vectorHoverPoint.screen.y}
                          radius={6}
                          fill="rgba(34,211,238,0.18)"
                          stroke="#22d3ee"
                          strokeWidth={2}
                          dash={[4, 3]}
                        />
                        <Text
                          x={vectorHoverPoint.screen.x + 9}
                          y={vectorHoverPoint.screen.y - 17}
                          text={vectorHoverPoint.kind === 'ortho' ? 'Shift ortho' : 'следующая вершина'}
                          fill="#a5f3fc"
                          stroke="#020617"
                          strokeWidth={2}
                          fontSize={10}
                          fontStyle="bold"
                        />
                      </Group>
                    )}
                  </>
                );
              })()}
              {vectorPathDraft.length === 0 && vectorHoverPoint && isFinitePoint(vectorHoverPoint.screen) && (
                <Circle x={vectorHoverPoint.screen.x} y={vectorHoverPoint.screen.y} radius={5.5} fill="rgba(34,211,238,0.16)" stroke="#22d3ee" strokeWidth={2} dash={[4, 3]} />
              )}
              <Text
                x={18}
                y={Math.max(14, height - 54)}
                text="Вектор: ЛКМ — добавить вершину/сегмент, Shift — ортогонально, Ctrl+Z — убрать последнюю вершину, Enter — применить, Esc — отменить"
                fill="rgba(165,243,252,0.88)"
                stroke="#020617"
                strokeWidth={2}
                fontSize={12}
                fontStyle="bold"
              />
            </Group>
          )}
        </Layer>

        <Layer>
          {numberingPreview.visible && project.viewSettings.showNumberingPreview !== false && previewPoints.length > 0 && (
            <Group>
              {previewSegments.map((segment) => (
                <Group
                  key={segment.key}
                  listening={previewSegmentsListening}
                  onMouseDown={(event) => selectPreviewSegment(event, segment.fromId, segment.toId)}
                  onTap={(event) => {
                    event.cancelBubble = true;
                    if (manualLinkClearMode) {
                      if (segment.manualLink) toggleManualLinkClearSelection(segment.key);
                      return;
                    }
                    if (activeNumberingGroup?.locked) return;
                    startNumberingManualLinkEdit(segment.fromId, segment.toId);
                  }}
                >
                  <Line
                    points={segment.linePoints}
                    stroke={segment.pendingClear ? (project.viewSettings.previewInvalidLinkColor || '#ef4444') : segment.selectedLink ? (project.viewSettings.previewSelectedLineColor || '#22d3ee') : segment.manualLink ? (project.viewSettings.previewManualLineColor || '#f59e0b') : (project.viewSettings.previewAutoLineColor || '#a78bfa')}
                    strokeWidth={(segment.pendingClear ? (project.viewSettings.previewSelectedLineWidth ?? 4.5) : segment.selectedLink ? (project.viewSettings.previewSelectedLineWidth ?? 4.5) : segment.manualLink ? (project.viewSettings.previewManualLineWidth ?? 4) : (project.viewSettings.previewLineWidth ?? 2)) + (hoverPreviewLines ? 0.8 : 0)}
                    opacity={hoverPreviewLines ? 1 : manualLinkClearMode ? (segment.pendingClear ? 1 : segment.manualLink ? 0.25 : 0.10) : focusedManualLink ? (segment.selectedLink ? 1 : segment.manualLink ? 0.42 : 0.16) : segment.manualLink ? 0.95 : 0.62}
                    hitStrokeWidth={18}
                  />
                  {segment.arrowPoints && (
                    <Line
                      points={segment.arrowPoints}
                      stroke={segment.pendingClear ? (project.viewSettings.previewInvalidLinkColor || '#ef4444') : segment.selectedLink ? (project.viewSettings.previewSelectedArrowColor || '#67e8f9') : segment.manualLink ? (project.viewSettings.previewManualArrowColor || '#facc15') : (project.viewSettings.previewAutoArrowColor || '#c4b5fd')}
                      strokeWidth={segment.selectedLink ? (project.viewSettings.previewSelectedLineWidth ?? 4.5) - 0.2 : segment.manualLink ? (project.viewSettings.previewManualLineWidth ?? 4) - 0.4 : (project.viewSettings.previewLineWidth ?? 2) + 0.3}
                      lineCap="round"
                      lineJoin="round"
                      opacity={manualLinkClearMode ? (segment.pendingClear ? 1 : segment.manualLink ? 0.32 : 0.10) : focusedManualLink ? (segment.selectedLink ? 1 : segment.manualLink ? 0.44 : 0.16) : 0.92}
                      hitStrokeWidth={18}
                    />
                  )}
                </Group>
              ))}
              {focusedManualLink && numberingLinkFromId && manualLinkDraft && (() => {
                const source = project.points.find((point) => point.id === numberingLinkFromId);
                if (!source) return null;
                const sourceSp = worldToScreen(source.x, source.y);
                if (!isFinitePoint(sourceSp) || !isFinitePoint(manualLinkDraft.screen)) return null;
                const color = manualLinkDraft.allowed
                  ? (project.viewSettings.previewSelectedLineColor || '#22d3ee')
                  : (project.viewSettings.previewInvalidLinkColor || '#ef4444');
                const draftArrow = buildArrowHead(sourceSp, manualLinkDraft.screen, 11);
                return (
                  <Group listening={false}>
                    <Line
                      points={[sourceSp.x, sourceSp.y, manualLinkDraft.screen.x, manualLinkDraft.screen.y]}
                      stroke={color}
                      strokeWidth={manualLinkDraft.targetId ? (project.viewSettings.previewSelectedLineWidth ?? 4.5) : 2.4}
                      opacity={manualLinkDraft.targetId ? 0.9 : 0.45}
                      dash={manualLinkDraft.allowed ? [1, 0] : [8, 6]}
                    />
                    {draftArrow && (
                      <Line
                        points={draftArrow}
                        stroke={color}
                        strokeWidth={(project.viewSettings.previewSelectedLineWidth ?? 4.5) - 0.2}
                        lineCap="round"
                        lineJoin="round"
                        opacity={0.95}
                      />
                    )}
                    <Text
                      x={manualLinkDraft.screen.x + 12}
                      y={manualLinkDraft.screen.y - 28}
                      text={manualLinkDraft.targetId ? (manualLinkDraft.allowed ? 'Новая конечная точка' : 'Назад нельзя') : 'Тяни к точке'}
                      fill={color}
                      stroke="#020617"
                      strokeWidth={1.2}
                      fontSize={12}
                      fontStyle="bold"
                    />
                  </Group>
                );
              })()}
              {!focusedManualLink && displayedPreviewPoints.map((p, index) => {
                const sp = worldToScreen(p.x, p.y);
                if (!isFinitePoint(sp)) return null;
                return (
                  <Group key={p.id}>
                    <Circle x={sp.x} y={sp.y} radius={10} stroke="#c4b5fd" strokeWidth={2} fill="rgba(124,58,237,0.16)" listening={false} />
                    {project.viewSettings.previewPointLabelBubbleEnabled !== false && (
                      <Rect
                        x={sp.x + 7}
                        y={sp.y + 7}
                        width={textWidth(String(index + 1), previewLabelFontSize) + 8}
                        height={previewLabelFontSize + 7}
                        fill={previewLabelBubble}
                        stroke={project.viewSettings.previewPointLabelStrokeColor || '#020617'}
                        strokeWidth={0.7}
                        cornerRadius={4}
                        listening={false}
                      />
                    )}
                    <Text
                      x={sp.x + 10}
                      y={sp.y + 10}
                      text={String(index + 1)}
                      fill={previewLabelFill}
                      stroke={project.viewSettings.previewPointLabelStrokeColor || "#020617"}
                      strokeWidth={previewLabelStrokeWidth + (hoverPathNumbers ? 0.7 : 0)}
                      fontSize={previewLabelFontSize + (hoverPathNumbers ? 2 : 0)}
                      fontStyle="bold"
                      listening={false}
                    />
                  </Group>
                );
              })}
            </Group>
          )}
        </Layer>

        <Layer>
          {project.points.map((p) => {
            const sp = worldToScreen(p.x, p.y);
            const group = project.groups.find((g) => g.id === p.groupId);
            const fill = group?.color || '#d1d5db';
            const selected = selectedPointIds.includes(p.id);
            const focusedPoint = focusedPointIds.has(p.id);
            const unnumbered = p.number == null || p.number === undefined;
            const vectorWorkMode = vectorPathDrawMode || vectorPathEditMode || Boolean(vectorExtendState);
            const pointOpacity = manualLinkClearMode
              ? (manualLinkClearPointIds.has(p.id) ? 1 : 0.18)
              : vectorWorkMode
                ? (selected ? 0.78 : 0.34)
                : project.viewSettings.highlightUnnumbered
                  ? (unnumbered || selected ? 1 : 0.12)
                  : focusedManualLink && !focusedPoint ? 0.22 : 1;
            const propertySource = propertySourcePointId === p.id;
            const copyBase = copyBasePointId === p.id;
            const numberingStart = effectiveNumberingStartPointId === p.id;
            const numberingEnd = effectiveNumberingEndPointId === p.id;
            const numberingStartAuto = !numberingStartPointId && numberingStart;
            const numberingEndAuto = !numberingEndPointId && numberingEnd;
            const syncStroke = p.syncState === 'added' ? '#22c55e' : p.syncState === 'moved' ? '#eab308' : p.syncState === 'deleted' ? '#ef4444' : '#020617';
            const label = p.number != null ? String(p.number) : '';
            const fontSize = numberFontSize;
            const bubbleWidth = textWidth(label, fontSize) + 10;
            const bubbleHeight = fontSize + 7;
            const defaultLabelX = sp.x + 8;
            const defaultLabelY = sp.y - bubbleHeight / 2;
            const numberLabelOffset = readMetaOffset(p.meta, 'numberLabelOffset');
            const numberLabelScreenOffset = { x: numberLabelOffset.x * zoom, y: -numberLabelOffset.y * zoom };
            const labelX = defaultLabelX + numberLabelScreenOffset.x;
            const labelY = defaultLabelY + numberLabelScreenOffset.y;
            const numberLabelShifted = Math.abs(numberLabelScreenOffset.x) > 0.5 || Math.abs(numberLabelScreenOffset.y) > 0.5;
            const numberLabelDraggable = selected && selectedPointIds.length === 1 && !p.locked && !group?.locked;
            return (
              <Group key={p.id} opacity={pointOpacity} onMouseDown={(e) => onPointMouseDown(e, p.id)} onClick={(e) => onPointClick(e, p.id)} onDblClick={(e) => onPointDblClick(e, p.id)} onTap={(e) => onPointClick(e as any, p.id)}>
                {numberingStart && (
                  <Group>
                    <Circle x={sp.x} y={sp.y} radius={hoverMarkers ? 22 : 18} fill="rgba(34,211,238,0.14)" stroke="#22d3ee" strokeWidth={hoverMarkers ? 4 : 3} dash={[5, 4]} listening={false} />
                    {renderMarkerCallout({
                      keyId: 'start',
                      pointId: p.id,
                      point: sp,
                      text: numberingStartAuto ? 'Старт авто' : 'Старт вручную',
                      color: '#22d3ee',
                      baseDx: 18,
                      baseDy: -58
                    })}
                  </Group>
                )}
                {numberingEnd && (
                  <Group>
                    <Circle x={sp.x} y={sp.y} radius={hoverMarkers ? 23 : 19} fill="rgba(251,146,60,0.13)" stroke="#fb923c" strokeWidth={hoverMarkers ? 4 : 3} dash={[5, 4]} listening={false} />
                    {renderMarkerCallout({
                      keyId: 'end',
                      pointId: p.id,
                      point: sp,
                      text: numberingEndAuto ? 'Финиш авто' : 'Финиш вручную',
                      color: '#fb923c',
                      baseDx: 18,
                      baseDy: -88
                    })}
                  </Group>
                )}
                {copyBase && (
                  <Group listening={false}>
                    <Circle
                      x={sp.x}
                      y={sp.y}
                      radius={15}
                      fill="rgba(59,130,246,0.16)"
                      stroke="#60a5fa"
                      strokeWidth={3}
                      dash={[8, 4]}
                    />
                    <Text
                      x={sp.x + 14}
                      y={sp.y - 24}
                      text="База"
                      fill={markerFill}
                      stroke={markerStroke}
                      strokeWidth={markerStrokeWidth}
                      fontSize={markerFontSize}
                      fontFamily={markerFontFamily}
                      visible={markerLabelsVisible}
                      fontStyle="bold"
                    />
                  </Group>
                )}
                {propertySource && (
                  <Group listening={false}>
                    <Circle
                      x={sp.x}
                      y={sp.y}
                      radius={17}
                      fill="rgba(34,197,94,0.16)"
                      stroke="#22c55e"
                      strokeWidth={3}
                      dash={[8, 4]}
                    />
                    <Text
                      x={sp.x + 14}
                      y={sp.y - 38}
                      text="Источник"
                      fill={markerFill}
                      stroke={markerStroke}
                      strokeWidth={markerStrokeWidth}
                      fontSize={markerFontSize}
                      fontFamily={markerFontFamily}
                      visible={markerLabelsVisible}
                      fontStyle="bold"
                    />
                  </Group>
                )}
                {project.viewSettings.highlightUnnumbered && unnumbered && (
                  <Circle
                    x={sp.x}
                    y={sp.y}
                    radius={11}
                    fill="rgba(239,68,68,0.16)"
                    stroke="#f97316"
                    strokeWidth={2}
                    dash={[5, 4]}
                    listening={false}
                  />
                )}
                <Circle
                  x={sp.x}
                  y={sp.y}
                  radius={selected ? 7 : 5}
                  fill={fill}
                  stroke={selected ? '#facc15' : unnumbered && project.viewSettings.highlightUnnumbered ? '#f97316' : syncStroke}
                  strokeWidth={selected ? 3 : unnumbered && project.viewSettings.highlightUnnumbered ? 2 : 1}
                />
                {p.manualNumber && (
                  <Group listening={false}>
                    <Circle x={sp.x - 8} y={sp.y - 8} radius={5.5} fill="#facc15" stroke="#020617" strokeWidth={1} />
                    <Text x={sp.x - 11} y={sp.y - 13} text="M" fill="#020617" fontSize={8} fontStyle="bold" />
                  </Group>
                )}
                {project.viewSettings.showPointNumbers && label && (
                  <Group>
                    {numberLabelShifted && (
                      <Line
                        points={[sp.x, sp.y, labelX, labelY + bubbleHeight / 2]}
                        stroke={project.viewSettings.markerLeaderLineColor || (numberText.stroke === 'transparent' ? numberText.fill : numberText.stroke)}
                        strokeWidth={1}
                        dash={[4, 4]}
                        opacity={0.58}
                        listening={false}
                      />
                    )}
                    <Group
                      x={labelX}
                      y={labelY}
                      draggable={numberLabelDraggable}
                      listening={numberLabelDraggable}
                      onMouseDown={(event) => { event.cancelBubble = true; }}
                      onClick={(event) => { event.cancelBubble = true; }}
                      onDragMove={(event) => { event.cancelBubble = true; }}
                      onDragEnd={(event) => updatePointNumberLabelOffset(p.id, { x: (event.target.x() - defaultLabelX) / Math.max(zoom, 1e-9), y: -(event.target.y() - defaultLabelY) / Math.max(zoom, 1e-9) })}
                    >
                      <Rect
                        x={-3}
                        y={-1}
                        width={bubbleWidth}
                        height={bubbleHeight}
                        fill={numberText.bubble}
                        stroke={numberLabelDraggable ? '#38bdf8' : numberText.bubbleStroke}
                        strokeWidth={numberLabelDraggable || hoverNumbers ? 1.4 : 0.8}
                        cornerRadius={4}
                        listening={numberLabelDraggable}
                        hitStrokeWidth={12}
                      />
                      <Text
                        x={2}
                        y={2}
                        text={label}
                        fill={numberText.fill}
                        stroke={numberText.stroke}
                        strokeWidth={numberStrokeWidth + (hoverNumbers ? 0.5 : 0)}
                        fontSize={fontSize + (hoverNumbers ? 2 : 0)}
                        fontFamily={numberFontFamily}
                        fontStyle="bold"
                        listening={false}
                      />
                    </Group>
                  </Group>
                )}
              </Group>
            );
          })}
        </Layer>

        <Layer listening={false}>
          {selectionRect && selectionRect.w > 2 && selectionRect.h > 2 && selectionStyle && (
            <Group>
              <Rect
                x={selectionRect.x}
                y={selectionRect.y}
                width={selectionRect.w}
                height={selectionRect.h}
                stroke={selectionStyle.stroke}
                fill={selectionStyle.fill}
                dash={selectionStyle.dash}
                strokeWidth={1.6}
              />
              <Text
                x={selectionRect.x + 8}
                y={selectionRect.y + 8}
                text={selectionStyle.label}
                fill={selectionStyle.stroke}
                fontSize={12}
                fontStyle="bold"
              />
            </Group>
          )}
        </Layer>
      </Stage>
      {pointEditDialog && (() => {
        const point = project.points.find((p) => p.id === pointEditDialog.pointId);
        const group = point?.groupId ? project.groups.find((g) => g.id === point.groupId) : null;
        if (!point || point.locked || group?.locked) return null;
        const screen = worldToScreen(point.x, point.y);
        const left = Math.min(Math.max(screen.x + 18, 16), Math.max(16, width - 286));
        const top = Math.min(Math.max(screen.y - 18, 16), Math.max(16, height - 182));
        const save = () => {
          const value = Number(pointEditDialog.value.trim().replace(',', '.'));
          if (!Number.isFinite(value)) return;
          setPointManualNumber(point.id, Math.round(value));
          setPointEditDialog(null);
        };
        return (
          <div className="point-edit-popover" style={{ left, top }} onMouseDown={(event) => event.stopPropagation()}>
            <div className="point-edit-title">Точка {point.number ?? point.sourceNumber ?? ''}</div>
            <label className="point-edit-field">
              Ручной номер
              <input
                autoFocus
                value={pointEditDialog.value}
                onChange={(event) => setPointEditDialog({ pointId: point.id, value: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') save();
                  if (event.key === 'Escape') setPointEditDialog(null);
                }}
              />
            </label>
            <div className="point-edit-actions">
              <button className="btn small" onClick={save}>Сохранить</button>
              <button className="btn small" disabled={!point.manualNumber} onClick={() => { clearPointManualNumber(point.id); setPointEditDialog(null); }}>Снять ручной</button>
              <button className="btn small" onClick={() => updatePointNumberLabelOffset(point.id, null)}>Сбросить вынос</button>
              <button className="btn small" onClick={() => setPointEditDialog(null)}>Закрыть</button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}



