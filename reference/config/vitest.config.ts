import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// 앱 빌드 설정(crx 플러그인 포함)과 분리해 테스트는 순수 Node 환경에서 돌린다.
export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'] },
})
