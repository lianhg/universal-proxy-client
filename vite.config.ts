import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'

/*
 * 主进程 / preload 必须构建成 CommonJS。
 * vite-plugin-electron 依据 package.json 的 "type" 字段决定格式：
 * type=module → 输出 ESM，而 Electron 从 app.asar 加载 ESM 主入口不稳定，
 * 且 sandbox 下的 preload 必须是 CJS（否则 preload 加载失败、window.api 全空、界面白屏）。
 * 所以 package.json 里刻意不写 "type": "module"。
 */
export default defineConfig({
  plugins: [
    vue(),
    electron([
      {
        entry: 'src/main.ts',
        vite: {
          build: {
            outDir: 'dist/electron-main',
            rollupOptions: { external: ['electron'], output: { inlineDynamicImports: true } },
          },
        },
      },
      {
        entry: 'src/preload/index.ts',
        onstart({ reload }) { reload() },
        vite: {
          build: {
            outDir: 'dist/electron-preload',
            rollupOptions: { external: ['electron'], output: { inlineDynamicImports: true } },
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: { alias: { '@': resolve(__dirname, 'src/renderer') } },
})
