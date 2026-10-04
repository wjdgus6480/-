import { useState } from 'react';
import type { AuthResult } from '../app/auth';
import { useServices } from '../app/context';

function Msg({ r }: { r: AuthResult | null }) {
  if (!r?.message) return null;
  return (
    <p className={r.ok ? 'notice' : 'error'} role={r.ok ? 'status' : 'alert'}>
      {r.message}
    </p>
  );
}

/** 로그아웃 상태: 비밀번호 로그인(기본) / 메일 링크·코드 / 가입 / 비밀번호 재설정 */
export function LoginForms() {
  const { auth } = useServices();
  const [mode, setMode] = useState<'password' | 'email' | 'signup' | 'reset'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AuthResult | null>(null);
  const run = async (fn: () => Promise<AuthResult>) => {
    setBusy(true);
    setRes(null);
    try {
      setRes(await fn());
    } finally {
      setBusy(false);
    }
  };
  const tabs = [
    { k: 'password', label: '비밀번호 로그인' },
    { k: 'email', label: '메일로 로그인' },
    { k: 'signup', label: '가입' },
    { k: 'reset', label: '비밀번호 찾기' },
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
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === 'password') void run(() => auth.signInWithPassword(email, password));
          else if (mode === 'signup') void run(() => auth.signUp(email, password));
          else if (mode === 'reset') void run(() => auth.sendPasswordReset(email));
          else if (!sent) void run(async () => {
            const r = await auth.sendMagicLink(email);
            if (r.ok) setSent(true);
            return r;
          });
          else void run(() => auth.verifyEmailCode(email, code));
        }}
      >
        <label>
          이메일
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {(mode === 'password' || mode === 'signup') && (
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
        )}
        {mode === 'email' && sent && (
          <label>
            메일의 인증 코드 (링크를 열어도 됩니다)
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        )}
        <button className="btn primary" type="submit" disabled={busy || (mode === 'email' && sent && code.trim().length < 6)}>
          {busy ? '처리 중…' : { password: '로그인', signup: '가입하기', reset: '재설정 메일 받기', email: sent ? '코드로 로그인' : '로그인 메일 받기' }[mode]}
        </button>
        {mode === 'email' && sent && (
          <button type="button" className="btn small ghost" onClick={() => setSent(false)}>
            메일 다시 받기
          </button>
        )}
        {(mode === 'email' || mode === 'reset' || mode === 'signup') && <small className="muted">무료 메일은 시간당 약 2통까지라, 평소에는 비밀번호 로그인을 권장합니다.</small>}
      </form>
      <Msg r={res} />
    </div>
  );
}

/** 새 비밀번호 설정 (로그인 상태 · 재설정 링크로 들어온 상태 공용) */
export function SetPasswordForm({ onDone }: { onDone?: () => void }) {
  const { auth } = useServices();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [nonce, setNonce] = useState('');
  const [needReauth, setNeedReauth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AuthResult | null>(null);
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (pw !== pw2) return setRes({ ok: false, message: '두 비밀번호가 다릅니다.' });
        setBusy(true);
        const r = await auth.setPassword(pw, needReauth ? nonce.trim() : undefined);
        setBusy(false);
        if (!r.ok && r.code === 'reauthentication_needed') {
          setNeedReauth(true);
          setRes(await auth.requestReauth());
          return;
        }
        setRes(r);
        if (r.ok) {
          setPw('');
          setPw2('');
          onDone?.();
        }
      }}
    >
      <label>
        새 비밀번호 (6자 이상)
        <input type="password" required minLength={6} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <label>
        새 비밀번호 확인
        <input type="password" required minLength={6} autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      </label>
      {needReauth && (
        <label>
          메일로 받은 재인증 코드
          <input inputMode="numeric" autoComplete="one-time-code" value={nonce} onChange={(e) => setNonce(e.target.value)} />
        </label>
      )}
      <button className="btn primary" type="submit" disabled={busy}>
        {busy ? '저장 중…' : '비밀번호 저장'}
      </button>
      <Msg r={res} />
    </form>
  );
}

/** 로그인 상태: 계정 정보·비밀번호 설정·로그아웃(이 기기 / 모든 기기) */
export function AccountActions({ email }: { email: string | null }) {
  const { auth } = useServices();
  const [showPw, setShowPw] = useState(false);
  const [res, setRes] = useState<AuthResult | null>(null);
  return (
    <div className="account-actions">
      <p>
        <strong>{email}</strong> 로 로그인됨
      </p>
      <div className="row-actions">
        <button type="button" className="btn small" aria-expanded={showPw} onClick={() => setShowPw(!showPw)}>
          비밀번호 설정·변경
        </button>
        <button type="button" className="btn small" onClick={() => void auth.signOutThisDevice().then(setRes)}>
          이 기기에서 로그아웃
        </button>
        <button
          type="button"
          className="btn small danger"
          onClick={() => {
            if (window.confirm('모든 기기(PC·휴대폰)에서 로그아웃할까요?\n다른 기기는 최대 1시간 안에 로그아웃되며, 각 기기의 데이터와 아직 보내지 않은 변경은 지워지지 않습니다.'))
              void auth.signOutAllDevices().then(setRes);
          }}
        >
          모든 기기에서 로그아웃
        </button>
      </div>
      {showPw && <SetPasswordForm onDone={() => setShowPw(false)} />}
      <Msg r={res} />
    </div>
  );
}
