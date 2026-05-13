import { useEffect, useState } from 'react';

interface TooltipState {
  text: string;
  left: number;
  top: number;
  placement: 'top' | 'bottom';
  width: number;
}

function findTooltipTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.closest('[data-tooltip]') as HTMLElement | null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function CadTooltip() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  useEffect(() => {
    let timer: number | null = null;

    const hide = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = null;
      setTooltip(null);
    };

    const show = (target: HTMLElement) => {
      const text = target.dataset.tooltip;
      if (!text) return;
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const rect = target.getBoundingClientRect();
        const width = Math.min(360, Math.max(240, Math.min(text.length * 5.4, 360)));
        const left = clamp(rect.left + rect.width / 2 - width / 2, 8, window.innerWidth - width - 8);
        const belowSpace = window.innerHeight - rect.bottom;
        const placement: 'top' | 'bottom' = belowSpace < 150 && rect.top > belowSpace ? 'top' : 'bottom';
        const top = placement === 'bottom' ? rect.bottom + 10 : rect.top - 10;
        setTooltip({ text, left, top, placement, width });
      }, 350);
    };

    const onMouseOver = (event: MouseEvent) => {
      const target = findTooltipTarget(event.target);
      if (target) show(target);
    };

    const onMouseOut = (event: MouseEvent) => {
      const target = findTooltipTarget(event.target);
      if (!target) return;
      const related = event.relatedTarget;
      if (related instanceof Node && target.contains(related)) return;
      hide();
    };

    const onScrollOrClick = () => hide();

    document.addEventListener('mouseover', onMouseOver);
    document.addEventListener('mouseout', onMouseOut);
    document.addEventListener('mousedown', onScrollOrClick, true);
    document.addEventListener('wheel', onScrollOrClick, true);
    window.addEventListener('resize', onScrollOrClick);

    return () => {
      hide();
      document.removeEventListener('mouseover', onMouseOver);
      document.removeEventListener('mouseout', onMouseOut);
      document.removeEventListener('mousedown', onScrollOrClick, true);
      document.removeEventListener('wheel', onScrollOrClick, true);
      window.removeEventListener('resize', onScrollOrClick);
    };
  }, []);

  if (!tooltip) return null;

  return (
    <div
      className={`cad-tooltip cad-tooltip-${tooltip.placement}`}
      style={{ left: tooltip.left, top: tooltip.top, width: tooltip.width }}
    >
      {tooltip.text.split('\n').map((line, index) => (
        <div key={index} className={index === 0 ? 'cad-tooltip-title' : 'cad-tooltip-line'}>{line}</div>
      ))}
    </div>
  );
}
