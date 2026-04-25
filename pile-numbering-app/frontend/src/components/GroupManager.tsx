import { useProjectStore } from '../store/useProjectStore';

export function GroupManager() {
  const { project, selectedGroupId, setSelectedGroup, createGroup, deleteGroup, updateGroupColor } = useProjectStore();

  return (
    <aside className="group-manager">
      <div className="panel-head">
        <strong>Диспетчер групп</strong>
        <button className="btn small" onClick={createGroup}>+</button>
      </div>
      {project.groups.map((g) => (
        <div key={g.id} className={`group-item ${selectedGroupId === g.id ? 'active' : ''}`}>
          <button className="group-select" onClick={() => setSelectedGroup(g.id)}>{g.name}</button>
          <input type="color" value={g.color} onChange={(e) => updateGroupColor(g.id, e.target.value)} />
          <button className="btn small danger" onClick={() => deleteGroup(g.id)}>x</button>
        </div>
      ))}
    </aside>
  );
}
