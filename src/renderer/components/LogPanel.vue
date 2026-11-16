<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAppStore } from '../store.js'

const store = useAppStore()

const level = ref<'all' | 'info' | 'warn' | 'error' | 'success'>('all')
const keyword = ref('')
const autoScroll = ref(true)

const rows = computed(() => store.logs.filter(l =>
  (level.value === 'all' || l.level === level.value) &&
  (!keyword.value.trim() || `${l.module} ${l.message} ${l.detail ?? ''}`.toLowerCase().includes(keyword.value.trim().toLowerCase()))
))

async function copyLogs() {
  try {
    await navigator.clipboard.writeText(rows.value.map(l => `${l.time} [${l.level.toUpperCase()}] ${l.module} ${l.message}${l.detail ? '\n  ' + l.detail : ''}`).join('\n'))
    store.log('info', '[logs]', '日志已复制到剪贴板')
  } catch (e) { store.log('error', '[logs]', String(e)) }
}
</script>

<template>
  <div class="card panel">
    <div class="head">
      <div>
        <h3>运行日志</h3>
        <p class="sub">连接错误 · 协议解析错误 · 字段缺失 / 未映射告警 · 内核配置生成记录（真实事件，非模拟数据）</p>
      </div>
      <span class="cnt">{{ store.logs.length }} 条</span>
    </div>

    <div class="toolbar">
      <select v-model="level">
        <option value="all">全部级别</option>
        <option value="error">错误</option>
        <option value="warn">警告</option>
        <option value="success">成功</option>
        <option value="info">信息</option>
      </select>
      <input v-model="keyword" placeholder="搜索模块 / 内容" style="flex:1;min-width:180px" />
      <label class="chk"><input type="checkbox" v-model="autoScroll" /> 最新在前</label>
      <button class="btn" @click="copyLogs">复制日志</button>
      <button class="btn danger" @click="store.logs = []">清空</button>
    </div>

    <div class="terminal">
      <div v-if="!rows.length" class="empty">暂无日志。执行一次配置导入或二维码识别后，这里会出现解析详情。</div>
      <div v-for="l in (autoScroll ? rows : [...rows].reverse())" :key="l.id" class="log-line" :class="l.level">
        <span class="ts">{{ l.time }}</span>
        <span class="lv">{{ l.level.toUpperCase() }}</span>
        <span class="mod">{{ l.module }}</span>
        <span class="msg">{{ l.message }}</span>
        <div v-if="l.detail" class="detail mono">{{ l.detail }}</div>
      </div>
    </div>

    <div class="legend tiny dim">
      说明：日志只记录本地解析与配置生成事件。内核进程启动 / 系统代理 / TUN / 真实连接状态需接入内核运行层后才会产生。
    </div>
  </div>
</template>

<style scoped>
.panel h3 { font-size: 15px; margin-bottom: 4px; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.sub { font-size: 12px; color: var(--text-muted); margin: 0; }
.cnt { font-size: 12px; color: var(--accent); white-space: nowrap; }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 14px 0; }
.chk { font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; }
.terminal { background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 10px 12px; max-height: 480px; overflow: auto; }
.empty { font-size: 12px; color: var(--text-muted); padding: 18px; text-align: center; }
.log-line { display: flex; flex-wrap: wrap; gap: 8px; font-family: var(--font-mono); font-size: 11.5px; line-height: 1.8; padding: 2px 0; border-bottom: 1px solid var(--table-border); color: var(--text-secondary); }
.ts { color: var(--text-faint); flex: none; }
.lv { flex: none; min-width: 56px; font-size: 10px; text-align: center; border-radius: 3px; height: fit-content; margin-top: 3px; color: var(--accent); background: var(--accent-dim); }
.log-line.error .lv { color: var(--danger); background: var(--danger-dim); }
.log-line.warn .lv { color: var(--warning); background: rgba(245,158,11,.14); }
.log-line.success .lv { color: var(--success); background: var(--success-dim); }
.mod { flex: none; color: var(--purple); }
.msg { flex: 1; min-width: 200px; word-break: break-word; }
.log-line.error .msg { color: var(--error-text); } .log-line.warn .msg { color: var(--warn-text); }
.detail { flex-basis: 100%; padding-left: 130px; color: var(--text-muted); font-size: 10.5px; word-break: break-all; }
.tiny { font-size: 11px; } .dim { color: var(--text-muted); }
.legend { margin-top: 10px; line-height: 1.7; }
</style>
