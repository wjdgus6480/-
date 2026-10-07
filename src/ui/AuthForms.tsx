import { useEffect, useState } from 'react';
import type { AuthResult } from '../app/auth';
import { useServices } from '../app/context';
import { purgeOwnerData } from '../app/deviceData';

function Msg({ r }: { r: AuthResult | null }) {
  if (!r?.message) return null;
  return (
    <p className={r.ok ? 'notice' : 'error'} role={r.ok ? 'status' : 'alert'}>
      {r.message}
    </p>
  );
}

/** 로그아웃 상태: 비밀번호 로그인(기본) / 가입 */
export function LoginForms() {
  const { auth } = useServices();
  const [mode, setMode] = useState<'password' | 'signup'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AuthResult | null>(null);
  const tabs = [
    { k: 'password', label: '로그인' },
    { k: 'signup', label: '가입' },
  ] as const;
  return (
    <div className="auth-forms">
      <div className="chips" role="radiogroup" aria-label="로그인 방법">
        {tabs.map((t) => (
          <label key={t.k} className={`chip ${mode === t.k ? 'on' : ''}`}>
            <input
              type="radio"
              name="auth-mode"
              checked={mode === t.k}
              onChange={() => {
                setMode(t.k);
                setRes(null);
              }}
            />
            {t.label}
          </label>
        ))}
      </div>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setRes(null);
          try {
            setRes(mode === 'password' ? await auth.signInWithPassword(email, password) : await auth.signUp(email, password));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          이메일
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          비밀번호
          <input
            type="password"
            required
            minLength={6}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {mode === 'signup' && (
          <small className="muted">
            가입하면 <a href="#terms">이용약관</a>과 <a href="#privacy">개인정보 처리방침</a>에 동의하는 것으로 봅니다.
          </small>
        )}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? '처리 중…' : mode === 'password' ? '로그인' : '가입하기'}
        </button>
        <small className="muted">비밀번호를 잊은 경우: 메일 재설정은 아직 준비 중입니다. 운영자에게 문의하세요.</small>
      </form>
      <Msg r={res} />
    </div>
  );
}

/** 비밀번호 변경 (로그인 상태, 현재 비밀번호 확인) */
export function SetPasswordForm({ onDone }: { onDone?: () => void }) {
  const { auth } = useServices();
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AuthResult | null>(null);
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (pw !== pw2) return setRes({ ok: false, message: '두 비밀번호가 다릅니다.' });
        setBusy(true);
        const r = await auth.changePassword(current, pw);
        setBusy(false);
        setRes(r);
        if (r.ok) {
          setCurrent('');
          setPw('');
          setPw2('');
          onDone?.();
        }
      }}
    >
      <label>
        현재 비밀번호
        <input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label>
        새 비밀번호 (6자 이상)
        <input type="password" required minLength={6} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <label>
        새 비밀번호 확인
        <input type="password" required minLength={6} autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      </label>
      <button className="btn primary" type="submit" disabled={busy}>
        {busy ? '저장 중…' : '비밀번호 저장'}
      </button>
      <Msg r={res} />
    </form>
  );
}

/**
 * 회원 탈퇴: 서버의 계정과 본인 데이터를 삭제한다 (이 기기 데이터 지우기와 다름).
 * 재인증(최근 10분 내 로그인)은 서버가 판단한다. 비밀번호를 입력하면 먼저 재인증한다.
 */
export function DeleteAccount({ onDone }: { onDone?: () => void }) {
  const s = useServices();
  const [confirm, setConfirm] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AuthResult | null>(null);
  const [unsent, setUnsent] = useState(0);
  useEffect(() => {
    void s.db.count('domain_outbox').then(async (n) => setUnsent(n + (await s.db.count('view_outbox'))));
  }, [s.db]);
  return (
    <form
      className="form delete-account"
      onSubmit={async (e) => {
        e.preventDefault();
        if (confirm.trim() !== '탈퇴') return setRes({ ok: false, message: "확인을 위해 '탈퇴'를 입력하세요." });
        const uid = s.auth.state.userId;
        if (!uid) return setRes({ ok: false, message: '로그인 상태가 아닙니다.' });
        setBusy(true);
        try {
          if (pw) {
            const re = await s.auth.reauthenticateWithPassword(pw);
            if (!re.ok) return setRes(re);
          }
          const r = await s.auth.deleteAccount();
          if (!r.ok) return setRes(r);
          // 서버 삭제 성공 → 이 기기에서 그 계정의 데이터·대기열만 지우고 로그아웃 (로그인 전 데이터는 보존).
          // 정리가 끝난 뒤에 완료를 알린다.
          await purgeOwnerData(s.db, uid);
          await s.auth.signOutThisDevice();
          s.domain.emit();
          s.views.emit([]);
          setRes(r);
          onDone?.();
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="error" role="note">
        탈퇴하면 서버에 저장된 이 계정의 일정·투두·프로젝트·분류·보기 설정과 동기화 기록이 모두 삭제되며 되돌릴 수 없습니다. 다른 기기에 남은 사본도 다음 동기화부터 계정과 연결되지 않습니다.
      </p>
      {unsent > 0 && <p className="error">이 기기에 아직 서버로 보내지 않은 변경이 {unsent}건 있습니다. 탈퇴하면 함께 사라집니다. 필요하면 먼저 '업무 데이터 내보내기'로 백업하세요.</p>}
      <label>
        비밀번호 (재인증)
        <input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <label>
        확인을 위해 <strong>탈퇴</strong> 를 입력
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      <button type="submit" className="btn danger" disabled={busy || confirm.trim() !== '탈퇴'}>
        {busy ? '처리 중…' : '계정과 서버 데이터 영구 삭제'}
      </button>
      <Msg r={res} />
    </form>
  );
}

/** 로그인 상태: 계정 정보·비밀번호 설정·로그아웃(이 기기 / 모든 기기)·탈퇴 */
export function AccountActions({ email }: { email: string | null }) {
  const { auth } = useServices();
  const [showPw, setShowPw] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [res, setRes] = useState<AuthResult | null>(null);
  return (
    <div className="account-actions">
      <p>
        <strong>{email}</strong> 로 로그인됨
      </p>
      <div className="row-actions">
        <button type="button" className="btn small" aria-expanded={showPw} onClick={() => setShowPw(!showPw)}>
          비밀번호 변경
        </button>
        <button type="button" className="btn small" onClick={() => void auth.signOutThisDevice().then(setRes)}>
          이 기기에서 로그아웃
        </button>
        <button
          type="button"
          className="btn small danger"
          onClick={() => {
            if (window.confirm('모든 기기(PC·휴대폰)에서 로그아웃할까요?\n다른 기기는 다음 서버 요청부터 로그아웃되며, 각 기기의 데이터와 아직 보내지 않은 변경은 지워지지 않습니다.'))
              void auth.signOutAllDevices().then(setRes);
          }}
        >
          모든 기기에서 로그아웃
        </button>
      </div>
      {showPw && <SetPasswordForm onDone={() => setShowPw(false)} />}
      <Msg r={res} />
      <details className="danger-zone" open={showDelete} onToggle={(e) => setShowDelete((e.target as HTMLDetailsElement).open)}>
        <summary>회원 탈퇴</summary>
        {showDelete && <DeleteAccount />}
      </details>
    </div>
  );
}
