import { workerTask } from './workerTask';
import type { PilePoint } from '../types/project';
export function connectedClustersAsync(points: PilePoint[], factor: number, signal?: AbortSignal): Promise<string[][]> {
  return workerTask(new Worker(new URL('../workers/cluster.worker.ts', import.meta.url), { type: 'module' }), { points, factor }, signal, 120000);
}
