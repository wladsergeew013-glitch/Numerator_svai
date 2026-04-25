import { useMemo, useRef, useState } from 'react';
import { Circle, Group, Layer, Line, Rect, Stage, Text } from 'react-konva';
import { KonvaEventObject } from 'konva/lib/Node';
import { useProjectStore } from '../store/useProjectStore';

interface Props {
  width: number;
  height: number;
  onPointerUpdate: (x: number, y: number) => void;
}

export function CanvasView({ width, height, onPointerUpdate }: Props) {
  const stageRef = useRef<any>(null);
  const { project, selectedPointIds, setSelection, updateView } = useProjectStore();
  const [selectionRect, setSelectionRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);

  const { zoom, panX, panY } = project.viewSettings;

  const worldToLayer = (x: number, y: number) => ({ x: x * zoom, y: -y * zoom });
  const screenToWorld = (x: number, y: number) => ({ x: (x - panX) / zoom, y: -(y - panY) / zoom });

  const gridLines = useMemo(() => {
    if (!project.gridSettings.enabled) return [];
    const lines = [] as Array<{ points: number[] }>;
    const step = project.gridSettings.spacing * zoom;
    if (step < 8) return lines;

    const startX = (-panX % step) - step;
    const startY = (-panY % step) - step;

    for (let x = startX; x < width; x += step) lines.push({ points: [x, -height * 2, x, height * 2] });
    for (let y = startY; y < height; y += step) lines.push({ points: [-width * 2, y, width * 2, y] });
    return lines;
  }, [project.gridSettings.enabled, project.gridSettings.spacing, zoom, panX, panY, width, height]);

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const scaleBy = 1.1;
    const oldScale = zoom;
    const newScale = e.evt.deltaY > 0 ? oldScale / scaleBy : oldScale * scaleBy;
    const world = screenToWorld(pointer.x, pointer.y);
    const clamped = Math.max(0.05, Math.min(newScale, 100));
    const newPanX = pointer.x - world.x * clamped;
    const newPanY = pointer.y + world.y * clamped;
    updateView(clamped, newPanX, newPanY);
  };

  const zoomExtents = () => {
    if (!project.points.length) return;
    const xs = project.points.map((p) => p.x);
    const ys = project.points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const contentW = maxX - minX || 1;
    const contentH = maxY - minY || 1;
    const fitZoom = Math.min((width * 0.8) / contentW, (height * 0.8) / contentH);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    updateView(fitZoom, width / 2 - centerX * fitZoom, height / 2 + centerY * fitZoom);
  };

  const onMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0) return;
    const stage = stageRef.current;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    setDragStart(pointer);
    setSelectionRect({ x: pointer.x, y: pointer.y, w: 0, h: 0 });
  };

  const onMouseMove = () => {
    const stage = stageRef.current;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const world = screenToWorld(pointer.x, pointer.y);
    onPointerUpdate(world.x, world.y);

    if (dragStart) {
      setSelectionRect({
        x: Math.min(dragStart.x, pointer.x),
        y: Math.min(dragStart.y, pointer.y),
        w: Math.abs(pointer.x - dragStart.x),
        h: Math.abs(pointer.y - dragStart.y)
      });
    }
  };

  const onMouseUp = () => {
    if (!selectionRect) return;
    const x1 = selectionRect.x;
    const y1 = selectionRect.y;
    const x2 = selectionRect.x + selectionRect.w;
    const y2 = selectionRect.y + selectionRect.h;
    const ids = project.points
      .filter((p) => {
        const sp = { x: p.x * zoom + panX, y: -p.y * zoom + panY };
        return sp.x >= x1 && sp.x <= x2 && sp.y >= y1 && sp.y <= y2;
      })
      .map((p) => p.id);
    setSelection(ids);
    setSelectionRect(null);
    setDragStart(null);
  };

  return (
    <div className="canvas-wrap">
      <button className="btn zoom-extents" onClick={zoomExtents}>Zoom extents</button>
      <Stage
        ref={stageRef}
        width={width}
        height={height}
        x={panX}
        y={panY}
        draggable
        onDragMove={(e) => updateView(zoom, e.target.x(), e.target.y())}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        style={{ background: project.viewSettings.backgroundColor }}
      >
        <Layer>
          {gridLines.map((l, idx) => <Line key={idx} points={l.points} stroke={project.gridSettings.color} strokeWidth={0.5} />)}
          {project.points.map((p) => {
            const sp = worldToLayer(p.x, p.y);
            const group = project.groups.find((g) => g.id === p.groupId);
            const fill = group?.color || '#dddddd';
            const selected = selectedPointIds.includes(p.id);
            return (
              <Group key={p.id}>
                <Circle x={sp.x} y={sp.y} radius={5} fill={fill} stroke={selected ? '#ffcc00' : '#000'} strokeWidth={selected ? 2 : 1} />
                <Text x={sp.x + 8} y={sp.y - 8} text={p.number || ''} fill="#ffffff" fontSize={12} />
              </Group>
            );
          })}
          {selectionRect && <Rect x={selectionRect.x - panX} y={selectionRect.y - panY} width={selectionRect.w} height={selectionRect.h} stroke="#66aaff" dash={[4, 4]} />}
        </Layer>
      </Stage>
    </div>
  );
}
