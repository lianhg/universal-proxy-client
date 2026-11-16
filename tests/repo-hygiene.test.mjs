#!/usr/bin/env node
/* 仓库卫生守卫：确保入库文件里不再出现真实节点信息（IP / 订阅节点名 / 密码样式）。
   背景：v1.1.2 之前，tests 的测试数据里残留过真实订阅节点 203.0.113.10（含节点名与疑似密码），
   已随历史重写清除。本测试钉死工作区入库文件，防止再犯。 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

let pass = 0, fail = 0
const failures = []
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' :: ' + e.message) }
}

/** 允许出现的 IP：RFC 5737 文档保留、回环/私网、RFC 2544 fake-ip 段，以及少量公共服务 DNS */
const ALLOW_IP = new Set(['223.5.5.5', '119.29.29.29', '8.8.8.8', '1.1.1.1', '9.9.9.9', '1.2.3.4', '5.6.7.8'])
function ipAllowed(ip) {
  if (ALLOW_IP.has(ip)) return true
  const [a, b] = ip.split('.').map(Number)
  if (a === 127 || a === 10 || a === 0 || a >= 224) return true            // 回环 / 私网 / 保留
  if (a === 172 && b >= 16 && b <= 31) return true                          // 私网
  if (a === 192 && b === 168) return true                                   // 私网
  if (a === 198 && b === 18) return true                                    // RFC 2544 fake-ip 段
  if (a === 169 && b === 254) return true                                   // 链路本地
  if (a === 192 && b === 0 && ip.startsWith('192.0.2.')) return true        // RFC 5737
  if (a === 198 && b === 51 && ip.startsWith('198.51.100.')) return true    // RFC 5737
  if (a === 203 && b === 0 && ip.startsWith('203.0.113.')) return true      // RFC 5737
  return false
}
const PUBLIC_IP = /(?<![\d.A-Za-z])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\dA-Za-z])/g

const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean)
  .filter(f => !f.startsWith('design/png/') && !f.startsWith('src/renderer/flags/svg/'))
  .filter(f => /\.(ts|vue|mjs|js|json|md|html|css|yml|yaml|py|ps1|bat|txt)$/.test(f))

t('任何入库文件都不再出现真实节点 IP 203.0.113.10', () => {
  for (const f of tracked) assert.ok(!readFileSync(f, 'utf8').includes('203.0.113.10'), `${f} 含真实节点 IP`)
})

t('测试与源码里的 IP 只允许文档保留 / 私网 / 白名单公共服务', () => {
  for (const f of tracked) {
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(PUBLIC_IP)) {
      assert.ok(ipAllowed(m[0]), `${f} 出现不明公网 IP：${m[0]}（测试数据请改用 203.0.113.x；若是公共服务请加入白名单并注明）`)
    }
  }
})

t('测试数据不再含订阅来源样式节点名（如 free-nodes / wo SS-N）', () => {
  for (const f of tracked.filter(f => f.startsWith('tests/'))) {
    assert.ok(!/free-nodes|wo SS-\d/.test(readFileSync(f, 'utf8')), `${f} 疑似残留订阅节点名`)
  }
})

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
if (fail) { for (const [n, e] of failures) console.error(`✗ ${n}\n  ${e.message}`); process.exit(1) }
