import { Component, type ReactNode } from 'react';

/** 화면 오류가 나도 빈 화면 대신 안내를 보여 준다. 저장된 데이터(IndexedDB)는 영향을 받지 않는다. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card pad" role="alert">
        <h2>화면을 표시하는 중 문제가 생겼습니다</h2>
        <p>저장된 데이터는 이 기기에 그대로 있습니다. 새로고침하면 대부분 해결됩니다.</p>
        <button type="button" className="btn primary" onClick={() => location.reload()}>
          새로고침
        </button>
        <details>
          <summary className="muted small">진단 정보</summary>
          <code className="small">{this.state.error.message}</code>
        </details>
      </div>
    );
  }
}
