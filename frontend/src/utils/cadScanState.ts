import type { NanoCadBlockSummary, NanoCadModelStudioObjectSummary } from '../api/client';

export type CadScanScope = 'auto' | 'selection' | 'all';

export function cadScanReady(id: string | null, scannedAt: number | null, scannedScope: CadScanScope | null, scope: CadScanScope, count: number, now = Date.now()) {
  return Boolean(id && scannedAt != null && now - scannedAt < 600_000 && scannedScope === scope && count > 0);
}

export function modelStudioScanSelection(objects: NanoCadModelStudioObjectSummary[], previousNames: string[], previousParameters: Record<string, string>) {
  const available = objects.filter(obj => (obj.coordinateCount ?? obj.count) > 0).map(obj => obj.name);
  const kept = previousNames.filter(name => available.includes(name));
  const names = kept.length ? kept : available;
  const parameters = Object.fromEntries(objects.map(obj => {
    const previous = previousParameters[obj.name];
    const parameter = previous === '' || obj.parameters.some(item => item.name === previous) ? previous
      : obj.numberParameterCandidates.find(name => name.toUpperCase() === 'GPP_PILE_NUMBER')
        || obj.numberParameterCandidates[0] || '';
    return [obj.name, parameter];
  }));
  return { names, parameters, primary: names[0] || objects[0]?.name || '' };
}

export function blockScanSelection(blocks: NanoCadBlockSummary[], previousName: string, previousAttribute: string) {
  const block = blocks.find(item => item.name === previousName) ?? blocks[0];
  const attribute = block?.attributes.some(item => item.tag === previousAttribute) ? previousAttribute
    : block?.numberAttributeCandidates[0] || block?.attributes[0]?.tag || '';
  return { name: block?.name || '', attribute };
}
