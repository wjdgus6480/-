/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  test: {
    environment: 'jsdom',
    setupFiles: ['tests/setup.ts'],
    // 테스트는 실서버(Spring Boot API)에 요청하지 않는다. .env 의 값을 테스트에서만 비운다
    // (동기화 판정 규칙은 PGlite 에뮬레이터로, 실제 서버는 backend/ 의 JUnit 테스트로 검증)
    env: { VITE_API_URL: '' },
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
