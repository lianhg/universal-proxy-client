// 浏览器预览（非 Electron）环境下的最小 shim。
// 解析能力由 src/renderer/api.ts 直接调用本地纯逻辑实现，这里只补齐窗口控制等空操作，
// 避免出现 "not wired" 之类会让用户误以为功能不可用的占位。
import './api.js'

const noop = () => {}
const shim = {
  minimize: noop, maximize: noop, close: noop,
  getAppPath: () => Promise.resolve(''),
  openExternal: () => Promise.resolve(),
  // 以下方法留空表示"走 api.ts 的本地实现"
  parseConfig: undefined,
  protocolCoverage: undefined,
  generateConfig: undefined,
  fetchSubscription: (url: string) => Promise.resolve({
    ok: false,
    error: `订阅拉取需要 Electron 主进程（当前为浏览器预览模式），未向 ${url} 发起请求。请直接粘贴订阅内容。`,
  }),
}

if (typeof window !== 'undefined' && !(window as any).electronAPI) {
  ;(window as any).electronAPI = shim
}
export {}
