// Mirrored by backend/app/project_limits.py. The transport has room for the
// autosave envelope and normalization of project metadata.
export const MAX_PROJECT_POINTS = 100_000;
export const MAX_PROJECT_JSON_BYTES = 64_000_000;

export function assertProjectPointLimit(count: number): void {
  if (count > MAX_PROJECT_POINTS) throw new Error('В проекте может быть не больше 100 000 точек. Разделите данные на несколько проектов.');
}

export function assertProjectJsonSize(json: string): void {
  if (new Blob([json]).size > MAX_PROJECT_JSON_BYTES) {
    throw new Error('Проект превышает 64 МБ в JSON. Разделите данные на несколько проектов.');
  }
}

export function assertProjectCapacity(project: { points?: unknown[] }): void {
  assertProjectPointLimit(project.points?.length ?? 0);
  assertProjectJsonSize(JSON.stringify(project));
}
