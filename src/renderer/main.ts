import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'
import './dev-shim.js'

/** 运行时错误可见化：避免界面白屏却没有任何提示 */
function showRuntimeError(message: string) {
  const id = 'runtime-error-banner'
  let el = document.getElementById(id)
  if (!el) {
    el = document.createElement('div')
    el.id = id
    el.style.cssText = 'position:fixed;z-index:99999;top:0;left:0;right:0;padding:10px 14px;background:#7f1d1d;color:#fff;font:13px/1.6 monospace;white-space:pre-wrap;'
    document.body.prepend(el)
  }
  el.textContent = '运行时错误：' + message
  ;(window as any).__runtimeErrors = [...((window as any).__runtimeErrors ?? []), message]
}

window.addEventListener('error', e => showRuntimeError(e.message))
window.addEventListener('unhandledrejection', e => showRuntimeError(String((e as PromiseRejectionEvent).reason)))

try {
  const app = createApp(App)
  app.use(createPinia())
  app.config.errorHandler = (err, _vm, info) => {
    console.error('[vue error]', err, info)
    showRuntimeError(`${info} :: ${err instanceof Error ? err.message : String(err)}`)
  }
  app.mount('#app')
} catch (error) {
  showRuntimeError(String(error))
  console.error('Failed to mount Vue app:', error)
}
