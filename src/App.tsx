import { useCallback, useEffect, useState } from 'react';
import { useAuthView } from './app/auth';
import { ServicesContext, useDomainData, useDomainSyncState, useServices, useSyncState } from './app/context';
import { createServices, type Services } from './app/services';
import { migrateLocalDataToAccount, previewLocalDataMigration, type DataMigrationPreview, type DataMigrationSummary } from './domain/migrate';
import { ENTITY_LABEL, SYNC_ORDER } from './domain/types';
import { migrateLocalViewsToAccount, type MigrationSummary } from './views/migrate';
import { SettingsPage } from './ui/SettingsPage';
import { CategoryList, MiniCalendar } from './ui/Sidebar';
import { TablePage, type PageRequest } from './ui/TablePage';
import { PrivacyPage, TermsPage } from './ui/LegalPages';
import { Panel } from './ui/ViewMenus';

type Tab = 'tasks' | 'events' | 'projects' | 'settings' | 'privacy' | 'terms';
const TABS: { key: Tab; label: string }[] = [
  { key: 'tasks', label: '투두' },
  { key: 'events', label: '캘린더' },
  { key: 'projects', label: '프로젝트' },
  { key: 'settings', label: '설정' },
];

/** 메뉴 아이콘 (24px 격자 선 그림) */
const TAB_ICON: Partial<Record<Tab, string>> = {
  tasks: 'M4 12l5 5L20 6',
  events: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  projects: 'M3 7h7l2 2h9v10H3z',
  settings: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
};

let servicesPromise: Promise<Services> | null = null;

/** 상단 탭에는 없지만 해시로 여는 화면 (설정·가입 화면의 링크) */
const EXTRA_ROUTES: Tab[] = ['privacy', 'terms'];

const tabFromHash = (): Tab => {
  const h = location.hash.replace('#', '') as Tab;
  return TABS.some((t) => t.key === h) || EXTRA_ROUTES.includes(h) ? h : 'tasks';
};

export interface MigrationState {
  /** 이전 대기 중인 로그인 전 데이터 미리보기 */
  preview: (DataMigrationPreview & { views: number }) | null;
  data: DataMigrationSummary | null;
  views: MigrationSummary | null;
  error: string | null;
  running: boolean;
}

export function App({ services: injected }: { services?: Services }) {
  const [services, setServices] = useState<Services | null>(injected ?? null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [mig, setMig] = useState<MigrationState>({ preview: null, data: null, views: null, error: null, running: false });

  useEffect(() => {
    if (injected) return;
    servicesPromise ??= createServices();
    servicesPromise.then(setServices, (e) => setFatal(`저장소를 열 수 없습니다: ${(e as Error).message}`));
  }, [injected]);

  /** 로그인 상태에서 로그인 전 데이터가 있으면 미리보기만 만든다 (자동 이전하지 않음) */
  const checkPending = useCallback(async (s: Services) => {
    if (!s.session.owner) return setMig((m) => ({ ...m, preview: null }));
    const p = await previewLocalDataMigration(s.db);
    const views = (await s.db.getAll('view_preferences')).filter((v) => v.owner_id === null && !v.deleted_at).length;
    setMig((m) => ({ ...m, preview: p.total + views > 0 ? { ...p, views } : null }));
  }, []);

  const runMigration = useCallback(async () => {
    if (!services?.domainRemote || !services.remote) return;
    setMig((m) => ({ ...m, running: true, error: null }));
    // 업무 데이터와 보기 설정은 별개로 이전·보고한다.
    const d = await migrateLocalDataToAccount(services.db, services.domainRemote);
    const v = await migrateLocalViewsToAccount(services.db, services.remote);
    const errors = [!d.ok ? `업무 데이터: ${d.error.message}` : null, !v.ok ? `보기 설정: ${v.error.message}` : null].filter(Boolean);
    setMig((m) => ({ ...m, running: false, data: d.ok ? d.value : m.data, views: v.ok ? v.value : m.views, error: errors.length ? errors.join('\n') : null }));
    services.domain.emit();
    services.views.emit([]);
    await checkPending(services);
    void services.domainSync.sync();
    void services.sync.syncViewPreferences();
  }, [services, checkPending]);

  useEffect(() => {
    if (!services) return;
    void services.views.purgeDeletedViews();
    void services.domain.purgeDeleted();
    void checkPending(services);
    services.sync.start();
    services.domainSync.start();
    // 인증 상태 변화 → 데이터 화면·동기화에 반영 (services.session.owner 는 AuthController 구독이 먼저 갱신)
    let prevOwner = services.auth.state.userId;
    const unsubAuth = services.auth.subscribe((st, event) => {
      if (st.userId !== prevOwner) {
        prevOwner = st.userId;
        services.domain.emit();
        services.views.emit([]);
        void checkPending(services);
      }
      // 로그인·토큰 갱신 후에는 인증 만료로 멈춘 동기화를 바로 다시 시도한다.
      if (st.userId && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')) {
        void services.domainSync.sync();
        void services.sync.syncViewPreferences();
      }
    });
    return () => {
      services.sync.stop();
      services.domainSync.stop();
      unsubAuth();
    };
  }, [services, checkPending]);

  if (fatal) return <p className="error">{fatal}</p>;
  if (!services) return <p className="muted pad">불러오는 중…</p>;
  return (
    <ServicesContext.Provider value={services}>
      <Shell mig={mig} onMigrate={runMigration} />
    </ServicesContext.Provider>
  );
}

function Shell({ mig, onMigrate }: { mig: MigrationState; onMigrate: () => void }) {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const vs = useSyncState();
  const ds = useDomainSyncState();
  const services = useServices();
  const authView = useAuthView(services.auth);
  const [askOpen, setAskOpen] = useState(true);
  const data = useDomainData();
  // 사이드바 요청은 대상 화면이 열렸을 때만 전달한다 (다른 화면이 먼저 받아 처리하지 않게)
  const [request, setRequest] = useState<{ tab: Tab; req: PageRequest } | null>(null);
  const go = (t: Tab, req: PageRequest) => {
    location.hash = t;
    setTab(t);
    setRequest({ tab: t, req });
  };
  const clearRequest = useCallback(() => setRequest(null), []);
  useEffect(() => {
    const on = () => setTab(tabFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => setAskOpen(!!mig.preview), [mig.preview]);
  const pending = ds.pending + vs.pending;
  const conflicts = ds.conflicts + vs.conflicts;
  // 더 나쁜 상태를 우선 표시 (오류를 성공으로 보이지 않게)
  const worst = (['auth', 'error', 'offline', 'syncing', 'idle', 'local-only'] as const).find((k) => ds.status === k || vs.status === k)!;
  const status =
    worst === 'local-only' ? (pending ? '기기에 저장됨' : '로컬') : worst === 'idle' ? (pending ? '전송 대기' : '동기화됨') : { auth: '로그인 만료', error: '동기화 오류', offline: '오프라인', syncing: '동기화 중' }[worst];
  return (
    <div className="app">
      <header className="top">
        <h1>
          <span className="brand-name">DOTDAY</span>
          <span className="brand-sub">DAILY HUB</span>
        </h1>
        <button type="button" className="btn primary side-only side-new" onClick={() => go('tasks', { kind: 'new' })}>
          + 새 할 일
        </button>
        <nav className="tabs" aria-label="화면">
          {TABS.map((t) => (
            <a key={t.key} href={`#${t.key}`} className={tab === t.key ? 'on' : ''} aria-current={tab === t.key ? 'page' : undefined}>
              <svg className="tab-icon" viewBox="0 0 24 24" aria-hidden>
                <path d={TAB_ICON[t.key]} />
              </svg>
              {t.label}
            </a>
          ))}
        </nav>
        <div className="side-only side-extra">
          <MiniCalendar data={data} onPick={(date) => go('events', { kind: 'date', date })} />
          <CategoryList data={data} />
        </div>
        <a href="#settings" className={`sync-badge s-${worst}`} title="동기화 상태 (업무 데이터 · 보기 설정)" aria-live="polite">
          {status}
          {pending > 0 && ` · 대기 ${pending}`}
          {conflicts > 0 && ` · 충돌 ${conflicts}`}
        </a>
      </header>
      <div className="content">
        {authView.expired && (
          <div className="notice auth-expired" role="alert">
            로그인이 만료되었거나 다른 곳에서 로그아웃되었습니다. 이 기기의 데이터와 아직 보내지 않은 변경은 그대로 보존되어 있으며, 다시 로그인하면 이어서 동기화됩니다.{' '}
            <a href="#settings" className="btn small primary">
              다시 로그인
            </a>
          </div>
        )}
        {mig.preview && !askOpen && (
          // '나중에'를 눌러도 로그인 전 데이터는 계정(서버)에 없으므로 다른 기기에 보이지 않는다 → 계속 알림
          <div className="notice pending-migration" role="status">
            로그인 전에 만든 데이터 {mig.preview.total}건이 아직 계정에 올라가지 않아 다른 기기에 보이지 않습니다.{' '}
            <button type="button" className="btn small primary" onClick={() => setAskOpen(true)}>
              계정으로 옮기기
            </button>
          </div>
        )}
        <main>
          {tab === 'settings' ? (
            <SettingsPage mig={mig} onMigrate={onMigrate} />
          ) : tab === 'privacy' ? (
            <PrivacyPage />
          ) : tab === 'terms' ? (
            <TermsPage />
          ) : (
            <TablePage key={tab} domain={tab} request={request?.tab === tab ? request.req : null} onHandled={clearRequest} />
          )}
        </main>
      </div>
      {mig.preview && askOpen && (
        <Panel title="로그인 전 데이터를 계정으로 옮길까요?" onClose={() => setAskOpen(false)}>
          <p>이 기기에 로그인 전에 만든 데이터가 있습니다. 옮기면 다른 기기에서도 보이고 동기화됩니다.</p>
          <table className="preview-table">
            <tbody>
              {SYNC_ORDER.map((e) => (
                <tr key={e}>
                  <th>{ENTITY_LABEL[e]}</th>
                  <td>{mig.preview!.counts[e]}건</td>
                </tr>
              ))}
              <tr>
                <th>보기 설정</th>
                <td>{mig.preview.views}개</td>
              </tr>
            </tbody>
          </table>
          {mig.preview.referencedDeleted > 0 && <p className="muted small">삭제된 항목 {mig.preview.referencedDeleted}건은 다른 항목이 참조하고 있어 삭제 상태로 함께 옮깁니다.</p>}
          <ul className="muted small">
            <li>옮기기 전에 이 기기에 백업을 만듭니다.</li>
            <li>계정에 같은 ID 의 항목이 이미 있으면 계정(서버)의 내용을 유지하고, 이 기기의 내용은 백업에 남깁니다.</li>
            <li>실패하면 이 기기의 데이터는 그대로이며 다시 시도할 수 있습니다.</li>
          </ul>
          {mig.error && <pre className="error">{mig.error}</pre>}
          <div className="row-actions">
            <button type="button" className="btn primary" disabled={mig.running} onClick={onMigrate}>
              {mig.running ? '옮기는 중…' : '계정으로 옮기기'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setAskOpen(false);
              }}
            >
              나중에 (설정에서 할 수 있음)
            </button>
          </div>
        </Panel>
      )}
    </div>
  );
}
