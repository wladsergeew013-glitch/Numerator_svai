// Serialize the actual writes, not just their response handlers. This queue is
// shared by HTTP saves, transition saves and native JSON exports.
const pending = new Map<string, Promise<unknown>>();

export function queueProjectSave<T>(projectId: string, write: () => Promise<T>): Promise<T> {
  const operation = (pending.get(projectId) ?? Promise.resolve()).then(write);
  const tail = operation.then(() => undefined, () => undefined);
  pending.set(projectId, tail);
  void tail.then(() => { if (pending.get(projectId) === tail) pending.delete(projectId); });
  return operation;
}
