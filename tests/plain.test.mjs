/**
 * 跨 IPC 传参脱壳（toPlain）回归测试
 * 运行：node tests/plain.test.mjs （需先 npx tsc -p tsconfig.hub.build.json）
 *
 * 背景：Vue / Pinia 的 state 是 Proxy，Electron 的 contextBridge 与
 * structuredClone 都不能克隆 Proxy，直接传参会抛
 * "An object could not be cloned."（Vue 错误参考 runtime-5）。
 */
import assert from 'node:assert/strict';
import { toPlain } from '../.hub-build/index.js';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' :: ' + e.message); }
}

/** 尽量用真正的 Vue reactive；拿不到就退化成等价 Proxy，效果一致（都不可克隆） */
let makeReactive;
try {
  const { reactive } = await import('vue');
  makeReactive = reactive;
} catch {
  makeReactive = (obj) => new Proxy(obj, {
    get(target, key, recv) { return Reflect.get(target, key, recv); },
    set(target, key, val, recv) { return Reflect.set(target, key, val, recv); },
  });
}

const canClone = (v) => { try { structuredClone(v); return true; } catch { return false; } };

/* ─────────────────────────── 核心：Proxy 脱壳 ─────────────────────────── */

t('Proxy 对象本身不能被 structuredClone（复现 runtime-5）', () => {
  const state = makeReactive({ name: 'node-a', port: 443 });
  assert.equal(canClone(state), false, '前提不成立：这个环境里 Proxy 竟然可以克隆');
});

t('toPlain 之后可以 structuredClone', () => {
  const state = makeReactive({ name: 'node-a', server: '1.2.3.4', port: 443 });
  assert.equal(canClone(toPlain(state)), true);
});

t('嵌套多层 Proxy 也要脱干净（不能只脱最外层）', () => {
  const state = makeReactive({
    node: makeReactive({ server: 'example.com', tls: makeReactive({ sni: 'example.com', alpn: ['h2', 'http/1.1'] }) }),
    peers: [makeReactive({ name: 'p1', port: 8443 })],
    routing: makeReactive({ rules: [makeReactive({ type: 'domain', value: 'a.com' })], defaultAction: 'proxy' }),
  });
  const plain = toPlain(state);
  assert.equal(canClone(plain), true);
  // 深层值仍然正确
  assert.equal(plain.node.tls.sni, 'example.com');
  assert.deepEqual(plain.node.tls.alpn, ['h2', 'http/1.1']);
  assert.equal(plain.peers[0].port, 8443);
  assert.equal(plain.routing.rules[0].value, 'a.com');
});

t('数组里的 Proxy 元素逐个脱壳', () => {
  const nodes = [makeReactive({ id: '1' }), makeReactive({ id: '2' })];
  assert.equal(canClone(nodes), false);
  assert.equal(canClone(toPlain(nodes)), true);
});

t('脱壳后不与原对象共享引用（避免主进程间接改到响应式数据）', () => {
  const state = makeReactive({ nested: { v: 1 } });
  const plain = toPlain(state);
  assert.notEqual(plain, state);
  assert.notEqual(plain.nested, state.nested);
});

/* ─────────────────────────── 类型保真 ─────────────────────────── */

t('Date 保留为 Date 且时间一致', () => {
  const d = new Date('2026-11-11T02:30:00.000Z');
  const out = toPlain({ addedAt: d });
  assert.ok(out.addedAt instanceof Date);
  assert.equal(out.addedAt.getTime(), d.getTime());
});

t('Map / Set 保留类型并可克隆', () => {
  const out = toPlain({ m: new Map([['a', { v: 1 }]]), s: new Set([1, 2]) });
  assert.ok(out.m instanceof Map);
  assert.ok(out.s instanceof Set);
  assert.equal(canClone(out), true);
});

t('undefined / null / 0 / false / 空串全部保留（不能像 JSON 那样丢字段）', () => {
  const src = { a: undefined, b: null, c: 0, d: false, e: '', f: 'x' };
  const out = toPlain(src);
  assert.deepEqual(Object.keys(out).sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(out.a, undefined);
  assert.equal(out.b, null);
  assert.equal(out.c, 0);
  assert.equal(out.d, false);
  assert.equal(out.e, '');
  assert.equal(out.f, 'x');
});

t('原始值原样返回', () => {
  for (const v of ['s', 1, 0, true, false, null, undefined]) {
    assert.equal(toPlain(v), v);
  }
});

t('类实例原样返回（交给 IPC 决定，不强行摊平成普通对象）', () => {
  class Custom { constructor() { this.v = 1; } }
  const c = new Custom();
  assert.equal(toPlain(c), c);
});

t('真实节点形状（UnifiedNode）脱壳后能完整克隆且关键字段不丢', () => {
  const node = makeReactive({
    id: 'n1', name: '香港 01', protocol: 'vless', server: 'hk.example.com', port: 443,
    uuid: 'uuid-xxxx', transport: 'ws', security: 'reality',
    tls: makeReactive({ sni: 'hk.example.com', alpn: ['h2'] }),
    reality: makeReactive({ publicKey: 'pk', shortId: 'ab' }),
    transportSettings: makeReactive({ path: '/ws', host: 'hk.example.com' }),
    extras: { custom: 'keep-me' },
    issues: [], kernels: ['xray', 'sing-box'], kernel: 'xray',
    lossless: true, fingerprint: 'abc123', addedAt: 1762800000000,
  });
  const out = toPlain(node);
  assert.equal(canClone(out), true);
  assert.equal(out.reality.publicKey, 'pk');
  assert.equal(out.transportSettings.path, '/ws');
  assert.equal(out.extras.custom, 'keep-me');
  assert.deepEqual(out.kernels, ['xray', 'sing-box']);
});

/* ─────────────────────────── 汇总 ─────────────────────────── */

console.log('');
if (fail) {
  console.log(`\n❌ 失败 ${fail} / 共 ${pass + fail}`);
  for (const [name, e] of failures) console.log(`\n[${name}]\n${e.stack}`);
  process.exit(1);
}
console.log(`✅ toPlain 全部通过（${pass} 项）`);
