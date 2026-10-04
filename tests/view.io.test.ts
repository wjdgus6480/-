import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIELD_REGISTRY } from '../src/views/fields';
import { defaultViewConfig } from '../src/views/validate';
import { domainDump, makeDevice } from './helpers';

describe('VIEW-016 가져오기 및 복구', () => {
  it('내보낸 설정을 다른 기기에서 가져올 수 있다', async () => {
    const a = await makeDevice();
    const list = await a.views.listViews('tasks');
    if (!list.ok) throw new Error();
    await a.views.updateView(list.value[0].id, { sort_config: [{ field: 'title', dir: 'desc' }] });
    await a.views.createView({ domain: 'events', name: '이번 주 일정' });
    const file = await a.views.exportViews();
    expect(file.format).toBe('dotday.view-preferences');
    expect(file.views).toHaveLength(2);
    expect(JSON.stringify(file)).not.toMatch(/owner_id|_sync/);

    const b = await makeDevice();
    await b.views.listViews('tasks');
    const r = await b.views.importViews(JSON.stringify(file));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.imported).toBe(2);
    expect([...r.value.names].sort()).toEqual(['기본 보기 (가져옴)', '이번 주 일정']);
    const tl = await b.views.listViews('tasks');
    expect(tl.ok && tl.value).toHaveLength(2);
    expect(tl.ok && tl.value.find((v) => v.name === '기본 보기 (가져옴)')!.sort_config).toEqual([{ field: 'title', dir: 'desc' }]);
  });

  it('잘못된 파일은 전부 거부하고 기존 설정을 보호한다', async () => {
    const d = await makeDevice();
    await d.domain.createTask({ title: '업무' });
    const domainBefore = await domainDump(d.db);
    const l = await d.views.listViews('tasks');
    if (!l.ok) throw new Error();
    const before = await d.db.getAll('view_preferences');
    const good = { view_key: 'tasks', name: '정상', ...defaultViewConfig('tasks'), is_default: false };
    const badFiles = [
      'not json{',
      JSON.stringify({ format: 'other', schema_version: 1, views: [good] }),
      JSON.stringify({ format: 'dotday.view-preferences', schema_version: 99, views: [good] }),
      JSON.stringify({ format: 'dotday.view-preferences', schema_version: 1, views: [] }),
      // 한 항목만 잘못돼도 전체 거부 (정상 항목도 추가되지 않음)
      JSON.stringify({
        format: 'dotday.view-preferences',
        schema_version: 1,
        views: [good, { ...good, name: '나쁨', column_config: [{ field: 'ssn', visible: true, position: 0, width: 100, pinned: false }] }],
      }),
      JSON.stringify({ format: 'dotday.view-preferences', schema_version: 1, views: [{ ...good, view_key: 'bank' }] }),
      JSON.stringify({ format: 'dotday.view-preferences', schema_version: 1, views: [{ ...good, column_config: good.column_config.map((c) => ({ ...c, width: -5 })) }] }),
    ];
    for (const f of badFiles) {
      const r = await d.views.importViews(f);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('IMPORT_INVALID');
    }
    expect(await d.db.getAll('view_preferences')).toEqual(before);
    expect(await d.db.getAll('view_backups')).toHaveLength(0);
    expect(await domainDump(d.db)).toEqual(domainBefore);
  });

  it('가져오기 전 자동 백업으로 이전 상태를 복구할 수 있다', async () => {
    const d = await makeDevice();
    const l = await d.views.listViews('tasks');
    if (!l.ok) throw new Error();
    const orig = l.value[0];
    const file = {
      format: 'dotday.view-preferences',
      schema_version: 1,
      exported_at: new Date().toISOString(),
      views: [{ view_key: 'tasks', name: '가져온 보기', ...defaultViewConfig('tasks'), is_default: false }],
    };
    const r = await d.views.importViews(JSON.stringify(file));
    if (!r.ok) throw new Error(r.error.message);
    await d.views.updateView(orig.id, { name: '수정됨' });
    const restore = await d.views.restoreBackup(r.value.backupId);
    expect(restore.ok).toBe(true);
    const after = await d.views.listViews('tasks');
    expect(after.ok && after.value.map((v) => v.name)).toEqual(['기본 보기']);
    expect(after.ok && after.value[0].id).toBe(orig.id);
    // 복구로 숨겨진 '가져온 보기'도 휴지통에서 다시 살릴 수 있다
    const del = await d.views.listDeletedViews('tasks');
    expect(del.ok && del.value.map((v) => v.name)).toEqual(['가져온 보기']);
  });
});

describe('서버/클라이언트 허용 필드 일치', () => {
  it('SQL view_pref_allowed_fields 와 FIELD_REGISTRY 가 같다', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261002000002_view_preferences.sql'), 'utf8');
    for (const domain of ['tasks', 'events', 'projects'] as const) {
      const m = sql.match(new RegExp(`when '${domain}' then array\\[([^\\]]+)\\]`));
      const fields = m![1].split(',').map((s) => s.trim().replace(/'/g, ''));
      expect(fields).toEqual(FIELD_REGISTRY[domain].map((f) => f.key));
    }
  });
});
