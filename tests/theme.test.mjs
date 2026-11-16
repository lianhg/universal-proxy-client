/**
 * 主题（黑夜 / 白天 / 跟随系统）回归测试。
 * 纯逻辑部分用 typescript.transpileModule 现场转译 src/renderer/theme.ts，
 * 不依赖打包产物；静态部分检查界面、样式、IPC 通道与「渲染层黑屏」红线。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

let passed = 0, failed = 0
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`) }
}

/* ── 现场转译 theme.ts（不产生构建产物） ── */
const js = ts.transpileModule(read('src/renderer/theme.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const mod = { exports: {} }
new Function('module', 'exports', 'require', js)(mod, mod.exports, require)
const T = mod.exports

console.log('\n── 主题纯逻辑 ──')

t('三种模式齐全，且都有中文标签 / 图标 / 说明', () => {
  assert.deepEqual([...T.THEME_MODES], ['dark', 'light', 'system'])
  for (const m of T.THEME_MODES) {
    assert.ok(T.THEME_LABELS[m], `${m} 缺标签`)
    assert.ok(T.THEME_ICONS[m], `${m} 缺图标`)
    assert.ok(T.THEME_DESCRIPTIONS[m], `${m} 缺说明`)
  }
  assert.match(T.THEME_LABELS.dark, /黑夜/)
  assert.match(T.THEME_LABELS.light, /白天/)
})

t('normalizeThemeMode 保留合法值', () => {
  for (const m of T.THEME_MODES) assert.equal(T.normalizeThemeMode(m), m)
})

t('normalizeThemeMode 对脏数据回退 dark', () => {
  for (const v of [undefined, null, '', 'DARK', 'auto', 0, {}, []]) {
    assert.equal(T.normalizeThemeMode(v), 'dark', `非法值 ${String(v)} 应回退`)
  }
  assert.equal(T.normalizeThemeMode('x', 'light'), 'light', '可指定回退值')
})

t('dark / light 无视系统偏好', () => {
  assert.equal(T.resolveTheme('dark', false), 'dark')
  assert.equal(T.resolveTheme('light', true), 'light')
})

t('system 真正跟随系统偏好', () => {
  assert.equal(T.resolveTheme('system', true), 'dark')
  assert.equal(T.resolveTheme('system', false), 'light')
})

t('readStoredTheme 读持久化值，脏数据回退 dark', () => {
  const store = (v) => ({ getItem: () => v })
  assert.equal(T.readStoredTheme(store('light')), 'light')
  assert.equal(T.readStoredTheme(store('system')), 'system')
  assert.equal(T.readStoredTheme(store('garbage')), 'dark')
  assert.equal(T.readStoredTheme({ getItem: () => { throw new Error('隐私模式') } }), 'dark')
  assert.equal(T.readStoredTheme(null), 'dark')
})

t('persistTheme 写入规范化后的值，存储异常不抛', () => {
  let saved = null
  T.persistTheme('light', { setItem: (k, v) => { saved = [k, v] } })
  assert.deepEqual(saved, [T.THEME_STORAGE_KEY, 'light'])
  T.persistTheme('nonsense', { setItem: (k, v) => { saved = [k, v] } })
  assert.equal(saved[1], 'dark')
  assert.doesNotThrow(() => T.persistTheme('dark', { setItem: () => { throw new Error('quota') } }))
})

function fakeDoc() {
  return { documentElement: { dataset: {}, style: {} } }
}

t('applyTheme 写入 data-theme / data-theme-mode / color-scheme', () => {
  const doc = fakeDoc()
  assert.equal(T.applyTheme('light', { prefersDark: true, doc }), 'light')
  assert.equal(doc.documentElement.dataset.theme, 'light')
  assert.equal(doc.documentElement.dataset.themeMode, 'light')
  assert.equal(doc.documentElement.style.colorScheme, 'light')
})

t('system 模式按传入的系统偏好解析', () => {
  const darkDoc = fakeDoc(), lightDoc = fakeDoc()
  assert.equal(T.applyTheme('system', { prefersDark: true, doc: darkDoc }), 'dark')
  assert.equal(T.applyTheme('system', { prefersDark: false, doc: lightDoc }), 'light')
  assert.equal(lightDoc.documentElement.dataset.themeMode, 'system', 'DOM 要保留「跟随系统」这个选择')
})

t('非法模式不会把脏值写进 DOM', () => {
  const doc = fakeDoc()
  assert.equal(T.applyTheme('bogus', { prefersDark: false, doc }), 'dark')
  assert.equal(doc.documentElement.dataset.theme, 'dark')
  assert.equal(doc.documentElement.dataset.themeMode, 'dark')
})

t('applyTheme 在没有 DOM 的环境也不抛', () => {
  assert.doesNotThrow(() => T.applyTheme('dark', { prefersDark: false, doc: undefined }))
})

t('watchSystemTheme 在没有 window 的环境返回可调用的空函数', () => {
  const stop = T.watchSystemTheme(() => {}, null)
  assert.equal(typeof stop, 'function')
  assert.doesNotThrow(() => stop())
})

console.log('\n── 首屏防闪烁 / 双色板 ──')

t('index.html 默认深色，且内联脚本与 THEME_BOOTSTRAP_SCRIPT 完全一致', () => {
  const html = read('index.html')
  assert.match(html, /<html[^>]*data-theme="dark"/)
  assert.ok(html.includes(T.THEME_BOOTSTRAP_SCRIPT), '内联脚本必须与导出的常量逐字一致，否则两处逻辑会漂移')
})

t('style.css 有完整浅色覆盖块，且两套变量键不缺项', () => {
  const css = read('src/renderer/style.css')
  const darkBlock = css.match(/:root,\s*:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)
  const lightBlock = css.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)
  assert.ok(darkBlock, '缺深色变量块')
  assert.ok(lightBlock, '缺浅色变量块')
  // 字体 / 圆角 / 过渡与配色无关，由 :root 提供即可，不需要在浅色块里重复定义
  const themeAgnostic = /^--(font|radius|transition)/
  const keys = (s) => [...s.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]).filter(k => !themeAgnostic.test(k))
  const dk = keys(darkBlock[1]), lk = keys(lightBlock[1])
  assert.ok(dk.length > 30, `深色变量太少：${dk.length}`)
  const missing = dk.filter(k => !lk.includes(k))
  assert.deepEqual(missing, [], `浅色主题缺少变量：${missing.join(', ')}`)
  assert.ok(lk.includes('--bg') && lk.includes('--text') && lk.includes('--code-bg'))
})

t('浅色色板确实是亮底深字（不是把深色改个名字）', () => {
  const css = read('src/renderer/style.css')
  const lightBlock = css.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)[1]
  assert.match(lightBlock, /--bg:\s*#f[0-9a-f]{5}/i)
  assert.match(lightBlock, /--text:\s*#1[0-9a-f]{5}/i)
})

console.log('\n── 界面交互 / 状态管理 ──')

t('常驻顶部导航栏已移除，功能入口收进汉堡 ≡ 弹层；主题切换改为顶部循环按钮', () => {
  const app = read('src/renderer/App.vue')
  // 原左侧侧栏与侧栏主题下拉菜单已移除
  assert.ok(app.includes('aside class="sidebar"') === false, '左侧侧栏应已移除')
  assert.ok(app.includes('class="top-nav"') === false, '常驻顶部导航栏应已移除')
  assert.ok(app.includes('theme-menu') === false, '侧栏主题下拉菜单应已移除')
  // 汉堡弹层承载 11 个功能入口
  assert.match(app, /class="menu-pop"/)
  assert.match(app, /class="icon-btn menu-btn"/)
  assert.match(app, /v-for="item in navItems"/)
  assert.match(app, /:class="\['menu-item', \{ active: activeTab === item\.key \}\]"/)
  assert.match(app, /@click="gotoTab\(item\.key\)"/)
  // 主题切换仍可用：顶部「主题」循环按钮
  assert.match(app, /@click="cycleTheme"/)
  assert.ok(app.includes('深色模式') === false, '不应再有写死的「深色模式」静态按钮文字')
})

t('设置中心挂载「外观 / 主题」面板，且与顶部导航共用同一 store', () => {
  const app = read('src/renderer/App.vue')
  assert.match(app, /<AppearancePanel\s*\/>/)
  assert.match(app, /import AppearancePanel from '\.\/components\/AppearancePanel\.vue'/)
  const panel = read('src/renderer/components/AppearancePanel.vue')
  assert.match(panel, /store\.setTheme\(o\.mode\)/)
  assert.match(panel, /v-for="o in options"/)
  assert.match(panel, /THEME_MODES/)
})

t('store 提供 setTheme / initTheme / disposeTheme，并持久化与监听系统变化', () => {
  const s = read('src/renderer/store.ts')
  for (const key of ['setTheme', 'initTheme', 'disposeTheme', 'resolvedTheme', 'persistTheme', 'watchSystemTheme']) {
    assert.ok(s.includes(key), `store 缺少 ${key}`)
  }
  assert.match(s, /const theme = ref<ThemeMode>\(readStoredTheme\(\)\)/)
  assert.match(s, /if \(theme\.value === 'system'\) applyThemeNow\(\)/)
  assert.match(s, /runtimeApi\.setThemeSource\(theme\.value\)/)
})

t('App 启动时初始化主题，卸载时清理监听', () => {
  const app = read('src/renderer/App.vue')
  assert.match(app, /appStore\.initTheme\(\)/)
  assert.match(app, /appStore\.disposeTheme\(\)/)
  assert.match(app, /@click="cycleTheme"/, '主题切换仍经顶部循环按钮可达，disposeTheme 负责卸载时清理监听')
})

t('IPC 链路完整：preload → api → 主进程 nativeTheme', () => {
  const preload = read('src/preload/index.ts')
  const api = read('src/renderer/api.ts')
  const main = read('src/main.ts')
  assert.match(preload, /setThemeSource:\s*\(mode: string\) => ipcRenderer\.invoke\("set-theme-source", mode\)/)
  assert.match(api, /export async function setThemeSource/)
  assert.match(main, /ipcMain\.handle\('set-theme-source'/)
  assert.match(main, /nativeTheme\.themeSource = source/)
  assert.match(main, /nativeTheme\.shouldUseDarkColors \? '#1a1a2e' : '#f5f7fb'/)
})

console.log('\n── 浅色适配 / 渲染层黑屏红线 ──')

t('组件里不再有黑底代码块与浅色错误文字', () => {
  const files = ['src/renderer/App.vue', ...fs.readdirSync(path.join(ROOT, 'src/renderer/components'))
    .filter(f => f.endsWith('.vue')).map(f => 'src/renderer/components/' + f)]
  for (const f of files) {
    const text = read(f)
    for (const bad of ['#080f1d', '#fca5a5', '#fcd34d', '#93c5fd', '#60a5fa', '#c084fc']) {
      assert.ok(!text.includes(bad), `${f} 仍含硬编码 ${bad}，白天模式会看不清`)
    }
  }
})

t('渲染层可达的 core 模块不得出现裸 Buffer 调用（13:01 黑屏事故回归）', () => {
  const dirs = ['src/core/hub', 'src/core/runtime']
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(ROOT, d)).filter(f => f.endsWith('.ts'))) {
      const text = read(`${d}/${f}`)
      assert.ok(!/Buffer\.(alloc|from|concat)\s*\(/.test(text), `${d}/${f} 含裸 Buffer 调用，会在浏览器包里抛 ReferenceError`)
    }
  }
})

t('已构建的渲染包（若存在）不得含裸 Buffer 调用', () => {
  const assets = path.join(ROOT, 'dist/assets')
  if (!fs.existsSync(assets)) return
  for (const f of fs.readdirSync(assets).filter(f => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(assets, f), 'utf8')
    assert.ok(!/Buffer\.(alloc|from|concat)\s*\(/.test(text), `dist/assets/${f} 含裸 Buffer 调用`)
  }
})

console.log(`\n===== 结果：${passed} 通过 / ${failed} 失败 =====\n`)
if (failed) process.exit(1)
