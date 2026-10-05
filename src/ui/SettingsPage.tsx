import { useEffect, useState } from 'react';
import type { MigrationState } from '../App';
import { useAuthView } from '../app/auth';
import { AccountActions, LoginForms } from './AuthForms';
import { useDomainData, useDomainSyncState, useServices, useSyncState, useViews } from '../app/context';
import type { DomainBackup, DomainConflict, DomainOp } from '../db/idb';
import type { DomainError } from '../domain/repo';
import { ENTITY_LABEL, recordLabel, SYNC_ORDER, type Entity, type EntityRecord } from '../domain/types';
import { DOMAIN_LABEL } from '../views/fields';
import type { ConflictChoice, SyncState } from '../views/sync';
import type { DomainSyncState } from '../domain/sync';
import { SYNC_STATUS_LABEL } from '../lib/syncPolicy';
import { VIEW_DOMAINS, type OutboxOp, type ViewBackup, type ViewConflict, type ViewDomain, type ViewPreference } from '../views/types';

const FIELD_LABEL: Record<string, string> = {
  name: '이름',
  column_config: '컬럼',
  sort_config: '정렬',
  filter_config: '필터',
  layout_config: '레이아웃',
  is_default: '기본 보기',
  deleted_at: '삭제 상태',
};

export function SettingsPage({ mig, onMigrate }: { mig: MigrationState; onMigrate: () => void }) {
  return (
    <section className="settings">
      <AccountSection mig={mig} onMigrate={onMigrate} />
      <DomainConflictSection />
      <ConflictSection />
      <TrashSection />
      <DataIOSection />
      <h2>보기 관리</h2>
      {VIEW_DOMAINS.map((d) => (
        <ViewManager key={d} domain={d} />
      ))}
      <ImportExportSection />
      <CategorySection />
    </section>
  );
}

function SyncRows({ title, st }: { title: string; st: DomainSyncState | SyncState }) {
  const [diag, setDiag] = useState(false);
  return (
    <>
      <dt>
        <strong>{title}</strong>
      </dt>
      <dd data-testid={`sync-status-${title}`} aria-live="polite">
        {SYNC_STATUS_LABEL[st.status]} · 전송 대기 {st.pending}건 · 충돌 {st.conflicts}건 · 마지막 동기화 {st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString('ko-KR') : '-'}
        {st.nextRetryAt && <div className="small">다음 자동 재시도: {new Date(st.nextRetryAt).toLocaleTimeString('ko-KR')} (지금 동기화로 바로 시도 가능)</div>}
        {st.lastError && (
          <div className="small">
            <button type="button" className="btn small ghost" aria-expanded={diag} onClick={() => setDiag(!diag)}>
              {diag ? '진단 정보 숨기기' : '진단 정보 보기'}
            </button>
            {diag && <code className="error">{st.lastError}</code>}
          </div>
        )}
      </dd>
    </>
  );
}

function AccountSection({ mig, onMigrate }: { mig: MigrationState; onMigrate: () => void }) {
  const s = useServices();
  const st = useSyncState();
  const ds = useDomainSyncState();
  const authView = useAuthView(s.auth);
  return (
    <div className="card">
      <h2>계정 · 기기 간 동기화</h2>
      <dl className="kv">
        <SyncRows title="업무 데이터" st={ds} />
        <SyncRows title="보기 설정" st={st} />
      </dl>
      {!s.supabase && (
        <p className="muted small">
          클라우드가 설정되지 않아 이 기기(IndexedDB)에만 저장됩니다. Supabase 무료 프로젝트의 URL·anon key 를 <code>.env</code> 에 넣으면 로그인과 기기 간 동기화가 켜집니다.
        </p>
      )}
      {s.supabase && !authView.userId && <LoginForms />}
      {s.supabase && authView.userId && <AccountActions email={authView.email} />}
      <div className="row-actions">
        <button
          type="button"
          className="btn"
          disabled={ds.status === 'local-only'}
          onClick={() => {
            void s.domainSync.sync();
            void s.sync.syncViewPreferences();
          }}
        >
          지금 동기화
        </button>
        {mig.preview && (
          <button type="button" className="btn primary" disabled={mig.running} onClick={onMigrate}>
            로그인 전 데이터 계정으로 옮기기 ({mig.preview.total}건 + 보기 {mig.preview.views}개)
          </button>
        )}
      </div>
      {mig.error && <pre className="error">{mig.error}</pre>}
      {mig.data && (
        <div className="notice">
          <strong>업무 데이터 이전 결과</strong>
          <p>
            전체 {mig.data.total}건 · 새로 올림 {SYNC_ORDER.map((e) => `${ENTITY_LABEL[e]} ${mig.data!.created[e]}`).join(', ')} · 서버와 동일 {mig.data.same} · 서버 값 유지 {mig.data.serverKept} · 서버
            재검증 {mig.data.verifiedTotal}/{mig.data.total}
          </p>
          {mig.data.mismatches.length > 0 && <p className="error small">검증 불일치: {mig.data.mismatches.join(', ')}</p>}
        </div>
      )}
      {mig.views && (
        <div className="notice">
          <strong>보기 설정 이전 결과</strong>
          <p>
            전체 {mig.views.total}개 · 새로 생성 {mig.views.created} · 이름 바꿔 추가 {mig.views.renamed} · 중복(클라우드 것 사용) {mig.views.duplicates} · 서버 검증 {mig.views.verified}/{mig.views.total}
          </p>
        </div>
      )}
    </div>
  );
}

const GROUP_LABEL: Record<string, string> = {
  title: '제목',
  name: '이름',
  description: '설명',
  'status,completed_at': '상태(완료)',
  status: '상태',
  priority: '우선순위',
  due_date: '마감일',
  project_id: '프로젝트',
  category_id: '분류',
  color: '색',
  deleted_at: '삭제 여부',
  'start_at,end_at,all_day,timezone,recurrence_rule': '시간·반복',
  'recurrence_parent_id,original_start_at': '회차 연결',
  is_cancelled: '회차 취소',
};

function showValue(v: Record<string, unknown> | null): string {
  if (!v) return '(없음)';
  if ('deleted_at' in v && Object.keys(v).length === 1) return v.deleted_at ? '삭제됨' : '유지';
  return Object.values(v)
    .map((x) => (x === null ? '-' : typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(x) ? new Date(x).toLocaleString('ko-KR') : String(x)))
    .join(' / ');
}

function DomainConflictSection() {
  const s = useServices();
  const ds = useDomainSyncState();
  const [conflicts, setConflicts] = useState<DomainConflict[]>([]);
  const [rejected, setRejected] = useState<DomainOp[]>([]);
  const [choice, setChoice] = useState<Record<string, Record<string, 'local' | 'remote'>>>({});
  useEffect(() => {
    void s.domainSync.listConflicts().then(setConflicts);
    void s.domainSync.listRejected().then(setRejected);
  }, [s, ds]);
  if (!conflicts.length && !rejected.length) return null;
  return (
    <div className="card warn-card">
      <h2>확인이 필요한 업무 데이터 변경</h2>
      {conflicts.map((c) => (
        <div key={c.id} className="conflict">
          <p>
            <strong>
              [{ENTITY_LABEL[c.entity]}] {c.label}
            </strong>{' '}
            — {c.kind === 'delete' ? '한 기기에서는 삭제하고 다른 기기에서는 수정했습니다.' : '다른 기기에서 같은 항목을 바꿨습니다.'}
            {c.merged_fields.length > 0 && <span className="muted"> (자동 병합됨: {c.merged_fields.join(', ')})</span>}
          </p>
          {c.groups.map((g) => {
            const k = g.fields.join(',');
            return (
              <fieldset key={k}>
                <legend>{GROUP_LABEL[k] ?? k}</legend>
                {(['local', 'remote'] as const).map((side) => (
                  <label key={side} className="inline">
                    <input type="radio" name={`${c.id}-${k}`} checked={choice[c.id]?.[k] === side} onChange={() => setChoice((x) => ({ ...x, [c.id]: { ...x[c.id], [k]: side } }))} />
                    {side === 'local' ? '이 기기' : '다른 기기(서버)'}: <code>{showValue(side === 'local' ? g.local : g.remote)}</code>
                  </label>
                ))}
              </fieldset>
            );
          })}
          <button
            type="button"
            className="btn primary"
            onClick={async () => {
              const r = await s.domainSync.resolveConflict(c.id, choice[c.id] ?? {});
              if (!r.ok) alert(r.error.message);
              else void s.domainSync.sync();
            }}
          >
            선택대로 해결
          </button>
        </div>
      ))}
      {rejected.map((op) => (
        <p key={op.op_id}>
          서버가 거부한 변경 ({ENTITY_LABEL[op.entity]}): {op.last_error}{' '}
          <button type="button" className="btn small" onClick={() => window.confirm('이 기기의 변경을 버리고 서버 값으로 되돌릴까요?') && void s.domainSync.discardRejected(op.op_id)}>
            변경 버리기
          </button>
        </p>
      ))}
    </div>
  );
}

function TrashSection() {
  const s = useServices();
  const data = useDomainData();
  const [items, setItems] = useState<Array<{ entity: Entity; record: EntityRecord }>>([]);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void s.domain.listDeleted().then(setItems);
  }, [s, data]);
  if (!items.length) return null;
  return (
    <div className="card">
      <h2>휴지통</h2>
      <p className="muted small">삭제한 업무 데이터는 30일 동안 복구할 수 있습니다.</p>
      {msg && (
        <p className="notice" role="status">
          {msg}
        </p>
      )}
      <ul className="view-admin">
        {items.slice(0, 50).map(({ entity, record }) => (
          <li key={`${entity}:${record.id}`}>
            <span>
              [{ENTITY_LABEL[entity]}] {recordLabel(entity, record)} <small className="muted">· {new Date(record.deleted_at!).toLocaleString('ko-KR')} 삭제</small>
            </span>
            <button
              type="button"
              className="btn small"
              onClick={async () => {
                try {
                  const warn = await s.domain.restore(entity, record.id);
                  setMsg(warn.length ? `복구했습니다. ${warn.join(' ')}` : null);
                } catch (e) {
                  setMsg((e as Error).message);
                }
              }}
            >
              복구
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DataIOSection() {
  const s = useServices();
  const [msg, setMsg] = useState<string | null>(null);
  const [backups, setBackups] = useState<DomainBackup[]>([]);
  const refresh = () => void s.domain.listBackups().then(setBackups);
  useEffect(refresh, [s]);
  return (
    <div className="card">
      <h2>업무 데이터 내보내기 · 가져오기</h2>
      <p className="muted small">투두·일정·프로젝트·분류 전체(삭제된 항목 포함). 가져오면 먼저 자동 백업하며, 잘못된 항목이 하나라도 있으면 아무것도 바꾸지 않습니다. 같은 ID 가 이미 있으면 덮어쓰지 않습니다.</p>
      <div className="row-actions">
        <button
          type="button"
          className="btn"
          onClick={async () => {
            const file = await s.domain.exportData();
            const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `dotday-data-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          데이터 내보내기 (.json)
        </button>
        <label className="btn">
          데이터 가져오기
          <input
            type="file"
            accept="application/json,.json"
            hidden
            aria-label="업무 데이터 가져오기 파일"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              if (f.size > 20_000_000) return setMsg('파일이 너무 큽니다 (20MB 제한).');
              try {
                const r = await s.domain.importData(await f.text());
                setMsg(
                  `가져옴: ${SYNC_ORDER.map((x) => `${ENTITY_LABEL[x]} ${r.created[x]}`).join(', ')} · 이미 있음(동일) ${r.skippedSame} · 같은 ID 다른 내용(기존 유지) ${r.skippedConflict}`,
                );
              } catch (err) {
                const de = err as DomainError;
                setMsg(`${de.message}${de.issues?.length ? '\n' + de.issues.slice(0, 5).map((i) => `• ${i}`).join('\n') : ''}`);
              }
              refresh();
            }}
          />
        </label>
      </div>
      {msg && <pre className="notice">{msg}</pre>}
      {backups.length > 0 && (
        <>
          <h3>업무 데이터 백업</h3>
          <ul className="view-admin">
            {backups.slice(0, 10).map((b) => (
              <li key={b.id}>
                <span>
                  {new Date(b.created_at).toLocaleString('ko-KR')} · {b.reason === 'import' ? '가져오기 전' : b.reason === 'migration' ? '계정 이전 전' : '수동'} · 투두 {b.data.tasks.length} · 일정 {b.data.events.length}
                </span>
                <button
                  type="button"
                  className="btn small"
                  onClick={async () => {
                    if (!window.confirm('이 백업 시점의 업무 데이터로 되돌릴까요? 이후에 추가된 항목은 휴지통으로 이동합니다.')) return;
                    try {
                      const n = await s.domain.restoreBackup(b.id);
                      setMsg(`백업으로 복구했습니다 (${n}건 변경).`);
                    } catch (e) {
                      setMsg((e as Error).message);
                    }
                  }}
                >
                  이 백업으로 복구
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ConflictSection() {
  const s = useServices();
  const st = useSyncState();
  const [conflicts, setConflicts] = useState<ViewConflict[]>([]);
  const [rejected, setRejected] = useState<OutboxOp[]>([]);
  const [choice, setChoice] = useState<Record<string, Record<string, ConflictChoice>>>({});
  useEffect(() => {
    void s.sync.listConflicts().then(setConflicts);
    void s.db.getAll('view_outbox').then((ops) => setRejected(ops.filter((o) => o.status === 'rejected')));
  }, [s, st]);
  if (!conflicts.length && !rejected.length) return null;
  return (
    <div className="card warn-card">
      <h2>확인이 필요한 변경</h2>
      {conflicts.map((c) => (
        <div key={c.id} className="conflict">
          <p>
            <strong>{c.view_name}</strong> — 다른 기기에서 같은 항목을 바꿨습니다.
            {c.merged_fields.length > 0 && <span className="muted"> (자동 병합됨: {c.merged_fields.map((f) => FIELD_LABEL[f]).join(', ')})</span>}
          </p>
          {c.fields.map((f) => (
            <fieldset key={f.field}>
              <legend>{FIELD_LABEL[f.field]}</legend>
              {(['local', 'remote'] as const).map((side) => (
                <label key={side} className="inline">
                  <input
                    type="radio"
                    name={`${c.id}-${f.field}`}
                    checked={choice[c.id]?.[f.field] === side}
                    onChange={() => setChoice((x) => ({ ...x, [c.id]: { ...x[c.id], [f.field]: side } }))}
                  />
                  {side === 'local' ? '이 기기' : '다른 기기'}: <code>{summarize(side === 'local' ? f.local : f.remote)}</code>
                </label>
              ))}
            </fieldset>
          ))}
          <button
            type="button"
            className="btn primary"
            onClick={async () => {
              const r = await s.sync.resolveViewConflict(c.id, choice[c.id] ?? {});
              if (!r.ok) alert(r.error.message);
              else void s.sync.syncViewPreferences();
            }}
          >
            선택대로 해결
          </button>
        </div>
      ))}
      {rejected.map((op) => (
        <p key={op.op_id}>
          서버가 거부한 변경: {op.last_error}{' '}
          <button type="button" className="btn small" onClick={() => void s.sync.discardRejected(op.op_id)}>
            변경 버리기
          </button>
        </p>
      ))}
    </div>
  );
}

function summarize(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 80 ? s.slice(0, 80) + '…' : String(s);
}

function ViewManager({ domain }: { domain: ViewDomain }) {
  const s = useServices();
  const { list } = useViews(domain);
  const [deleted, setDeleted] = useState<ViewPreference[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void s.views.listDeletedViews(domain).then((r) => r.ok && setDeleted(r.value));
  }, [s, domain, list]);
  const act = async (p: Promise<{ ok: boolean; error?: { message: string } }>) => {
    const r = await p;
    setMsg(r.ok ? null : r.error!.message);
  };
  return (
    <div className="card">
      <h3>{DOMAIN_LABEL[domain]}</h3>
      {msg && <p className="error">{msg}</p>}
      <ul className="view-admin">
        {list.map((v) => (
          <li key={v.id}>
            <span>
              {v.is_default && '★ '}
              {v.name}
            </span>
            <span className="row-actions">
              {!v.is_default && (
                <button type="button" className="btn small" onClick={() => act(s.views.setDefaultView(v.id))}>
                  기본으로
                </button>
              )}
              <button
                type="button"
                className="btn small"
                onClick={() => window.confirm(`'${v.name}' 설정을 기본값으로 복원할까요? 업무 데이터는 그대로입니다.`) && act(s.views.resetView(v.id))}
              >
                기본 설정 복원
              </button>
              <button type="button" className="btn small danger" onClick={() => window.confirm(`'${v.name}' 보기를 삭제할까요? (30일간 복구 가능)`) && act(s.views.deleteView(v.id))}>
                삭제
              </button>
            </span>
          </li>
        ))}
      </ul>
      {deleted.length > 0 && (
        <>
          <p className="muted small">삭제된 보기 (30일 보관)</p>
          <ul className="view-admin">
            {deleted.map((v) => (
              <li key={v.id} className="muted">
                <span>{v.name}</span>
                <button type="button" className="btn small" onClick={() => act(s.views.restoreView(v.id))}>
                  복구
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ImportExportSection() {
  const s = useServices();
  const [msg, setMsg] = useState<string | null>(null);
  const [backups, setBackups] = useState<ViewBackup[]>([]);
  const refresh = () => void s.views.listBackups().then(setBackups);
  useEffect(refresh, [s]);
  return (
    <div className="card">
      <h2>보기 설정 내보내기 · 가져오기</h2>
      <p className="muted small">보기 설정만 포함됩니다 (업무 데이터 제외). 가져오면 현재 설정을 자동 백업하고 새 보기로 추가합니다. 잘못된 항목이 하나라도 있으면 아무것도 바꾸지 않습니다.</p>
      <div className="row-actions">
        <button
          type="button"
          className="btn"
          onClick={async () => {
            const file = await s.views.exportViews();
            const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `dotday-views-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          내보내기 (.json)
        </button>
        <label className="btn">
          가져오기
          <input
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              if (f.size > 1_000_000) return setMsg('파일이 너무 큽니다 (1MB 제한).');
              const r = await s.views.importViews(await f.text());
              if (r.ok) setMsg(`${r.value.imported}개 보기를 가져왔습니다: ${r.value.names.join(', ')}`);
              else setMsg(`${r.error.message}${r.error.issues ? '\n' + r.error.issues.slice(0, 5).map((i) => `• ${i.path}: ${i.message}`).join('\n') : ''}`);
              refresh();
            }}
          />
        </label>
      </div>
      {msg && <pre className="notice">{msg}</pre>}
      {backups.length > 0 && (
        <>
          <h3>백업</h3>
          <ul className="view-admin">
            {backups.slice(0, 10).map((b) => (
              <li key={b.id}>
                <span>
                  {new Date(b.created_at).toLocaleString('ko-KR')} · {b.reason === 'import' ? '가져오기 전' : b.reason === 'migration' ? '계정 이전 전' : '수동'} · {b.views.length}개
                </span>
                <button
                  type="button"
                  className="btn small"
                  onClick={async () => {
                    if (!window.confirm('이 백업 시점의 보기 설정으로 되돌릴까요? 이후 추가된 보기는 삭제됨(복구 가능)으로 바뀝니다.')) return;
                    const r = await s.views.restoreBackup(b.id);
                    setMsg(r.ok ? `백업으로 복구했습니다 (${r.value}개 변경).` : r.error.message);
                  }}
                >
                  이 백업으로 복구
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function CategorySection() {
  const s = useServices();
  const data = useDomainData();
  const [name, setName] = useState('');
  return (
    <div className="card">
      <h2>분류 · 데이터</h2>
      <ul className="view-admin">
        {data.categories.map((c) => (
          <li key={c.id}>
            <span className="cat">
              <i className="dot" style={{ background: c.color }} />
              {c.name}
            </span>
            <span className="row-actions">
              <input type="color" value={c.color} aria-label={`${c.name} 색`} onChange={(e) => void s.domain.updateCategory(c.id, { color: e.target.value })} />
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  const n = window.prompt('분류 이름', c.name);
                  if (n && n.trim()) void s.domain.updateCategory(c.id, { name: n.trim() });
                }}
              >
                이름 변경
              </button>
              <button type="button" className="btn small danger" onClick={() => window.confirm(`분류 '${c.name}'을(를) 삭제할까요?`) && void s.domain.softDelete('categories', c.id)}>
                삭제
              </button>
            </span>
          </li>
        ))}
      </ul>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void s.domain.createCategory({ name }).then(() => setName(''));
        }}
      >
        <input placeholder="새 분류" value={name} onChange={(e) => setName(e.target.value)} aria-label="새 분류 이름" />
        <button className="btn" type="submit">
          추가
        </button>
      </form>
      <button type="button" className="btn ghost" onClick={() => void s.domain.seedSample()}>
        샘플 데이터 추가
      </button>
    </div>
  );
}
