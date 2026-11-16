<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../store.js'
import {
  THEME_DESCRIPTIONS, THEME_ICONS, THEME_LABELS, THEME_MODES,
} from '../theme.js'

const store = useAppStore()

const options = THEME_MODES.map(mode => ({
  mode,
  label: THEME_LABELS[mode],
  icon: THEME_ICONS[mode],
  desc: THEME_DESCRIPTIONS[mode],
}))

const currentLabel = computed(() => THEME_LABELS[store.theme])
const effectiveText = computed(() => (store.resolvedTheme === 'dark' ? '黑夜' : '白天'))
const effectiveHint = computed(() => store.theme === 'system'
  ? `当前实际生效：${effectiveText.value} · 跟随 Windows 深色/浅色设置自动变化`
  : `当前实际生效：${effectiveText.value}`)
</script>

<template>
  <section class="panel appearance">
    <div class="ap-head">
      <div>
        <h3>外观 / 主题</h3>
        <p class="ap-sub">选择界面配色。设置会被记住，下次启动自动应用，切换即时生效、无需重启。</p>
      </div>
      <span class="ap-badge">{{ currentLabel }}</span>
    </div>

    <div class="ap-choices">
      <button v-for="o in options" :key="o.mode"
              :class="['ap-choice', { active: store.theme === o.mode }]"
              :aria-pressed="store.theme === o.mode"
              @click="store.setTheme(o.mode)">
        <span class="ap-icon">{{ o.icon }}</span>
        <span class="ap-text"><b>{{ o.label }}</b><small>{{ o.desc }}</small></span>
        <span v-if="store.theme === o.mode" class="ap-check">&#x2713;</span>
      </button>
    </div>

    <div class="ap-foot">
      <span class="ap-dot" :class="store.resolvedTheme"></span>
      <span>{{ effectiveHint }}</span>
      <span class="ap-tip">侧边栏左下角也能快速切换</span>
    </div>
  </section>
</template>

<style scoped>
.appearance { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 16px; box-shadow: var(--shadow-sm); }
.ap-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.ap-head h3 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
.ap-sub { font-size: 12px; color: var(--text-muted); line-height: 1.6; margin: 0; }
.ap-badge { flex: none; font-size: 11px; color: var(--accent); background: var(--accent-dim); border: 1px solid var(--border); border-radius: var(--radius-full); padding: 3px 10px; }
.ap-choices { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.ap-choice { display: flex; align-items: center; gap: 10px; text-align: left; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-inset); color: var(--text); font-family: inherit; transition: background var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast); }
.ap-choice:hover { background: var(--surface-hover); border-color: var(--border-strong); }
.ap-choice.active { border-color: var(--accent); background: var(--accent-dim); box-shadow: 0 0 0 2px var(--accent-dim); }
.ap-icon { font-size: 22px; line-height: 1; flex: none; }
.ap-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.ap-text b { font-size: 13px; font-weight: 600; }
.ap-text small { font-size: 11px; color: var(--text-muted); line-height: 1.5; }
.ap-check { margin-left: auto; flex: none; color: var(--accent); font-size: 15px; font-weight: 700; }
.ap-foot { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 11.5px; color: var(--text-secondary); flex-wrap: wrap; }
.ap-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.ap-dot.dark { background: #1e293b; border: 1px solid var(--border-strong); }
.ap-dot.light { background: #f8fafc; border: 1px solid var(--border-strong); }
.ap-tip { margin-left: auto; color: var(--text-faint); }
@media (max-width: 900px) { .ap-choices { grid-template-columns: 1fr; } .ap-tip { margin-left: 0; } }
</style>
