export function changedFields(current: Record<string, any>, previous: Record<string, any>): Record<string, any> {
  const patch: Record<string, any> = {};
  for (const key of Object.keys(current)) {
    const value = current[key], before = previous[key];
    if (value && before && typeof value === 'object' && typeof before === 'object' && !Array.isArray(value)) {
      const child = changedFields(value, before);
      if (Object.keys(child).length) patch[key] = child;
    } else if (JSON.stringify(value) !== JSON.stringify(before)) patch[key] = value;
  }
  return patch;
}

export function mergePatch(first: Record<string, any>, second: Record<string, any>): Record<string, any> {
  const result = { ...first };
  for (const [key, value] of Object.entries(second)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergePatch(result[key] ?? {}, value) : value;
  }
  return result;
}
