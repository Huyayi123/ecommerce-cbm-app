import { useEffect, useMemo, useRef, useState } from 'react';

type Props = {
  startDate: string;
  endDate: string;
  maxDate: string;
  onChange: (startDate: string, endDate: string) => void;
};

function dateText(date: Date): string { return date.toISOString().slice(0, 10); }
function monthText(date: Date): string { return date.toISOString().slice(0, 7); }
function parseDate(value: string): Date { return new Date(`${value}T00:00:00Z`); }

export function DateRangePicker({ startDate, endDate, maxDate, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => (startDate || maxDate).slice(0, 7));
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const days = useMemo(() => {
    const [year, month] = visibleMonth.split('-').map(Number);
    const first = new Date(Date.UTC(year, month - 1, 1));
    const gridStart = new Date(first);
    gridStart.setUTCDate(1 - first.getUTCDay());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart);
      date.setUTCDate(gridStart.getUTCDate() + index);
      return { value: dateText(date), day: date.getUTCDate(), inMonth: monthText(date) === visibleMonth };
    });
  }, [visibleMonth]);

  function select(value: string) {
    if (value > maxDate) return;
    if (!startDate || endDate || value.slice(0, 7) !== startDate.slice(0, 7) || value < startDate) onChange(value, '');
    else { onChange(startDate, value); setOpen(false); }
  }

  function moveMonth(offset: number) {
    const date = parseDate(`${visibleMonth}-01`);
    date.setUTCMonth(date.getUTCMonth() + offset);
    setVisibleMonth(monthText(date));
  }

  const label = startDate ? `${startDate}${endDate ? ` 至 ${endDate}` : ' 至 请选择结束日期'}` : '请选择开始和结束日期';
  return <div className="date-range-picker" ref={rootRef}>
    <button type="button" className="date-range-trigger" onClick={() => { setVisibleMonth((startDate || maxDate).slice(0, 7)); setOpen((value) => !value); }}>{label}<span>▣</span></button>
    {open && <div className="date-range-popover">
      <div className="date-range-month-nav"><button type="button" onClick={() => moveMonth(-1)}>‹</button><strong>{visibleMonth}</strong><button type="button" disabled={visibleMonth >= maxDate.slice(0, 7)} onClick={() => moveMonth(1)}>›</button></div>
      <div className="date-range-weekdays">{['日', '一', '二', '三', '四', '五', '六'].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="date-range-days">{days.map((item) => {
        const disabled = !item.inMonth || item.value > maxDate || Boolean(startDate && !endDate && item.value.slice(0, 7) === startDate.slice(0, 7) && item.value < startDate);
        const selected = item.value === startDate || item.value === endDate;
        const inRange = Boolean(startDate && endDate && item.value > startDate && item.value < endDate);
        return <button type="button" key={item.value} disabled={disabled} className={`${selected ? 'selected' : ''} ${inRange ? 'in-range' : ''}`} onClick={() => select(item.value)}>{item.day}</button>;
      })}</div>
    </div>}
  </div>;
}
