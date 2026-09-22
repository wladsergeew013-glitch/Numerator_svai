import type { NumberingMethod } from '../types/project';

/** Schematic examples; coordinates follow the CAD convention (Y points up). */
export function NumberingMethodPreview({ method }: { method: NumberingMethod }) {
  const dots = method === 'route' ? [[20, 16], [46, 12], [79, 23], [27, 42], [53, 36], [88, 48]]
    : [[22, 20], [52, 20], [82, 20], [22, 44], [52, 44], [82, 44]];
  const order = method === 'columns' ? [0, 3, 4, 1, 2, 5]
    : method === 'vector' ? [3, 0, 1, 4, 5, 2]
      : method === 'route' ? [0, 3, 4, 1, 2, 5] : [0, 1, 2, 3, 4, 5];
  return <svg viewBox="0 0 108 70" aria-hidden="true" className="numbering-method-preview">
    <path d="M10 50 V8 M7 12 L10 8 L13 12 M10 58 H98 M94 55 L98 58 L94 61" fill="none" stroke="currentColor" opacity=".35" />
    <text x="2" y="7">Y</text><text x="99" y="63">X</text>
    {method === 'vector' && <path d="M14 48 L24 12 L60 13 L62 49 L94 47 L93 13" stroke="#d18a29" strokeWidth="3" opacity=".65" fill="none" />}
    <polyline points={order.map(i => dots[i].join(',')).join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={method === 'rows' ? '3 2' : undefined} />
    {dots.map(([x, y], i) => <g key={i}><circle cx={x} cy={y} r="7" fill="var(--method-dot, #fff)" stroke="currentColor" /><text x={x} y={y + 3} textAnchor="middle" fill="currentColor">{order.indexOf(i) + 1}</text></g>)}
  </svg>;
}
