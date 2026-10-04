import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDotdayDB } from '../src/db/idb';
import { DomainRepository } from '../src/domain/repo';
import type { CalendarEvent, Task } from '../src/domain/types';
import { pickConfig } from '../src/views/repo';
import { domainDump, makeDevice, type Device } from './helpers';

let d: Device;
beforeEach(async () => {
  d = await makeDevice();
});

const ops = async () => d.db.getAll('domain_outbox');

describe('DATA-001 로컬 CRUD 와 재실행 후 복원', () => {
  it('네 종류 모두 생성·조회·수정·삭제·복구되고 새 저장소 인스턴스(재실행)에서 그대로 읽힌다', async () => {
    const p = await d.domain.createProject({ name: ' 프로젝트 ' });
    const c = await d.domain.createCategory({ name: '분류', color: '#112233' });
    const t = await d.domain.createTask({ title: '작업', project_id: p.id, category_id: c.id, due_date: '2026-10-05' });
    const e = await d.domain.createEvent({ title: '일정', start_at: '2026-10-05T01:00:00.000Z', end_at: '2026-10-05T02:00:00.000Z', timezone: 'Asia/Seoul' });
    expect(p.name).toBe('프로젝트');
    await d.domain.updateProject(p.id, { status: 'done' });
    await d.domain.updateCategory(c.id, { name: '분류2' });
    await d.domain.updateTask(t.id, { title: '작업2' });
    await d.domain.updateEvent(e.id, { title: '일정2' });

    const reopened = new DomainRepository(d.db, () => null);
    const s = await reopened.snapshot();
    expect(s.projects[0]).toMatchObject({ id: p.id, status: 'done', version: 2 });
    expect(s.categories[0]).toMatchObject({ name: '분류2', color: '#112233' });
    expect(s.tasks[0]).toMatchObject({ title: '작업2', due_date: '2026-10-05', project_id: p.id });
    expect(s.events[0]).toMatchObject({ title: '일정2', recurrence_parent_id: null, is_cancelled: false });

    for (const [entity, id] of [['tasks', t.id], ['events', e.id], ['projects', p.id], ['categories', c.id]] as const) {
      await reopened.softDelete(entity, id);
    }
    expect(await reopened.snapshot()).toEqual({ tasks: [], events: [], projects: [], categories: [] });
    expect((await reopened.listDeleted()).length).toBe(4);
    await reopened.restore('tasks', t.id);
    expect((await reopened.snapshot()).tasks.map((x) => x.title)).toEqual(['작업2']);
  });

  it('변경이 없는 수정은 버전·수정일·큐를 바꾸지 않는다', async () => {
    const t = await d.domain.createTask({ title: 'A' });
    const before = await d.db.get('tasks', t.id);
    await d.domain.updateTask(t.id, { title: 'A' });
    expect(await d.db.get('tasks', t.id)).toEqual(before);
    expect(await ops()).toHaveLength(1);
  });

  it('잘못된 값은 저장하지 않는다', async () => {
    await expect(d.domain.createTask({ title: '  ' })).rejects.toThrow();
    await expect(d.domain.createTask({ title: 'x', due_date: '2026-02-30' })).rejects.toThrow(/마감일/);
    await expect(d.domain.createTask({ title: 'x', status: 'later' as never })).rejects.toThrow(/상태/);
    await expect(d.domain.createEvent({ title: 'x', start_at: '2026-10-05T02:00:00Z', end_at: '2026-10-05T01:00:00Z' })).rejects.toThrow(/종료/);
    await expect(d.domain.createEvent({ title: 'x', start_at: '2026-10-05T02:00:00Z', end_at: '2026-10-05T03:00:00Z', timezone: 'Mars/Base' })).rejects.toThrow(/시간대/);
    await expect(d.domain.createEvent({ title: 'x', start_at: '2026-10-05T02:00:00Z', end_at: '2026-10-05T03:00:00Z', recurrence_rule: 'FREQ=HOURLY' })).rejects.toThrow(/반복/);
    expect(await domainDump(d.db)).toEqual({ tasks: [], events: [], projects: [], categories: [] });
  });
});

describe('DATA-002 완료 상태와 완료 기록', () => {
  it('완료 시 completed_at 기록, 되돌리면 지우고, 다시 완료하면 새 시각', async () => {
    const t = await d.domain.createTask({ title: 'A' });
    const done = await d.domain.updateTask(t.id, { status: 'done' });
    expect(done.completed_at).toBeTruthy();
    const reopen = await d.domain.updateTask(t.id, { status: 'todo' });
    expect(reopen.completed_at).toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    const again = await d.domain.updateTask(t.id, { status: 'done' });
    expect(Date.parse(again.completed_at!)).toBeGreaterThan(Date.parse(done.completed_at!));
    // 처음부터 완료로 만든 작업
    const t2 = await d.domain.createTask({ title: 'B', status: 'done' });
    expect(t2.completed_at).toBe(t2.created_at);
  });
});

describe('DATA-003 데이터와 outbox 기록의 원자성', () => {
  it('생성·수정·삭제·복구마다 같은 레코드의 op 는 하나로 합쳐 기록된다', async () => {
    const t = await d.domain.createTask({ title: 'A' });
    await d.domain.updateTask(t.id, { title: 'B' });
    await d.domain.updateTask(t.id, { priority: 'high' });
    await d.domain.softDelete('tasks', t.id);
    const o = await ops();
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ entity: 'tasks', record_id: t.id, key: `tasks:${t.id}`, status: 'pending' });
  });

  it('큐 기록이 실패하면 레코드도 저장되지 않는다 (생성·수정 모두)', async () => {
    const t = await d.domain.createTask({ title: '원본' });
    const origPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: any[]) {
      if (this.name === 'domain_outbox') throw new DOMException('quota', 'QuotaExceededError');
      return origPut.apply(this, args as never);
    } as never;
    try {
      await expect(d.domain.updateTask(t.id, { title: '실패해야 함' })).rejects.toThrow(/저장 실패/);
      await expect(d.domain.createProject({ name: '실패 프로젝트' })).rejects.toThrow(/저장 실패/);
    } finally {
      IDBObjectStore.prototype.put = origPut;
    }
    expect((await d.domain.get<Task>('tasks', t.id))!.title).toBe('원본');
    expect((await d.domain.snapshot()).projects).toHaveLength(0);
  });

  it('반복 일정을 삭제하면 회차 예외도 한 트랜잭션으로 함께 삭제된다', async () => {
    const m = await d.domain.createEvent({ title: '반복', start_at: '2026-10-05T01:00:00.000Z', end_at: '2026-10-05T02:00:00.000Z', timezone: 'Asia/Seoul', recurrence_rule: 'FREQ=DAILY' });
    await d.domain.cancelOccurrence(m.id, '2026-10-06T01:00:00.000Z');
    await d.domain.softDelete('events', m.id);
    const all = await d.domain.snapshot(true);
    expect(all.events.every((e) => e.deleted_at)).toBe(true);
    expect((await ops()).length).toBe(2);
  });
});

describe('DATA-004 계정 간 데이터 분리 (같은 기기)', () => {
  it('현재 계정의 데이터만 보이고, 다른 계정 레코드는 수정할 수 없다', async () => {
    await d.domain.createTask({ title: '로그인 전' });
    d.session.owner = 'user-a';
    const a = await d.domain.createTask({ title: 'A 의 작업' });
    expect((await d.domain.snapshot()).tasks.map((t) => t.title)).toEqual(['A 의 작업']);
    d.session.owner = 'user-b';
    expect((await d.domain.snapshot()).tasks).toEqual([]);
    await expect(d.domain.updateTask(a.id, { title: 'hack' })).rejects.toThrow(/찾을 수 없습니다/);
    d.session.owner = null;
    expect((await d.domain.snapshot()).tasks.map((t) => t.title)).toEqual(['로그인 전']);
  });
});

describe('DATA-005 IndexedDB v1 → v2 업그레이드 시 기존 데이터 보존', () => {
  it('v0.3(v1) DB 의 업무·보기 데이터가 업그레이드 후 그대로 있고 새 스토어가 추가된다', async () => {
    const name = `upgrade-${Math.random()}`;
    const v1 = await openDotdayDB(name, 1);
    const legacyEvent = { id: '11111111-1111-4111-8111-111111111111', owner_id: null, title: '옛 일정', description: '', start_at: '2026-01-01T00:00:00.000Z', end_at: '2026-01-01T01:00:00.000Z', all_day: false, timezone: 'Asia/Seoul', recurrence_rule: 'FREQ=YEARLY', project_id: null, category_id: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', deleted_at: null, version: 3 };
    await v1.put('events', legacyEvent as never);
    await v1.put('tasks', { id: '22222222-2222-4222-8222-222222222222', owner_id: null, title: '옛 작업', description: '', status: 'todo', priority: 'low', due_date: null, project_id: null, category_id: null, completed_at: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', deleted_at: null, version: 1 } as never);
    await v1.put('meta', { key: 'local_profile_id', value: 'keep-me' });
    expect([...v1.objectStoreNames]).not.toContain('domain_outbox');
    v1.close();

    const v2 = await openDotdayDB(name);
    expect(v2.version).toBe(2);
    expect([...v2.objectStoreNames]).toEqual(expect.arrayContaining(['domain_outbox', 'domain_conflicts', 'domain_backups', 'view_preferences']));
    expect(await v2.get('events', legacyEvent.id)).toEqual(legacyEvent);
    expect((await v2.get('meta', 'local_profile_id'))!.value).toBe('keep-me');
    const repo = new DomainRepository(v2, () => null);
    const s = await repo.snapshot();
    expect(s.tasks.map((t) => t.title)).toEqual(['옛 작업']);
    // 예외 회차 필드가 없는 옛 일정은 기본값으로 읽히고, 수정도 가능
    expect(s.events[0]).toMatchObject({ title: '옛 일정', recurrence_parent_id: null, original_start_at: null, is_cancelled: false });
    const ev = await repo.updateEvent(legacyEvent.id, { title: '옛 일정 수정' });
    expect((ev as CalendarEvent).version).toBe(4);
    v2.close();
    // 낮은 버전으로 다시 열면 실패(데이터 보호: 다운그레이드 불가)
    await expect(openDB(name, 1)).rejects.toThrow();
  });
});

describe('DATA-006 업무 데이터 내보내기·가져오기·복구', () => {
  it('내보낸 데이터를 다른 기기로 가져오면 같은 ID 와 참조가 유지된다', async () => {
    await d.domain.seedSample();
    const file = await d.domain.exportData();
    expect(JSON.stringify(file)).not.toMatch(/owner_id|_sync/);
    const other = await makeDevice();
    const sum = await other.domain.importData(JSON.stringify(file));
    expect(sum.created).toEqual({ projects: 2, categories: 2, events: 3, tasks: 5 });
    const a = await d.domain.snapshot();
    const b = await other.domain.snapshot();
    expect(b.tasks.map((t) => [t.id, t.title, t.project_id]).sort()).toEqual(a.tasks.map((t) => [t.id, t.title, t.project_id]).sort());
    // 다시 가져오면 모두 '동일'로 건너뜀
    const again = await other.domain.importData(JSON.stringify(file));
    expect(again.skippedSame).toBe(12);
    expect(Object.values(again.created).reduce((x, y) => x + y)).toBe(0);
  });

  it('잘못된 레코드가 하나라도 있으면 전체를 거부하고 기존 데이터를 보존한다', async () => {
    await d.domain.seedSample();
    const before = await domainDump(d.db);
    const good = await d.domain.exportData();
    const bad1 = structuredClone(good);
    bad1.data.tasks[0].status = 'later';
    const bad2 = structuredClone(good);
    bad2.data.tasks.push({ ...bad2.data.tasks[0], id: crypto.randomUUID(), project_id: crypto.randomUUID() });
    const bad3 = structuredClone(good);
    (bad3.data.events[0] as any).recurrence_rule = 'FREQ=SECONDLY';
    const bad4 = structuredClone(good);
    (bad4.data.tasks[0] as any)._secret = 'x';
    for (const f of ['{oops', JSON.stringify({ format: 'x' }), JSON.stringify(bad1), JSON.stringify(bad2), JSON.stringify(bad3), JSON.stringify(bad4)]) {
      await expect(d.domain.importData(f)).rejects.toMatchObject({ code: 'IMPORT_INVALID' });
    }
    expect(await domainDump(d.db)).toEqual(before);
    expect(await d.db.getAll('domain_backups')).toHaveLength(0);
  });

  it('가져오기 도중 저장이 실패하면 일부만 들어가지 않는다', async () => {
    const src = await makeDevice();
    await src.domain.seedSample();
    const file = JSON.stringify(await src.domain.exportData());
    const before = await domainDump(d.db);
    const origPut = IDBObjectStore.prototype.put;
    let n = 0;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: any[]) {
      if (this.name === 'tasks' && ++n === 3) throw new DOMException('quota', 'QuotaExceededError');
      return origPut.apply(this, args as never);
    } as never;
    try {
      await expect(d.domain.importData(file)).rejects.toMatchObject({ code: 'STORAGE' });
    } finally {
      IDBObjectStore.prototype.put = origPut;
    }
    expect(await domainDump(d.db)).toEqual(before); // 프로젝트·분류·일정도 들어가지 않음
    expect(await d.db.getAll('domain_outbox')).toHaveLength(0);
  });

  it('파일에 owner_id 가 있어도 무시하고 현재 계정 소유로만 가져온다', async () => {
    const src = await makeDevice();
    await src.domain.createProject({ name: 'P' });
    const file = await src.domain.exportData();
    (file.data.projects[0] as any).owner_id = 'someone-else';
    await d.domain.importData(JSON.stringify(file));
    expect((await d.db.getAll('projects')).map((p) => p.owner_id)).toEqual([null]);
  });

  it('같은 ID 의 다른 내용은 덮어쓰지 않고, 가져오기 전 백업으로 되돌릴 수 있다', async () => {
    const t = await d.domain.createTask({ title: '내 것' });
    const file = await d.domain.exportData();
    (file.data.tasks[0] as any).title = '파일의 것';
    file.data.tasks.push({ ...file.data.tasks[0], id: crypto.randomUUID(), title: '새 작업' });
    const sum = await d.domain.importData(JSON.stringify(file));
    expect(sum.skippedConflict).toBe(1);
    expect((await d.domain.get<Task>('tasks', t.id))!.title).toBe('내 것');
    expect((await d.domain.snapshot()).tasks).toHaveLength(2);
    await d.domain.updateTask(t.id, { title: '가져온 뒤 수정' });
    await d.domain.restoreBackup(sum.backupId);
    const s = await d.domain.snapshot();
    expect(s.tasks.map((x) => x.title)).toEqual(['내 것']);
    expect((await d.domain.listDeleted()).map((x) => (x.record as Task).title)).toEqual(['새 작업']);
  });
});

describe('DATA-007 보기 설정 변경·초기화 후 업무 데이터와 업무 큐 불변 (v0.4 회귀)', () => {
  it('보기 작업은 업무 스토어와 domain_outbox 를 건드리지 않는다', async () => {
    await d.domain.seedSample();
    const before = await domainDump(d.db);
    const opsBefore = await ops();
    const l = await d.views.listViews('events');
    if (!l.ok) throw new Error();
    await d.views.updateView(l.value[0].id, { sort_config: [{ field: 'title', dir: 'desc' }] });
    await d.views.resetView(l.value[0].id);
    const dup = await d.views.duplicateView(l.value[0].id);
    if (dup.ok) await d.views.deleteView(dup.value.id);
    expect(await domainDump(d.db)).toEqual(before);
    expect(await ops()).toEqual(opsBefore);
  });

  it('일정 테이블에는 회차 예외 행이 나오지 않는다', async () => {
    const m = await d.domain.createEvent({ title: '반복', start_at: '2026-10-05T01:00:00.000Z', end_at: '2026-10-05T02:00:00.000Z', timezone: 'Asia/Seoul', recurrence_rule: 'FREQ=DAILY' });
    await d.domain.updateOccurrence(m.id, '2026-10-06T01:00:00.000Z', { title: '이날만 다름' });
    const l = await d.views.listViews('events');
    if (!l.ok) throw new Error();
    const r = await d.views.applySortAndFilter<CalendarEvent>('events', pickConfig(l.value[0]));
    expect(r.ok && r.value.map((e) => e.title)).toEqual(['반복']);
  });
});
