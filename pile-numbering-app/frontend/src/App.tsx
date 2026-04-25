import { useEffect, useState } from 'react';
import { CanvasView } from './components/CanvasView';
import { GroupManager } from './components/GroupManager';
import { StatusBar } from './components/StatusBar';
import { Toolbar } from './components/Toolbar';
import { useProjectStore } from './store/useProjectStore';
import './styles.css';

export default function App() {
  const { setPoints, project } = useProjectStore();
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const importCsv = async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch('http://localhost:8000/api/import/csv', { method: 'POST', body: formData });
    const data = await response.json();
    setPoints(data.points);
  };

  return (
    <div className="app">
      <Toolbar onCsvImport={importCsv} />
      <div className="workspace">
        <GroupManager />
        <CanvasView width={size.w - 260} height={size.h - 90} onPointerUpdate={(x, y) => setPointer({ x, y })} />
      </div>
      <StatusBar x={pointer.x} y={pointer.y} zoom={project.viewSettings.zoom} pointsCount={project.points.length} />
    </div>
  );
}
