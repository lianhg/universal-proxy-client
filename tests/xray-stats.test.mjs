/**
 * Xray StatsService 统计 —— protobuf / gRPC 纯逻辑回归
 *
 * 请求/响应格式依据 Xray 的 xray.app.stats.command.StatsService：
 *   rpc QueryStats(EMPTY) returns (StatResponse)
 *   message StatResponse { repeated Stat stat = 1 }
 *   message Stat { string name = 1; int64 value = 2 }
 * 样例字节手工构造，不依赖任何外部库。
 */
import assert from 'node:assert/strict'
import X from '../.runtime-build/runtime/xray-stats.js'

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

/** 手工编码一个 message Stat { name, value }（field1 = name 字符串，field2 = value varint） */
function encodeStat(name, value) {
  const nameBuf = Buffer.from(name, 'utf8')
  const head = Buffer.from([0x0a, nameBuf.length]) // field1, wire2, len
  // varint 编码 value（最长 10 字节）
  const vBytes = []
  let v = BigInt(value)
  do {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) b |= 0x80
    vBytes.push(b)
  } while (v > 0n)
  const valHead = Buffer.from([0x10]) // field2, wire0
  const tail = Buffer.concat([head, nameBuf, valHead, Buffer.from(vBytes)])
  // 包一层 StatResponse：field1, wire2, len
  return Buffer.concat([Buffer.from([0x0a, tail.length]), tail])
}

const SAMPLE = [
  { name: 'inbound>>>socks-in>>>traffic>>>uplink', value: 1234 },
  { name: 'inbound>>>socks-in>>>traffic>>>downlink', value: 567800 },
  { name: 'inbound>>>http-in>>>traffic>>>uplink', value: 100 },
  { name: 'inbound>>>http-in>>>traffic>>>downlink', value: 200000 },
  { name: 'outbound>>>proxy>>>traffic>>>uplink', value: 1100 },
  { name: 'outbound>>>proxy>>>traffic>>>downlink', value: 560000 },
]

t('空请求 gRPC 帧：5 字节、长度为 0', () => {
  const f = X.EMPTY_QUERY_STATS_FRAME
  assert.equal(f.length, 5)
  assert.equal(f[0], 0)
  assert.equal(new DataView(f.buffer, f.byteOffset, f.byteLength).getUint32(1, false), 0)
  assert.equal(X.QUERY_STATS_PATH, '/xray.app.stats.command.StatsService/QueryStats')
})

t('带 payload 的 gRPC 帧长度正确', () => {
  const payload = Buffer.from([1, 2, 3])
  const f = X.grpcFrame(payload)
  assert.equal(f.length, 8)
  assert.equal(new DataView(f.buffer, f.byteOffset, f.byteLength).getUint32(1, false), 3)
  assert.deepEqual([...f.subarray(5)], [1, 2, 3])
})

t('QueryStats 响应可完整解析出全部计数器', () => {
  const body = Buffer.concat(SAMPLE.map(s => encodeStat(s.name, s.value)))
  const stats = X.parseQueryStats(X.stripGrpcPrefix(X.grpcFrame(body)))
  assert.equal(stats.length, SAMPLE.length)
  for (let i = 0; i < SAMPLE.length; i++) {
    assert.equal(stats[i].name, SAMPLE[i].name)
    assert.equal(stats[i].value, SAMPLE[i].value)
  }
})

t('stripGrpcPrefix 拒绝过短 / 压缩 / 长度不匹配的响应', () => {
  assert.throws(() => X.stripGrpcPrefix(Buffer.from([0, 0])), /过短/);
  const bad = Buffer.alloc(9)
  bad[0] = 1 // compressed 标志
  assert.throws(() => X.stripGrpcPrefix(bad), /压缩/);
  const mismatch = Buffer.from([0, 0, 0, 0, 9, 1, 2])
  assert.throws(() => X.stripGrpcPrefix(mismatch), /长度不匹配/);
})

t('parseQueryStats 拒绝截断的数据', () => {
  assert.throws(() => X.parseQueryStats(Buffer.from([0x0a, 20, 1, 2])), /越界|截断/);
})

t('大数值（int64 范围内）不丢精度', () => {
  const big = 2 ** 40 + 7 // 1TB 级别，varint 5 字节
  const body = encodeStat('inbound>>>socks-in>>>traffic>>>downlink', big)
  const stats = X.parseQueryStats(body)
  assert.equal(stats[0].value, big)
})

t('sumXrayTraffic 只汇总入站上下行，剔除 api 入站', () => {
  const totals = X.sumXrayTraffic(SAMPLE)
  assert.equal(totals.uploadTotal, 1234 + 100, '上传 = 各入站 uplink 之和')
  assert.equal(totals.downloadTotal, 567800 + 200000, '下载 = 各入站 downlink 之和')
  // outbound 计数器不计入用户视角
  const withApi = [...SAMPLE,
    { name: 'inbound>>>api-in>>>traffic>>>uplink', value: 999999 },
    { name: 'inbound>>>api-in>>>traffic>>>downlink', value: 888888 },
    { name: 'outbound>>>direct>>>traffic>>>downlink', value: 777 },
  ]
  const t2 = X.sumXrayTraffic(withApi)
  assert.equal(t2.uploadTotal, 1334, 'api 入站的轮询流量必须被剔除')
  assert.equal(t2.downloadTotal, 767800, 'outbound 与 api 计数器不计入')
})

t('sumXrayTraffic 忽略不认识的计数器而不报错', () => {
  const t3 = X.sumXrayTraffic([
    { name: 'user>>>love@xray.com>>>traffic>>>uplink', value: 5 },
    { name: '', value: 0 },
    { name: 'inbound>>>x>>>traffic>>>weird', value: 9 },
  ])
  assert.deepEqual(t3, { uploadTotal: 0, downloadTotal: 0 })
})

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
