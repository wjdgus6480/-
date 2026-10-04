/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  test: {
    environment: 'jsdom',
    setupFiles: ['tests/setup.ts'],
    // 테스트는 실서버(Supabase)에 요청하지 않는다. .env 의 값을 테스트에서만 비운다 (서버 계약은 PGlite 로 검증)
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
