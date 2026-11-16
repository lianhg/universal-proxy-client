/**
 * 轻量 YAML 子集解析器 —— 专为 Clash / Mihomo / Clash Verge 配置设计。
 * 项目未引入 yaml 依赖；这里实现配置导入所需的子集：
 *   映射、序列、嵌套缩进、标量、行内数组 []、行内映射 {}、引号、块标量 | >、注释。
 * 解析不了的复杂语法会记入 warnings，由上层明确提示，不静默吞掉参数。
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

export interface YamlParseResult { value: YamlValue; warnings: string[] }

interface Line { indent: number; text: string; raw: string; lineNo: number }

/** 按顶层分隔符切分（忽略引号 / 括号内的分隔符） */
export function splitTopLevel(input: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0, quote = '', buf = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      buf += c;
      if (c === quote && input[i - 1] !== '\\') quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < input.length) buf += input[++i];
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '[' || c === '{' || c === '(') { depth++; buf += c; continue; }
    if (c === ']' || c === '}' || c === ')') { depth--; buf += c; continue; }
    if (c === sep && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote && line[i - 1] !== '\\') quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

export function parseScalar(raw: string): YamlValue {
  let s = raw.trim();
  if (!s || s === '~' || /^null$/i.test(s)) return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const q = s[0];
    s = s.slice(1, -1);
    return q === '"' ? s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : s.replace(/''/g, "'");
  }
  if (/^(true|yes|on)$/i.test(s)) return true;
  if (/^(false|no|off)$/i.test(s)) return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? splitTopLevel(inner).map(parseScalar) : [];
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const obj: Record<string, YamlValue> = {};
    const inner = s.slice(1, -1).trim();
    if (!inner) return obj;
    for (const part of splitTopLevel(inner)) {
      const c = part.indexOf(':');
      if (c < 0) continue;
      obj[String(parseScalar(part.slice(0, c)) ?? '').trim()] = parseScalar(part.slice(c + 1));
    }
    return obj;
  }
  return s;
}

function findColon(text: string): number {
  let quote = '', depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== '\\') quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[' || c === '{') { depth++; continue; }
    if (c === ']' || c === '}') { depth--; continue; }
    if (c === ':' && depth === 0 && (i === text.length - 1 || /\s/.test(text[i + 1]))) return i;
  }
  return -1;
}

function isSeqStart(text: string): boolean { return text === '-' || text.startsWith('- '); }

function toLines(input: string): Line[] {
  const out: Line[] = [];
  input.split(/\r?\n/).forEach((raw, i) => {
    const cleaned = stripComment(raw);
    if (!cleaned.trim()) return;
    out.push({ indent: cleaned.match(/^ */)?.[0].length ?? 0, text: cleaned.trim(), raw: cleaned, lineNo: i + 1 });
  });
  return out;
}

interface Ctx { lines: Line[]; warnings: string[] }

function parseNode(ctx: Ctx, pos: number, indent: number): { value: YamlValue; next: number } {
  const line = ctx.lines[pos];
  if (!line) return { value: null, next: pos };
  return isSeqStart(line.text) ? parseSeq(ctx, pos, indent) : parseMap(ctx, pos, indent);
}

function parseMap(ctx: Ctx, pos: number, indent: number): { value: YamlValue; next: number } {
  const obj: Record<string, YamlValue> = {};
  let i = pos;
  while (i < ctx.lines.length) {
    const l = ctx.lines[i];
    if (l.indent < indent || isSeqStart(l.text)) break;
    if (l.indent > indent) { ctx.warnings.push(`第 ${l.lineNo} 行缩进异常，已跳过`); i++; continue; }
    const colon = findColon(l.text);
    if (colon < 0) { i++; continue; }
    const key = String(parseScalar(l.text.slice(0, colon)) ?? '').trim();
    const rest = l.text.slice(colon + 1).trim();
    if (rest === '|' || rest === '>') {
      const chunks: string[] = [];
      i++;
      while (i < ctx.lines.length && ctx.lines[i].indent > indent) { chunks.push(ctx.lines[i].raw.trim()); i++; }
      obj[key] = rest === '|' ? chunks.join('\n') : chunks.join(' ');
      continue;
    }
    if (rest) { obj[key] = parseScalar(rest); i++; continue; }
    if (i + 1 < ctx.lines.length && ctx.lines[i + 1].indent > indent) {
      const sub = parseNode(ctx, i + 1, ctx.lines[i + 1].indent);
      obj[key] = sub.value;
      i = sub.next;
    } else { obj[key] = null; i++; }
  }
  return { value: obj, next: i };
}

function parseSeq(ctx: Ctx, pos: number, indent: number): { value: YamlValue; next: number } {
  const arr: YamlValue[] = [];
  let i = pos;
  while (i < ctx.lines.length && ctx.lines[i].indent === indent && isSeqStart(ctx.lines[i].text)) {
    const rest = ctx.lines[i].text.slice(1).trim();
    const child: Line[] = [];
    if (rest) child.push({ indent: 0, text: rest, raw: rest, lineNo: ctx.lines[i].lineNo });
    i++;
    while (i < ctx.lines.length && ctx.lines[i].indent > indent) {
      const l = ctx.lines[i];
      child.push({ ...l, indent: Math.max(0, l.indent - indent - 2) });
      i++;
    }
    if (!child.length) { arr.push(null); continue; }
    // 序列项首行是标量 / 行内结构 → 直接解析；否则整块独立解析
    if (child.length === 1 && (findColon(child[0].text) < 0 || /^[{[]/.test(child[0].text))) {
      arr.push(parseScalar(child[0].text.replace(/^-\s*/, '')));
    } else {
      arr.push(parseNode({ lines: child, warnings: ctx.warnings }, 0, 0).value);
    }
  }
  return { value: arr, next: i };
}

/** 解析 YAML 文本为 JS 值（子集） */
export function parseYaml(input: string): YamlParseResult {
  const warnings: string[] = [];
  const trimmed = input.trim();
  // 行内映射 / 数组：整个文本就是一个标量（Clash 常见 "- {name: x, type: ss}")
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return { value: parseScalar(trimmed), warnings };
  }
  const lines = toLines(input);
  if (!lines.length) return { value: null, warnings };
  const { value } = parseNode({ lines, warnings }, 0, lines[0].indent);
  return { value, warnings };
}

/** 提取某个顶层 key 下每个列表项的原始 YAML 文本片段（用于完整保留 raw） */
export function extractListBlocks(input: string, key: string): string[] {
  const lines = input.split(/\r?\n/);
  const keyRe = new RegExp(`^\\s{0,2}${key}\\s*:\\s*(?:#.*)?$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (keyRe.test(lines[i])) { start = i + 1; break; }
  if (start < 0) return [];
  const blocks: string[][] = [];
  let cur: string[] | null = null;
  let listIndent = -1;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent === 0 && !line.trim().startsWith('#')) break; // 下一个顶层键
    const isItem = /^(\s*)-\s?/.test(line) && (listIndent < 0 ? true : indent === listIndent);
    if (isItem) {
      if (listIndent < 0) listIndent = indent;
      if (cur) blocks.push(cur);
      cur = [line];
    } else if (cur) cur.push(line);
  }
  if (cur) blocks.push(cur);
  return blocks.map(b => b.join('\n'));
}

/** 把 "  - name: x\n    type: ss" 反缩进成独立 YAML 映射文本 */
export function listItemToYaml(block: string): string {
  const lines = block.split(/\r?\n/);
  const m = lines[0].match(/^(\s*)-\s?(.*)$/);
  if (!m) return block;
  const base = m[1].length;
  const out = [m[2]];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const indent = l.match(/^ */)?.[0].length ?? 0;
    out.push(' '.repeat(Math.max(0, indent - base - 2)) + l.trimStart());
  }
  return out.join('\n');
}
