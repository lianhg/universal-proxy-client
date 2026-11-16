/**
 * 版本信息回归测试
 *
 * 目的：版本号只有 package.json 一个真源。
 * 历史上界面把 `v1.0.0` 直接写死在侧边栏，升级后仍显示旧版本号，
 * 这里用静态检查把它钉死，防止再退化。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    pass++
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`)
    fail++
  }
}

const pkg = JSON.parse(read('package.json'))

t('package.json 版本号是合法 semver', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, `实际：${pkg.version}`)
})

t('版本号不低于 1.1.0（本轮发布版本）', () => {
  const [a, b] = pkg.version.split('.').map(Number)
  assert.ok(a > 1 || (a === 1 && b >= 1), `实际：${pkg.version}`)
})

/* ───────── 版本记账：改了就必须升版 + 写日志 ───────── */

const changelog = read('CHANGELOG.md')
const entries = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/gm)].map(m => ({ version: m[1], date: m[2] }))

t('CHANGELOG.md 存在，且已记录当前版本', () => {
  assert.ok(entries.length > 0, 'CHANGELOG.md 里没有任何形如「## [1.2.3] - 2026-11-16」的条目')
  assert.equal(entries[0].version, pkg.version, `日志顶部是 ${entries[0].version}，package.json 是 ${pkg.version}（改了版本却没记账，或记错了）`)
})

t('版本序列单调递增，日期格式合法', () => {
  const cmp = (x, y) => {
    const a = x.split('.').map(Number), b = y.split('.').map(Number)
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
    return 0
  }
  for (let i = 1; i < entries.length; i++) {
    assert.ok(cmp(entries[i - 1].version, entries[i].version) > 0, `版本未递增：${entries[i - 1].version} → ${entries[i].version}`)
  }
  for (const e of entries) assert.match(e.date, /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
})

t('升版脚本同时改包版本、安装器与日志（缺一不可）', () => {
  const bump = read('scripts/bump-version.mjs')
  assert.match(bump, /pkg\.version = next/, '升版脚本没有改 package.json')
  assert.match(bump, /make_installer\.py/, '升版脚本没有重新生成安装脚本')
  assert.match(bump, /CHANGELOG\.md/, '升版脚本没有写更新日志')
  assert.ok(pkg.scripts?.bump, 'package.json 缺少 bump 脚本入口')
  assert.match(changelog, /版本规则（硬性要求）/, 'CHANGELOG.md 顶部缺少版本规则说明')
})

t('主进程用 app.getVersion() 取版本，不写死', () => {
  const main = read('src/main.ts')
  assert.ok(main.includes("ipcMain.handle('app-info'"), '缺少 app-info IPC')
  assert.ok(main.includes('app.getVersion()'), '应由 app.getVersion() 提供版本号')
  assert.ok(/version:\s*packagedVersion/.test(main), 'app-info 应返回读取到的版本')
})

t('app-info 返回完整环境字段', () => {
  const main = read('src/main.ts')
  // 允许 `key: value` 与 ES6 简写 `key,` 两种写法
  for (const key of ['electron', 'chrome', 'node', 'v8', 'platform', 'arch', 'buildTime', 'userData', 'exePath']) {
    assert.ok(new RegExp(`\\b${key}\\s*[:,]`).test(main), `app-info 缺少字段 ${key}`)
  }
})

t('preload 暴露 appInfo 通道', () => {
  const preload = read('src/preload/index.ts')
  assert.ok(preload.includes('appInfo: () => ipcRenderer.invoke("app-info")'), 'preload 未暴露 appInfo')
})

t('渲染层 api 导出 appInfo 且有预览兜底', () => {
  const api = read('src/renderer/api.ts')
  assert.ok(api.includes('export async function appInfo()'), 'api.ts 未导出 appInfo')
  assert.ok(api.includes('previewAppInfo'), '缺少浏览器预览兜底，避免显示假版本')
})

t('store 提供 appVersion 计算属性', () => {
  const store = read('src/renderer/store.ts')
  assert.ok(store.includes('loadAppInfo'), 'store 缺少 loadAppInfo')
  assert.ok(/appVersion\s*=\s*computed/.test(store), 'store 缺少 appVersion')
  assert.ok(store.includes('appInfo, appVersion, loadAppInfo'), 'store 未对外暴露版本状态')
})

t('界面不再硬编码版本号', () => {
  const files = ['src/renderer/App.vue', 'src/renderer/components/AboutPanel.vue']
  for (const f of files) {
    const src = read(f)
    assert.ok(!/v1\.\d+\.\d+/.test(src), `${f} 仍写死版本号，应改用 store.appVersion`)
  }
})

t('设置页挂载了「关于 / 版本信息」面板', () => {
  const app = read('src/renderer/App.vue')
  assert.ok(app.includes('AboutPanel'), 'App.vue 未引入 AboutPanel')
  assert.ok(/<AboutPanel\s*\/>/.test(app), 'App.vue 未渲染 AboutPanel')
  const panel = read('src/renderer/components/AboutPanel.vue')
  assert.ok(panel.includes('复制诊断信息'), '缺少诊断信息复制入口')
})

t('窗口标题带版本号（任务栏可见）', () => {
  const main = read('src/main.ts')
  assert.ok(/title:\s*`[^`]*\$\{app\.getVersion\(\)\}/.test(main), '窗口 title 未拼接 app.getVersion()')
  assert.ok(main.includes("page-title-updated"), '应阻止页面 title 覆盖窗口 title')
})

t('安装器 DisplayVersion 与 package.json 一致', () => {
  const ps1 = read('install.ps1')
  const m = ps1.match(/DisplayVersion'\s+-Value\s+'([^']+)'/)
  assert.ok(m, 'install.ps1 未写 DisplayVersion')
  assert.equal(m[1], pkg.version, `install.ps1 显示 ${m[1]}，包版本 ${pkg.version}`)
})

t('安装器生成器从 package.json 取版本', () => {
  const gen = read('build/make_installer.py')
  assert.ok(gen.includes('__APP_VERSION__'), '生成器缺少版本占位符')
  assert.ok(gen.includes("'version'"), '生成器应读取 package.json 的 version')
})

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
