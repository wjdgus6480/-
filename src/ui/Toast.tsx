import { useEffect, useState } from 'react';
import { TOAST_EVENT } from './xp';

/** 화면 아래 잠깐 떴다 사라지는 알림 (퀘스트 완료 EXP 등). 스크린리더에도 읽힌다 */
export function Toast() {
  const [msg, setMsg] = useState<{ text: string; id: number } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const on = (e: Event) => {
      setMsg({ text: (e as CustomEvent<string>).detail, id: Date.now() });
      clearTimeout(timer);
      timer = setTimeout(() => setMsg(null), 2200);
    };
    window.addEventListener(TOAST_EVENT, on);
    return () => {
      window.removeEventListener(TOAST_EVENT, on);
      clearTimeout(timer);
    };
  }, []);
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
      {msg && (
        <div key={msg.id} className="toast">
          {msg.text}
        </div>
      )}
    </div>
  );
}
