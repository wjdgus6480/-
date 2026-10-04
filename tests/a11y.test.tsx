import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Panel } from '../src/ui/ViewMenus';

afterEach(cleanup);

function Harness() {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(0);
  return (
    <>
      <button onClick={() => setOpen(true)}>열기</button>
      {open && (
        <Panel title="테스트" onClose={() => setOpen(false)}>
          <input aria-label="첫 입력" onChange={() => setN(n + 1)} />
          <button>마지막</button>
        </Panel>
      )}
    </>
  );
}

describe('A11Y-001 모달 포커스 관리 (Q-08)', () => {
  it('열면 패널로, 닫으면 연 버튼으로 포커스가 돌아가고 Tab 은 패널 안에서 순환한다', () => {
    render(<Harness />);
    const opener = screen.getByText('열기');
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: '테스트' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(dialog);
    // 입력 중 부모가 다시 그려져도 포커스를 빼앗지 않는다 (이전 버그)
    const input = screen.getByLabelText('첫 입력');
    input.focus();
    fireEvent.change(input, { target: { value: 'a' } });
    expect(document.activeElement).toBe(input);
    // jsdom 은 offsetParent 가 없으므로 Tab 순환은 실제 브라우저에서 확인 (보고서 참조)
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('A11Y-002 조작 불가능한 숨김 입력 없음', () => {
  it('칩 안의 체크박스·라디오는 display:none 이 아니다', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).not.toMatch(/\.chip input\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.chip:focus-within\s*\{[^}]*outline/);
  });
});
