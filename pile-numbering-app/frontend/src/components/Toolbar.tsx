import { ChangeEvent } from 'react';
import { useProjectStore } from '../store/useProjectStore';
import { PileProject } from '../types/project';

interface Props {
  onCsvImport: (file: File) => void;
}

export function Toolbar({ onCsvImport }: Props) {
  const { toggleGrid, setBackground, project, setProject, applyRowsNumbering, assignSelectionToGroup } = useProjectStore();

  const saveProject = () => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name || 'project'}.pilenum.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openProject = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((text) => {
      const parsed = JSON.parse(text) as PileProject;
      setProject(parsed);
    });
  };

  return (
    <div className="toolbar">
      <label className="btn">
        CSV импорт
        <input type="file" accept=".csv" hidden onChange={(e) => e.target.files?.[0] && onCsvImport(e.target.files[0])} />
      </label>
      <label className="btn">
        Открыть .pilenum.json
        <input type="file" accept=".json,.pilenum.json" hidden onChange={openProject} />
      </label>
      <button className="btn" onClick={saveProject}>Сохранить .pilenum.json</button>
      <button className="btn" onClick={toggleGrid}>Сетка on/off</button>
      <button className="btn" onClick={assignSelectionToGroup}>Назначить в группу</button>
      <button className="btn" onClick={() => void applyRowsNumbering()}>Нумерация rows</button>
      <label className="color-pick">
        Фон
        <input type="color" value={project.viewSettings.backgroundColor} onChange={(e) => setBackground(e.target.value)} />
      </label>
    </div>
  );
}
