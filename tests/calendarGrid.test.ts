import { describe, expect, it } from 'vitest';
import type { CalendarEvent, Task } from '../src/domain/types';
import { itemsByDay, monthCells, shiftMonth } from '../src/ui/calendarGrid';

const base = { owner_id: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', deleted_at: null, version: 1, project_id: null, category_id: null, description: '' };

describe('월간 달력 칸', () => {
  it('월요일 시작, 그 달을 모두 덮는 주 단위 칸을 만든다', () => {
    const c = monthCells('2026-10'); // 10/1 은 목요일, 10/31 은 토요일
    expect(c[0]).toBe('2026-09-28');
    expect(c[c.length - 1]).toBe('2026-11-01');
    expect(c.length % 7).toBe(0);
    expect(c).toContain('2026-10-31');
  });

  it('달을 넘길 때 연도도 넘어간다', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });

  it('반복 일정은 회차별 날짜에, 마감 투두는 마감일에 놓인다', () => {
    const weekly: CalendarEvent = {
      ...base,
      id: 'e1',
      title: '주간 회의',
      start_at: '2026-10-08T01:00:00Z', // 서울 10:00
      end_at: '2026-10-08T02:00:00Z',
      all_day: false,
      timezone: 'Asia/Seoul',
      recurrence_rule: 'FREQ=WEEKLY',
      recurrence_parent_id: null,
      original_start_at: null,
      is_cancelled: false,
    };
    const task: Task = { ...base, id: 't1', title: '보고서', status: 'todo', priority: 'medium', due_date: '2026-10-14', completed_at: null };
    const m = itemsByDay([weekly], [task], '2026-10-01', '2026-10-31', 'Asia/Seoul');
    expect(['2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29'].map((d) => m.get(d)?.occ.length)).toEqual([1, 1, 1, 1]);
    expect(m.get('2026-10-14')?.tasks.map((t) => t.id)).toEqual(['t1']);
    expect(m.has('2026-10-01')).toBe(false);
  });
});
