<script setup lang="ts">
/**
 * 国旗图标：优先显示随程序打包的本地 SVG 国旗（Windows 上 emoji 国旗会退化成字母框）。
 * 没有对应资源时显示两字码兜底，绝不用 emoji 冒充、也不留空白。
 */
import { computed, ref, watch } from 'vue'
import { flagUrl, normalizeCountryCode } from '../flags.js'

const props = defineProps<{
  code: string
  title?: string
  /** 宽度 px，高度按 4:3 自动算 */
  size?: number
}>()

const failed = ref(false)
const url = computed(() => flagUrl(props.code))
const label = computed(() => normalizeCountryCode(props.code) || '?')
const boxStyle = computed(() => props.size
  ? { width: props.size + 'px', height: Math.round(props.size * 0.75) + 'px' }
  : undefined)

watch(() => props.code, () => { failed.value = false })
</script>

<template>
  <span class="flag-icon" :title="title" :style="boxStyle">
    <img v-if="url && !failed" :src="url" :alt="label" draggable="false" @error="failed = true" />
    <span v-else class="flag-fallback">{{ label }}</span>
  </span>
</template>

<style scoped>
.flag-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 15px; flex: none; vertical-align: middle;
  border-radius: 2px; overflow: hidden; background: var(--bg-inset);
  box-shadow: 0 0 0 1px rgba(127, 127, 127, .35);
}
.flag-icon img { width: 100%; height: 100%; object-fit: cover; display: block; }
.flag-fallback { font-size: 9px; font-weight: 700; letter-spacing: .3px; color: var(--text-muted); }
</style>
