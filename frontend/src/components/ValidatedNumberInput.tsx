import { useEffect, useState } from 'react';
import { parseSafeInteger } from '../utils/validation';

export function ValidatedNumberInput({ value, onCommit, integer = false, positive = false, disabled = false, label }: {
  value: number; onCommit: (value: number) => void; integer?: boolean; positive?: boolean; disabled?: boolean; label: string;
}) {
  const [text, setText] = useState(String(value)), [error, setError] = useState('');
  useEffect(() => { setText(String(value)); setError(''); }, [value]);
  const commit = () => {
    try {
      const result = integer ? parseSafeInteger(text) : (text.trim() ? Number(text.replace(',', '.')) : NaN);
      if (!Number.isFinite(result) || (positive && result <= 0)) throw new Error('Введите конечное положительное число.');
      onCommit(result); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return <span><input aria-label={label} aria-invalid={Boolean(error)} value={text} disabled={disabled}
    onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
    {error && <small role="alert" style={{ color: '#fca5a5' }}>{error}</small>}</span>;
}
