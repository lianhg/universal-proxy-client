/**
 * 全协议二维码智能识别中心
 *
 * 核心认知：二维码只是数据载体。解出文本后一律交给统一配置解析中心按内容判定
 * （分享链接 / 订阅地址 / Clash YAML / sing-box JSON / Xray JSON / WireGuard conf / 包装格式），
 * 绝不因为"扫到了码"就报导入成功。
 *
 * 支持的来源：摄像头实时、PNG/JPG/JPEG/WebP/BMP/GIF 图片、剪贴板图片或文本、
 *              屏幕截图、屏幕框选、多图批量、一图多码。
 *
 * 实现说明：当前用 jsQR + 多尺度网格切分做多码识别（零原生依赖、跨平台）。
 * 生产环境若需更高识别率，可把 decodeQRData 替换为 ZXing-CPP / OpenCV WASM 后端，接口不变。
 */

import jsqr from 'jsqr';
import type { ImportReport, UnifiedNode, RejectedItem, ParseIssue } from './model.js';
import { buildReport, issue, safeJson } from './util.js';
import { importQrPayload } from './index.js';

export type QrSource = 'camera' | 'file' | 'clipboard' | 'screen' | 'region' | 'batch';

export const SUPPORTED_IMAGE_TYPES = [
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp', 'image/gif',
] as const;

export const SUPPORTED_IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] as const;

export interface QrHit {
  text: string;
  source: QrSource;
  /** 文件名 / 摄像头名 / 屏幕标识 */
  origin: string;
  timestamp: number;
}

export interface FileScanResult {
  fileName: string;
  hits: QrHit[];
  error?: string;
}

export interface ScanController {
  stop: () => void;
  active: boolean;
}

export function isSupportedImage(file: { name?: string; type?: string }): boolean {
  const type = (file.type ?? '').toLowerCase();
  if (type && (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(type)) return true;
  const ext = (file.name ?? '').split('.').pop()?.toLowerCase() ?? '';
  return (SUPPORTED_IMAGE_EXT as readonly string[]).includes(ext);
}

/* ============================ 纯函数层：多码解码 ============================ */

function crop(
  data: Uint8ClampedArray, w: number, h: number,
  x: number, y: number, cw: number, ch: number,
): { data: Uint8ClampedArray; w: number; h: number } {
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const srcStart = ((y + row) * w + x) * 4;
    out.set(data.subarray(srcStart, srcStart + cw * 4), row * cw * 4);
  }
  return { data: out, w: cw, h: ch };
}

function tryDecode(data: Uint8ClampedArray, w: number, h: number): string | null {
  if (w < 16 || h < 16) return null;
  try {
    const r = jsqr(data, w, h, { inversionAttempts: 'attemptBoth' });
    return r?.data ?? null;
  } catch { return null; }
}

/**
 * 解码一帧图像，支持一图多码：
 * 1. 整图直扫；2. 2×2 / 3×3 网格切分补扫（带 8% 重叠，避免码被边界切开）；3. 结果去重。
 */
export function decodeQRData(data: Uint8ClampedArray, w: number, h: number): string[] {
  const found = new Set<string>();
  const whole = tryDecode(data, w, h);
  if (whole) found.add(whole);

  for (const grid of [2, 3]) {
    const cw = Math.floor(w / grid), ch = Math.floor(h / grid);
    const overlapX = Math.floor(cw * 0.08), overlapY = Math.floor(ch * 0.08);
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const x = Math.max(0, gx * cw - overlapX);
        const y = Math.max(0, gy * ch - overlapY);
        const bw = Math.min(w - x, cw + overlapX * 2);
        const bh = Math.min(h - y, ch + overlapY * 2);
        if (bw < 16 || bh < 16) continue;
        const sub = crop(data, w, h, x, y, bw, bh);
        const t = tryDecode(sub.data, sub.w, sub.h);
        if (t) found.add(t);
      }
    }
  }
  return [...found];
}

/* ============================ 浏览器层：图片 / 文件 ============================ */

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败（文件可能损坏或格式不受支持）')); };
    img.src = url;
  });
}

function imageToPixels(img: HTMLImageElement, scale = 1): { data: Uint8ClampedArray; w: number; h: number } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.floor(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建 Canvas 2D 上下文');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, w: canvas.width, h: canvas.height };
}

/** 解码单张图片（自动多尺度：原图 → 2 倍放大，提升小码识别率） */
export async function decodeQRImage(
  file: Blob & { name?: string },
  source: QrSource = 'file',
): Promise<QrHit[]> {
  if (!isSupportedImage(file)) {
    throw new Error(`不支持的图片格式「${file.name || file.type || '未知'}」；仅支持 PNG / JPG / JPEG / WebP / BMP / GIF`);
  }
  const img = await loadImage(file);
  const texts = new Set<string>();
  for (const scale of [1, 2]) {
    const px = imageToPixels(img, scale);
    decodeQRData(px.data, px.w, px.h).forEach(t => texts.add(t));
    if (texts.size) break;
  }
  return [...texts].map(text => ({
    text, source, origin: file.name ?? '图片', timestamp: Date.now(),
  }));
}

/** 批量多张图片：逐张解码，单张失败不影响其它文件 */
export async function decodeQRFiles(files: File[] | FileList): Promise<FileScanResult[]> {
  const list = Array.from(files as ArrayLike<File>);
  return Promise.all(list.map(async file => {
    try {
      return { fileName: file.name, hits: await decodeQRImage(file, 'batch') };
    } catch (e) {
      return { fileName: file.name, hits: [], error: e instanceof Error ? e.message : String(e) };
    }
  }));
}

/* ============================ 浏览器层：剪贴板 ============================ */

/**
 * 剪贴板识别：优先图片二维码，其次文本（文本直接当作配置内容交给解析中心，
 * 这样 Ctrl+V 粘贴 vmess:// 链接也能走同一条导入链路）。
 */
export async function readClipboard(): Promise<{ hits: QrHit[]; kind: 'image' | 'text' | 'empty'; note: string }> {
  const now = Date.now();
  try {
    const clip: any = (navigator as any).clipboard;
    if (clip?.read) {
      const items = await clip.read();
      for (const item of items) {
        for (const type of item.types ?? []) {
          if (!String(type).startsWith('image/')) continue;
          const blob: Blob = await item.getType(type);
          const hits = await decodeQRImage(Object.assign(blob, { name: '剪贴板图片' }), 'clipboard');
          if (hits.length) return { hits, kind: 'image', note: '从剪贴板图片中识别到二维码' };
        }
      }
    }
    if (clip?.readText) {
      const text = (await clip.readText()).trim();
      if (text) {
        return {
          hits: [{ text, source: 'clipboard', origin: '剪贴板文本', timestamp: now }],
          kind: 'text',
          note: '剪贴板是文本，已直接作为配置内容交给解析中心判定（不会当成二维码图片误报）',
        };
      }
    }
  } catch (e) {
    return { hits: [], kind: 'empty', note: `剪贴板读取被拒绝或不可用：${e instanceof Error ? e.message : String(e)}` };
  }
  return { hits: [], kind: 'empty', note: '剪贴板没有图片，也没有文本内容' };
}

/* ============================ 浏览器层：摄像头 / 屏幕 ============================ */

function framePixels(video: HTMLVideoElement, rect?: { x: number; y: number; w: number; h: number }): { data: Uint8ClampedArray; w: number; h: number } | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  const canvas = document.createElement('canvas');
  const r = rect ?? { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight };
  canvas.width = Math.max(1, Math.floor(r.w));
  canvas.height = Math.max(1, Math.floor(r.h));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
  return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, w: canvas.width, h: canvas.height };
}

export interface LiveScanOptions {
  /** 屏幕框选区域（视频坐标系） */
  region?: { x: number; y: number; w: number; h: number };
  /** 扫描间隔 ms */
  intervalMs?: number;
  /** 最长扫描时间 ms，0 = 不限 */
  timeoutMs?: number;
  /** 同一内容是否只回调一次 */
  dedupe?: boolean;
  onFound: (hit: QrHit) => void;
  onError?: (message: string) => void;
}

/** 摄像头实时扫码 */
export function startCameraScan(video: HTMLVideoElement, opts: LiveScanOptions): ScanController {
  let stream: MediaStream | null = null;
  let stopped = false;
  let timer: any = null;
  let timeout: any = null;
  const seen = new Set<string>();

  const controller: ScanController = {
    active: true,
    stop: () => {
      stopped = true;
      controller.active = false;
      if (timer) clearTimeout(timer);
      if (timeout) clearTimeout(timeout);
      stream?.getTracks().forEach(t => t.stop());
      stream = null;
    },
  };

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
      video.srcObject = stream;
      await video.play();
      const tick = () => {
        if (stopped) return;
        const px = framePixels(video, opts.region);
        if (px) {
          for (const text of decodeQRData(px.data, px.w, px.h)) {
            if (opts.dedupe !== false && seen.has(text)) continue;
            seen.add(text);
            opts.onFound({ text, source: opts.region ? 'region' : 'camera', origin: '摄像头实时扫码', timestamp: Date.now() });
          }
        }
        timer = setTimeout(tick, opts.intervalMs ?? 250);
      };
      tick();
      if (opts.timeoutMs) timeout = setTimeout(() => controller.stop(), opts.timeoutMs);
    } catch (e) {
      controller.active = false;
      opts.onError?.(e instanceof Error ? e.message : String(e));
    }
  })();
  return controller;
}

/* ============================ 从二维码内容到导入预览 ============================ */

/** 批量合并多个二维码的解析结果，保留来源与逐条失败原因 */
export function previewQrHits(hits: QrHit[]): ImportReport {
  if (!hits.length) {
    return buildReport('unknown', '未识别到二维码', [], [], [issue('warning', 'PARSE_ERROR', '没有可处理的二维码内容')]);
  }
  const nodes: UnifiedNode[] = [];
  const rejected: RejectedItem[] = [];
  const issues: ParseIssue[] = [];
  const duplicates: UnifiedNode[] = [];
  const seen = new Set<string>();
  let requiresFetch: ImportReport['requiresFetch'];

  hits.forEach((hit, i) => {
    const r = importQrPayload(hit.text, hit.source, { source: `qr:${hit.source}:${hit.origin}`, existingFingerprints: [...seen] });
    for (const n of r.nodes) {
      if (seen.has(n.fingerprint)) duplicates.push(n);
      else { seen.add(n.fingerprint); nodes.push(n); }
    }
    // 解析中心内部已判定的重复节点也要汇总，不能静默消失
    duplicates.push(...r.duplicates);
    rejected.push(...r.rejected.map(x => ({ ...x, location: `二维码 ${i + 1}（${hit.origin}）：${x.location ?? ''}` })));
    issues.push(...r.issues.map(x => ({ ...x, location: x.location ?? `二维码 ${i + 1}` })));
    if (r.requiresFetch) requiresFetch = r.requiresFetch;
  });

  const report = buildReport(
    nodes.length ? 'qr-payload' : 'unknown',
    `${hits.length} 个二维码 / ${nodes.length} 个节点`,
    nodes, rejected, issues, duplicates, requiresFetch,
  );
  report.issues.unshift(issue('info', 'SECURITY',
    `共扫描 ${hits.length} 个二维码，识别出 ${nodes.length} 个节点、${rejected.length} 项无法识别。全部结果仅为预览，未自动导入或执行。`,
    { value: hits.length }));
  return report;
}

/** 批量文件的解析结果（含每张图片的失败说明） */
export function previewFileScans(results: FileScanResult[]): ImportReport {
  const hits = results.flatMap(r => r.hits);
  const report = previewQrHits(hits);
  for (const r of results) {
    if (r.error) report.issues.push(issue('error', 'PARSE_ERROR', `图片「${r.fileName}」处理失败：${r.error}`, { location: r.fileName }));
    else if (!r.hits.length) report.issues.push(issue('warning', 'PARSE_ERROR', `图片「${r.fileName}」中未检测到二维码`, { location: r.fileName }));
  }
  return report;
}

/** 把二维码内容做结构化摘要，供 UI 在预览里显示（不暴露凭据全文） */
export function summarizeQrPayload(text: string): { kind: string; preview: string; multiNode: boolean } {
  const t = text.trim();
  const lines = t.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  const multiNode = lines.filter(l => /^[a-z][a-z0-9+.-]*:\/\//i.test(l)).length > 1;
  let kind = '未知内容';
  // 注意：所有前缀正则必须整体锚定，否则 "type: vless" 这类 YAML 会被误判成分享链接
  if (/^https?:\/\//i.test(t)) kind = '订阅 / 配置 URL';
  else if (/^(v2rayn|v2rayng|clash|clashmeta|sub|ssrsub|ssd|sing-box|shadowrocket|quantumult|surge):\/\//i.test(t)) kind = '客户端包装格式';
  else if (/^(vmess|vless|trojan|ss|ssr|tuic|hy2?|hysteria2?|wireguard|wg|anytls|naive(\+https|\+quic)?|ssh|socks\d?[ah]?|https?):\/\//i.test(t)) kind = '分享链接';
  else if (t.startsWith('{')) {
    const obj = safeJson<any>(t);
    kind = obj?.outbounds ? '完整内核配置（JSON）' : obj?.proxies ? 'Clash 配置（JSON）' : 'JSON 内容';
  }
  else if (/^\s*proxies\s*:/im.test(t)) kind = 'Clash / Mihomo YAML';
  else if (/^\[Interface\]/im.test(t)) kind = 'WireGuard 配置';
  return { kind, preview: t.length > 160 ? t.slice(0, 160) + '…' : t, multiNode };
}
