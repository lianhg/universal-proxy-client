/**
 * Xray StatsService gRPC 统计 —— 纯逻辑层
 *
 * Xray 的实时流量统计走 gRPC（StatsService.QueryStats），不是 clash_api 的 HTTP JSON。
 * 这里手工实现最小化的 protobuf 编解码与 gRPC 帧封装，不引入任何第三方依赖：
 * - QueryStats 请求体是空消息
 * - 响应是 message StatResponse { repeated Stat stat = 1 }
 *   message Stat { string name = 1; int64 value = 2 }
 *
 * 计数器名形如：
 *   inbound>>>socks-in>>>traffic>>>uplink
 *   inbound>>>socks-in>>>traffic>>>downlink
 *   outbound>>>proxy>>>traffic>>>uplink
 * 用户视角：inbound.uplink = 用户上传，inbound.downlink = 用户下载。
 * api 入站（本程序自己的轮询流量）必须剔除，否则会污染真实速率。
 */

/** gRPC 请求路径：服务全名 + 方法名 */
export const QUERY_STATS_PATH = '/xray.app.stats.command.StatsService/QueryStats';

/** 生成的 Xray 配置中，stats api 入站 / 出站的 tag（与 config-builder 保持一致） */
export const XRAY_API_INBOUND_TAG = 'api-in';
export const XRAY_API_OUTBOUND_TAG = 'api';

export interface XrayStat {
  name: string;
  value: number;
}

/**
 * gRPC 消息帧：1 字节压缩标志（0）+ 4 字节大端长度 + payload。
 * QueryStats 的请求体是空消息，即 5 字节全零帧。
 */
export function grpcFrame(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  // 只用标准 Web API：本模块会被渲染层（浏览器预览路径）间接打包，
  // Node 专有 API 会在模块加载瞬间抛 "is not defined" 导致整个界面黑屏。
  const buf = new Uint8Array(5 + payload.length);
  new DataView(buf.buffer).setUint32(1, payload.length, false);
  if (payload.length) buf.set(payload, 5);
  return buf;
}

/** QueryStats 的空请求帧（常量，避免每次轮询重复分配） */
export const EMPTY_QUERY_STATS_FRAME = grpcFrame();

/* ───────────────────── protobuf 解码 ───────────────────── */

interface Varint {
  value: bigint;
  next: number;
}

/** 读一个 varint（最多 10 字节 / 64bit）；截断或超长视为数据损坏 */
function readVarint(buf: Uint8Array, pos: number): Varint {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  for (;;) {
    if (p >= buf.length) throw new Error('protobuf varint 被截断');
    const b = buf[p]!;
    result |= BigInt(b & 0x7f) << shift;
    p++;
    if ((b & 0x80) === 0) return { value: result, next: p };
    shift += 7n;
    if (shift >= 70n) throw new Error('protobuf varint 超长（>64bit）');
  }
}

/** 解析 message Stat { string name = 1; int64 value = 2 } */
function parseStat(sub: Uint8Array): XrayStat {
  let name = '';
  let value = 0n;
  let pos = 0;
  while (pos < sub.length) {
    const tag = readVarint(sub, pos);
    pos = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (field === 1 && wire === 2) {
      const len = readVarint(sub, pos);
      pos = len.next;
      name = new TextDecoder().decode(sub.subarray(pos, pos + Number(len.value)));
      pos += Number(len.value);
    } else if (field === 2 && wire === 0) {
      const v = readVarint(sub, pos);
      pos = v.next;
      value = v.value;
    } else {
      pos = skipField(sub, pos, wire);
    }
  }
  const n = Number(value);
  return { name, value: Number.isFinite(n) ? n : 0 };
}

/** 跳过未知字段（只处理为解析 StatResponse 所需的 wireType） */
function skipField(buf: Uint8Array, pos: number, wire: number): number {
  switch (wire) {
    case 0: return readVarint(buf, pos).next;
    case 1: return pos + 8;
    case 2: {
      const len = readVarint(buf, pos);
      return len.next + Number(len.value);
    }
    case 5: return pos + 4;
    default: throw new Error(`protobuf wireType ${wire} 不受支持（数据可能已损坏）`);
  }
}

/**
 * 解析 QueryStats 响应 payload（不含 5 字节 gRPC 前缀）。
 * message StatResponse { repeated Stat stat = 1 }
 * 结构不对时抛错——宁可报错也不返回半成品。
 */
export function parseQueryStats(buf: Uint8Array): XrayStat[] {
  const out: XrayStat[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (field === 1 && wire === 2) {
      const len = readVarint(buf, pos);
      pos = len.next;
      const end = pos + Number(len.value);
      if (end > buf.length) throw new Error('protobuf 子消息长度越界');
      out.push(parseStat(buf.subarray(pos, end)));
      pos = end;
    } else {
      pos = skipField(buf, pos, wire);
    }
  }
  return out;
}

/** gRPC DATA 帧：剥掉 5 字节前缀，返回 protobuf payload（单消息响应） */
export function stripGrpcPrefix(data: Uint8Array): Uint8Array {
  if (data.length < 5) throw new Error(`gRPC 响应过短（${data.length} 字节），不足消息头`);
  const compressed = data[0]!;
  if (compressed !== 0) throw new Error('gRPC 响应声明了压缩，本程序未启用压缩消息');
  const size = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, false);
  if (size !== data.length - 5) {
    throw new Error(`gRPC 消息长度不匹配：头声明 ${size}，实际 ${data.length - 5}`);
  }
  return data.subarray(5);
}

/* ───────────────────── 计数器归一化 ───────────────────── */

const INBOUND_TRAFFIC = /^inbound>>>(.+?)>>>traffic>>>(uplink|downlink)$/;

export interface TrafficTotals {
  uploadTotal: number;
  downloadTotal: number;
}

/**
 * 汇总入站流量计数器为用户视角的上/下行累计字节。
 * 剔除 api 入站（那是本程序轮询自身的流量）与不认识的计数器。
 */
export function sumXrayTraffic(stats: XrayStat[], apiInboundTag = XRAY_API_INBOUND_TAG): TrafficTotals {
  let uploadTotal = 0;
  let downloadTotal = 0;
  for (const s of stats) {
    const m = INBOUND_TRAFFIC.exec(String(s.name ?? ''));
    if (!m) continue;
    const tag = m[1]!;
    if (tag === apiInboundTag) continue;
    if (m[2] === 'uplink') uploadTotal += s.value;
    else downloadTotal += s.value;
  }
  return { uploadTotal, downloadTotal };
}
