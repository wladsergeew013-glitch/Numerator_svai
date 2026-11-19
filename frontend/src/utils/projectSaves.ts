// Serialize the actual writes, not just their response handlers. This queue is
// shared by HTTP saves, transition saves and native JSON exports.
const pending = new Map<string, Promise<unknown>>();
let saveGeneration = 0;

export function projectSaveGeneration(): number {
  return saveGeneration;
}

export function hasPendingProjectSaves(projectId: string): boolean {
  return pending.has(projectId);
}

export async function waitForProjectSaves(projectId: string): Promise<void> {
  let tail = pending.get(projectId);
  while (tail) {
    await tail;
    tail = pending.get(projectId);
  }
}

export function queueProjectSave<T>(projectId: string, write: () => Promise<T>): Promise<T> {
  saveGeneration += 1;
  const operation = (pending.get(projectId) ?? Promise.resolve()).then(write);
  const tail = operation.then(() => undefined, () => undefined);
  pending.set(projectId, tail);
  void tail.then(() => { if (pending.get(projectId) === tail) pending.delete(projectId); });
  return operation;
}
