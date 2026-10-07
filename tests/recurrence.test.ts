import { describe, expect, it } from 'vitest';
import { expandEvents, formatRule, overrideId, parseRule, seriesStarts } from '../src/domain/recurrence';
import type { CalendarEvent } from '../src/domain/types';
import { isoToZonedLocal } from '../src/lib/util';
import { followingRule } from '../src/domain/repo';
import { makeDevice } from './helpers';

function ev(p: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: crypto.randomUUID(),
    owner_id: null,
    title: 'e',
    description: '',
    start_at: '2026-10-05T01:00:00.000Z',
    end_at: '2026-10-05T02:00:00.000Z',
    all_day: false,
    timezone: 'Asia/Seoul',
    recurrence_rule: null,
    recurrence_parent_id: null,
    original_start_at: null,
    is_cancelled: false,
    project_id: null,
    category_id: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    deleted_at: null,
    version: 1,
    ...p,
  };
}
const local = (iso: string, tz: string) => isoToZonedLocal(iso, tz);
const starts = (e: CalendarEvent, until: string) => seriesStarts(e, until).map((x) => local(x.start, e.timezone));

describe('REC-001 반복 규칙 저장 형식 (계산과 별도)', () => {
  it('지원 형식을 파싱하고 같은 문자열로 직렬화한다', () => {
    for (const s of ['FREQ=DAILY', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=10', 'FREQ=MONTHLY;UNTIL=20261231', 'FREQ=YEARLY;INTERVAL=3']) {
      const p = parseRule(s);
      expect(p.ok, s).toBe(true);
      if (p.ok) expect(formatRule(p.rule)).toBe(s);
    }
  });
  it('지원하지 않거나 잘못된 규칙을 거부한다', () => {
    for (const s of ['', 'FREQ=HOURLY', 'FREQ=DAILY;COUNT=0', 'FREQ=DAILY;COUNT=3;UNTIL=20261231', 'FREQ=DAILY;BYDAY=MO', 'FREQ=WEEKLY;BYDAY=XX', 'FREQ=DAILY;UNTIL=20260230', 'FREQ=DAILY;BYMONTH=1', 'FREQ=DAILY;FREQ=WEEKLY', 'FREQ=DAILY;INTERVAL=1000']) {
      expect(parseRule(s).ok, s).toBe(false);
    }
  });
  it('서버 CHECK 정규식과 같은 범위 (마이그레이션 0003)', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync('legacy/supabase/migrations/20261002000003_domain_sync.sql', 'utf8');
    const m = sql.match(/recurrence_rule ~ '([^']+)'/);
    const re = new RegExp(m![1]);
    for (const s of ['FREQ=DAILY', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=10', 'FREQ=MONTHLY;UNTIL=20261231']) expect(re.test(formatRule((parseRule(s) as any).rule))).toBe(true);
    expect(re.test('FREQ=HOURLY')).toBe(false);
  });
});

describe('REC-002 매일·매주·매월 반복과 종료 조건', () => {
  it('매일 COUNT=3', () => {
    expect(starts(ev({ recurrence_rule: 'FREQ=DAILY;COUNT=3' }), '2027-01-01T00:00:00Z')).toEqual(['2026-10-05T10:00', '2026-10-06T10:00', '2026-10-07T10:00']);
  });
  it('2주마다 월·수, UNTIL 포함', () => {
    // 2026-10-05 은 월요일
    expect(starts(ev({ recurrence_rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261021' }), '2027-01-01T00:00:00Z')).toEqual([
      '2026-10-05T10:00',
      '2026-10-07T10:00',
      '2026-10-19T10:00',
      '2026-10-21T10:00',
    ]);
  });
  it('매월 31일: 31일이 없는 달은 건너뛴다', () => {
    const e = ev({ start_at: '2026-01-31T01:00:00.000Z', end_at: '2026-01-31T02:00:00.000Z', recurrence_rule: 'FREQ=MONTHLY;COUNT=4' });
    expect(starts(e, '2028-01-01T00:00:00Z').map((s) => s.slice(0, 10))).toEqual(['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
  });
  it('매년 2월 29일은 윤년에만', () => {
    const e = ev({ start_at: '2028-02-29T01:00:00.000Z', end_at: '2028-02-29T02:00:00.000Z', recurrence_rule: 'FREQ=YEARLY;COUNT=2' });
    expect(starts(e, '2040-01-01T00:00:00Z').map((s) => s.slice(0, 10))).toEqual(['2028-02-29', '2032-02-29']);
  });
  it('종료 조건이 없으면 조회 범위 끝에서 멈춘다', () => {
    expect(seriesStarts(ev({ recurrence_rule: 'FREQ=DAILY' }), '2026-10-15T00:00:00Z')).toHaveLength(10);
  });
});

describe('REC-003 시간대와 서머타임 경계', () => {
  it('뉴욕 매일 09:00 은 서머타임 시작(3/8) 전후로 벽시계 9시를 유지하고 UTC 는 1시간 당겨진다', () => {
    const e = ev({ timezone: 'America/New_York', start_at: '2026-03-06T14:00:00.000Z', end_at: '2026-03-06T15:00:00.000Z', recurrence_rule: 'FREQ=DAILY;COUNT=4' });
    const s = seriesStarts(e, '2026-04-01T00:00:00Z');
    expect(s.map((x) => local(x.start, 'America/New_York'))).toEqual(['2026-03-06T09:00', '2026-03-07T09:00', '2026-03-08T09:00', '2026-03-09T09:00']);
    expect(s.map((x) => x.start)).toEqual(['2026-03-06T14:00:00.000Z', '2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z', '2026-03-09T13:00:00.000Z']);
    expect(s.every((x) => Date.parse(x.end) - Date.parse(x.start) === 3600000)).toBe(true);
  });
  it('서머타임 종료(11/1)를 넘는 23:30~00:30 일정도 벽시계 길이 1시간을 유지한다', () => {
    const e = ev({ timezone: 'America/New_York', start_at: '2026-10-31T03:30:00.000Z', end_at: '2026-10-31T04:30:00.000Z', recurrence_rule: 'FREQ=DAILY;COUNT=3' });
    const s = seriesStarts(e, '2026-12-01T00:00:00Z');
    expect(s.map((x) => [local(x.start, e.timezone), local(x.end, e.timezone)])).toEqual([
      ['2026-10-30T23:30', '2026-10-31T00:30'],
      ['2026-10-31T23:30', '2026-11-01T00:30'],
      ['2026-11-01T23:30', '2026-11-02T00:30'],
    ]);
  });
  it('종일 반복 일정은 일정 시간대 자정 기준 하루씩', () => {
    const e = ev({ all_day: true, timezone: 'Asia/Seoul', start_at: '2026-10-04T15:00:00.000Z', end_at: '2026-10-05T15:00:00.000Z', recurrence_rule: 'FREQ=WEEKLY;COUNT=2' });
    const s = seriesStarts(e, '2027-01-01T00:00:00Z');
    expect(s).toEqual([
      { start: '2026-10-04T15:00:00.000Z', end: '2026-10-05T15:00:00.000Z' },
      { start: '2026-10-11T15:00:00.000Z', end: '2026-10-12T15:00:00.000Z' },
    ]);
  });
});

describe('REC-004 과거·미래 범위 조회와 예외 회차 계산', () => {
  const master = ev({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', recurrence_rule: 'FREQ=DAILY;COUNT=10' });
  it('범위와 겹치는 회차만, 과거 범위도 조회된다', () => {
    const occ = expandEvents([master], '2026-10-07T00:00:00Z', '2026-10-09T00:00:00Z');
    expect(occ.map((o) => o.start_at)).toEqual(['2026-10-07T01:00:00.000Z', '2026-10-08T01:00:00.000Z']);
    expect(expandEvents([master], '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')).toEqual([]);
    expect(expandEvents([master], '2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z')).toEqual([]);
  });
  it('변경 회차는 변경 값으로, 취소 회차는 제외, 다른 날로 옮긴 회차는 새 날짜 범위에서 보인다', () => {
    const moved = ev({ recurrence_parent_id: master.id, original_start_at: '2026-10-12T01:00:00.000Z', start_at: '2026-10-08T05:00:00.000Z', end_at: '2026-10-08T06:00:00.000Z', title: '옮김' });
    const cancelled = ev({ recurrence_parent_id: master.id, original_start_at: '2026-10-07T01:00:00.000Z', is_cancelled: true });
    const edited = ev({ recurrence_parent_id: master.id, original_start_at: '2026-10-08T01:00:00.000Z', start_at: '2026-10-08T01:00:00.000Z', end_at: '2026-10-08T03:00:00.000Z', title: '길어짐' });
    const occ = expandEvents([master, moved, cancelled, edited], '2026-10-07T00:00:00Z', '2026-10-09T00:00:00Z');
    expect(occ.map((o) => [o.event.title, o.start_at, o.original_start_at])).toEqual([
      ['길어짐', '2026-10-08T01:00:00.000Z', '2026-10-08T01:00:00.000Z'],
      ['옮김', '2026-10-08T05:00:00.000Z', '2026-10-12T01:00:00.000Z'],
    ]);
    // 옮겨 간 원래 날짜(10/12)에는 원본 회차가 나오지 않는다
    expect(expandEvents([master, moved], '2026-10-12T00:00:00Z', '2026-10-13T00:00:00Z')).toEqual([]);
    // 삭제된 반복 일정은 아무 회차도 없다
    expect(expandEvents([{ ...master, deleted_at: '2026-10-01T00:00:00Z' }], '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')).toEqual([]);
  });
  it('반복이 아닌 일정도 범위에 포함된다', () => {
    const single = ev({});
    expect(expandEvents([single], '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z').map((o) => o.is_recurring)).toEqual([false]);
  });
});

describe('REC-005 단일 회차 / 전체 회차 수정과 회차 취소 (저장소)', () => {
  it('한 회차만 변경·취소·되돌리기, 전체 수정 시 시간이 바뀌면 회차 예외 초기화', async () => {
    const d = await makeDevice();
    const m = await d.domain.createEvent({ title: '스탠드업', start_at: '2026-10-05T00:00:00.000Z', end_at: '2026-10-05T00:15:00.000Z', timezone: 'Asia/Seoul', recurrence_rule: 'FREQ=DAILY;COUNT=5' });
    const range = ['2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'] as const;
    const occ = async () => expandEvents((await d.domain.snapshot()).events, ...range);

    await d.domain.updateOccurrence(m.id, '2026-10-06T00:00:00.000Z', { title: '스탠드업(원격)', start_at: '2026-10-06T01:00:00.000Z', end_at: '2026-10-06T01:15:00.000Z' });
    await d.domain.cancelOccurrence(m.id, '2026-10-07T00:00:00.000Z');
    // 같은 회차를 다시 바꾸면 같은 예외 행이 갱신된다 (중복 행 없음)
    await d.domain.updateOccurrence(m.id, '2026-10-06T00:00:00.000Z', { description: '줌' });
    let o = await occ();
    expect(o.map((x) => [x.event.title, x.start_at])).toEqual([
      ['스탠드업', '2026-10-05T00:00:00.000Z'],
      ['스탠드업(원격)', '2026-10-06T01:00:00.000Z'],
      ['스탠드업', '2026-10-08T00:00:00.000Z'],
      ['스탠드업', '2026-10-09T00:00:00.000Z'],
    ]);
    expect(o[1].event.description).toBe('줌');
    expect((await d.domain.snapshot()).events).toHaveLength(3);

    // 취소 되돌리기
    await d.domain.resetOccurrence(m.id, '2026-10-07T00:00:00.000Z');
    expect((await occ()).length).toBe(5);

    // 전체 수정: 제목만 바꾸면 회차 예외 유지
    await d.domain.updateEvent(m.id, { title: '데일리' });
    o = await occ();
    expect(o.map((x) => x.event.title)).toEqual(['데일리', '스탠드업(원격)', '데일리', '데일리', '데일리']);
    // 전체 수정: 시간을 바꿔도 같은 날짜의 회차 예외는 보존 (v0.4.1, Q-04 — 이전에는 모두 삭제했음)
    await d.domain.updateEvent(m.id, { start_at: '2026-10-05T01:00:00.000Z', end_at: '2026-10-05T01:15:00.000Z' });
    o = await occ();
    expect(o.map((x) => x.event.title)).toEqual(['데일리', '스탠드업(원격)', '데일리', '데일리', '데일리']);
    expect(o[1]).toMatchObject({ is_exception: true, start_at: '2026-10-06T01:00:00.000Z' });
  });

  it('예외 회차 ID 는 (반복 일정, 원래 시각) 으로 결정되어 기기 간에 같다', async () => {
    const a = await overrideId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-10-06T00:00:00Z');
    const b = await overrideId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-10-06T00:00:00.000Z');
    const c = await overrideId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-10-07T00:00:00.000Z');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('Q-04: 전체 시간을 바꿔도 같은 날짜의 회차 수정·취소는 새 회차로 옮겨 보존한다', async () => {
    const d = await makeDevice();
    // 매일 09:00 (서울) 5회
    const m = await d.domain.createEvent({ title: '데일리', start_at: '2026-10-05T00:00:00.000Z', end_at: '2026-10-05T00:30:00.000Z', timezone: 'Asia/Seoul', recurrence_rule: 'FREQ=DAILY;COUNT=5' });
    await d.domain.updateOccurrence(m.id, '2026-10-06T00:00:00.000Z', { title: '제목만 바꾼 회차' });
    await d.domain.updateOccurrence(m.id, '2026-10-07T00:00:00.000Z', { start_at: '2026-10-07T05:00:00.000Z', end_at: '2026-10-07T05:30:00.000Z' });
    await d.domain.cancelOccurrence(m.id, '2026-10-08T00:00:00.000Z');
    const preview = await d.domain.previewSeriesChange(m.id, { start_at: '2026-10-05T01:00:00.000Z', end_at: '2026-10-05T01:30:00.000Z' });
    expect(preview).toEqual({ kept: 3, removed: 0 });
    // 10:00 으로 변경
    await d.domain.updateEvent(m.id, { start_at: '2026-10-05T01:00:00.000Z', end_at: '2026-10-05T01:30:00.000Z' });
    const o = expandEvents((await d.domain.snapshot()).events, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
    expect(o.map((x) => [x.event.title, x.start_at])).toEqual([
      ['데일리', '2026-10-05T01:00:00.000Z'],
      ['제목만 바꾼 회차', '2026-10-06T01:00:00.000Z'], // 시간을 안 바꾼 예외는 새 시간을 따름
      ['데일리', '2026-10-07T05:00:00.000Z'], // 직접 옮긴 시간은 유지
      ['데일리', '2026-10-09T01:00:00.000Z'],
    ]);
  });

  it('Q-04: 새 규칙에 그 날짜가 없으면 그 예외만 삭제 대상으로 미리 보여준다', async () => {
    const d = await makeDevice();
    const m = await d.domain.createEvent({ title: 'x', start_at: '2026-10-05T00:00:00.000Z', end_at: '2026-10-05T01:00:00.000Z', timezone: 'Asia/Seoul', recurrence_rule: 'FREQ=DAILY;COUNT=5' });
    await d.domain.cancelOccurrence(m.id, '2026-10-06T00:00:00.000Z'); // 화요일
    await d.domain.cancelOccurrence(m.id, '2026-10-07T00:00:00.000Z'); // 수요일
    // 매주 월·수 로 변경 → 화요일 예외는 갈 곳이 없음
    expect(await d.domain.previewSeriesChange(m.id, { recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4' })).toEqual({ kept: 1, removed: 1 });
  });

  it('Q-06: 반복 일정을 삭제했다가 복구하면 함께 삭제된 회차 예외도 복구된다', async () => {
    const d = await makeDevice();
    const m = await d.domain.createEvent({ title: 'x', start_at: '2026-10-05T00:00:00.000Z', end_at: '2026-10-05T01:00:00.000Z', recurrence_rule: 'FREQ=DAILY;COUNT=3' });
    await d.domain.cancelOccurrence(m.id, '2026-10-06T00:00:00.000Z');
    await d.domain.softDelete('events', m.id);
    await d.domain.restore('events', m.id);
    const o = expandEvents((await d.domain.snapshot()).events, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
    expect(o.map((x) => x.start_at)).toEqual(['2026-10-05T00:00:00.000Z', '2026-10-07T00:00:00.000Z']);
  });

  it('Q-07: 이 회차와 이후 모두 수정 → 원래 반복은 그 전까지, 새 반복이 이어지고 이후 예외는 옮겨진다', async () => {
    const d = await makeDevice();
    const m = await d.domain.createEvent({ title: '수업', start_at: '2026-10-05T00:00:00.000Z', end_at: '2026-10-05T01:00:00.000Z', timezone: 'Asia/Seoul', recurrence_rule: 'FREQ=DAILY;COUNT=6' });
    await d.domain.cancelOccurrence(m.id, '2026-10-06T00:00:00.000Z'); // 분할 전 예외
    await d.domain.updateOccurrence(m.id, '2026-10-09T00:00:00.000Z', { title: '특강' }); // 분할 후 예외
    const next = await d.domain.updateFollowing(m.id, '2026-10-08T00:00:00.000Z', { title: '수업(새 강의실)', start_at: '2026-10-08T02:00:00.000Z', end_at: '2026-10-08T03:00:00.000Z' });
    expect(next.recurrence_rule).toBe('FREQ=DAILY;COUNT=3');
    expect((await d.domain.get<CalendarEvent>('events', m.id))!.recurrence_rule).toBe('FREQ=DAILY;COUNT=3');
    const o = expandEvents((await d.domain.snapshot()).events, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
    expect(o.map((x) => [x.event.title, x.start_at])).toEqual([
      ['수업', '2026-10-05T00:00:00.000Z'],
      ['수업', '2026-10-07T00:00:00.000Z'],
      ['수업(새 강의실)', '2026-10-08T02:00:00.000Z'],
      ['특강', '2026-10-09T02:00:00.000Z'],
      ['수업(새 강의실)', '2026-10-10T02:00:00.000Z'],
    ]);
    // 폼처럼 원래 규칙(또는 남은 횟수 규칙)을 함께 보내도 남은 횟수로 이어진다 (브라우저 검증에서 발견)
    const w = await d.domain.createEvent({ title: 'w', start_at: '2026-10-05T10:00:00.000Z', end_at: '2026-10-05T11:00:00.000Z', timezone: 'Asia/Seoul', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4' });
    const w2 = await d.domain.updateFollowing(w.id, '2026-10-12T10:00:00.000Z', { title: 'w2', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4' });
    expect(w2.recurrence_rule).toBe('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2');
    expect(followingRule(w, '2026-10-12T10:00:00.000Z')).toBe('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2');
    // UNTIL 규칙은 전날까지로 끊긴다
    const u = await d.domain.createEvent({ title: 'u', start_at: '2026-10-05T00:00:00.000Z', end_at: '2026-10-05T01:00:00.000Z', timezone: 'Asia/Seoul', recurrence_rule: 'FREQ=DAILY;UNTIL=20261020' });
    const u2 = await d.domain.updateFollowing(u.id, '2026-10-10T00:00:00.000Z', { title: 'u2' });
    expect((await d.domain.get<CalendarEvent>('events', u.id))!.recurrence_rule).toBe('FREQ=DAILY;UNTIL=20261009');
    expect(u2.recurrence_rule).toBe('FREQ=DAILY;UNTIL=20261020');
  });

  it('반복 일정이 아닌 일정에는 회차 수정을 거부한다', async () => {
    const d = await makeDevice();
    const e = await d.domain.createEvent({ title: '한 번', start_at: '2026-10-05T00:00:00.000Z', end_at: '2026-10-05T01:00:00.000Z' });
    await expect(d.domain.cancelOccurrence(e.id, e.start_at)).rejects.toThrow(/반복 일정이 아닙니다/);
  });
});
