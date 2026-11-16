/**
 * 屏幕二维码取图（透明框选 / 整屏截图）回归测试
 * 运行：node tests/qr-region.test.mjs
 *
 * 亮哥反馈：点「框选屏幕区域」后只在窗口里看到一块空白，还可能报 Not supported，
 * 根本看不见屏幕上那张二维码。根因是 Electron 渲染层拿不到 getDisplayMedia。
 *
 * 这里锁死新方案的三条红线：
 * 1. 框选层必须是「真透明」——框内一个像素都不绘制，背后二维码原样可见；
 * 2. 先隐藏透明层再抓屏，绝不把压暗遮罩截进图里；
 * 3. 截图只在内存里走一圈（PNG dataURL 回渲染层解码），不落盘、不上传、不执行二维码内容。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + (e?.message ?? e)); }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const main = read('src/main.ts');
const region = read('src/main/qr-region.ts');
const overlay = read('src/main/region-overlay.html');
const panel = read('src/renderer/components/QrScannerPanel.vue');
const api = read('src/renderer/api.ts');
const preload = read('src/preload/index.ts');
const qrHub = read('src/core/hub/qr.ts');

console.log('\n=== 屏幕二维码：透明框选取图 ===');

t('主进程注册两个取图 IPC，preload / api 三层链路齐全', () => {
  assert.match(main, /ipcMain\.handle\('qr:pick-region', \(\) => pickScreenRegion\(\)\)/, '缺少框选取图 IPC');
  assert.match(main, /ipcMain\.handle\('qr:capture-screen', \(\) => captureScreen\(mainWindow\)\)/, '缺少整屏取图 IPC');
  assert.match(preload, /qrPickRegion: \(\) => ipcRenderer\.invoke\("qr:pick-region"\)/);
  assert.match(preload, /qrCaptureScreen: \(\) => ipcRenderer\.invoke\("qr:capture-screen"\)/);
  assert.match(api, /export async function pickScreenRegion/);
  assert.match(api, /export async function captureScreenShot/);
  // 浏览器预览要么明确拒绝，不能假装成功
  assert.match(api, /屏幕框选需要桌面端（浏览器预览不支持）/, '浏览器预览未明确拒绝');
});

t('框选窗口真透明：transparent + 无边框 + 置顶 + 全透明底色', () => {
  assert.match(region, /transparent: true/, '框选窗口不透明，会挡住背后的二维码');
  assert.match(region, /frame: false/);
  assert.match(region, /alwaysOnTop: true/);
  assert.match(region, /backgroundColor: '#00000000'/, '窗口底色不是全透明');
  assert.match(region, /win\.setAlwaysOnTop\(true, 'screen-saver'\)/, '没有压到系统最上层');
  // 覆盖鼠标所在的那块屏，而不是写死主屏
  assert.match(region, /screen\.getDisplayNearestPoint\(screen\.getCursorScreenPoint\(\)\)/);
});

t('框选层页面：框内不绘制任何底色，只靠选框阴影压暗四周', () => {
  assert.match(overlay, /html, body \{[\s\S]{0,160}background: transparent/, '页面底色不是透明');
  assert.match(overlay, /#box \{[\s\S]{0,220}background: transparent/, '选框内部有底色，会糊住二维码');
  assert.match(overlay, /box-shadow: 0 0 0 9999px rgba\(4, 8, 16, \.55\)/, '四周没有压暗，框选边界看不清');
  // 未开始拖拽时才有整屏淡遮罩，一开始拖就撤掉
  assert.match(overlay, /veil\.style\.display = 'none'/, '开始框选后淡遮罩未撤掉');
  // 取消路径齐备
  assert.match(overlay, /e\.key === 'Escape'\) finish\(\{ canceled: true \}\)/, 'Esc 取消缺失');
  assert.match(overlay, /if \(w < 6 \|\| h < 6\) \{ reset\(\)/, '手抖点一下被当成框选');
});

t('先隐藏透明层再抓屏：压暗遮罩不能进截图', () => {
  const step = region.slice(region.indexOf('if (!picked || picked.canceled)'));
  const hideAt = step.indexOf('win.hide()');
  const grabAt = step.indexOf('grabDisplay(display)');
  assert.ok(hideAt >= 0, '框选完成后未隐藏透明层');
  assert.ok(grabAt > hideAt, '抓屏发生在隐藏透明层之前，会把遮罩截进图里');
  assert.match(step, /setTimeout\(r, 130\)/, '隐藏后没有等待合成器撤层');
});

t('抓屏走 desktopCapturer 并按物理像素裁切，坐标钳制在图内', () => {
  assert.match(region, /desktopCapturer\.getSources\(\{/, '没有走 desktopCapturer');
  assert.match(region, /types: \['screen'\]/, '抓的不是屏幕');
  assert.match(region, /Math\.round\(b\.width \* sf\)/, '缩略图未按物理像素请求，小二维码会糊');
  // display_id 可能为空，必须有顺序兜底
  assert.match(region, /String\(s\.display_id\) === String\(display\.id\)/, '未按显示器 id 匹配捕获源');
  assert.match(region, /sources\[idx >= 0 \? idx : 0\] \?\? sources\[0\]/, '缺少捕获源兜底');
  assert.match(region, /Math\.min\(size\.width - 1, Math\.round\(rect\.x \* sx\)\)/, '裁切坐标未钳制');
  assert.match(region, /\.crop\(cropped\.rect\)/, '没有按框选区域裁切');
  assert.match(region, /toDataURL\(\)/, '未返回图片数据');
});

t('隐私红线：截图只在内存里流转，不落盘、不上传、不执行二维码内容', () => {
  assert.ok(!/writeFile|appendFile|createWriteStream/.test(region), '取图模块不应写文件');
  assert.ok(!/https?:\/\//.test(region), '取图模块不应发起网络请求');
  assert.ok(!/child_process|exec\(|spawn\(/.test(region), '取图模块不应执行外部命令');
});

t('面板改走主进程取图，并显示截到的画面（不再是窗口内空白框选）', () => {
  assert.match(panel, /import \{ pickScreenRegion, captureScreenShot, fetchSubscription, parseConfig \} from '\.\.\/api\.js'/, '面板未接主进程取图');
  assert.match(panel, /scanScreen\('region'\)/, '「框选屏幕区域」未走新链路');
  assert.match(panel, /scanScreen\('screen'\)/, '「屏幕截图扫码」未走新链路');
  assert.match(panel, /class="shot" :src="shotUrl"/, '没有显示取到的截图');
  assert.match(panel, /decodeQRImage\(Object\.assign\(blob, \{ name: `屏幕取图-\$\{size\}\.png` \}\), kind\)/, '取图结果未复用图片解码链路');
  // 旧实现彻底退场
  assert.ok(!panel.includes('.getDisplayMedia('), '面板仍在调 getDisplayMedia');
  assert.ok(!panel.includes('region-box'), '旧的窗口内框选矩形未清理');
  assert.ok(!qrHub.includes('getDisplayMedia'), 'qr.ts 里废弃的屏幕捕获实现未删除');
});

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) {
  for (const [name, e] of failures) console.error(`  ${name}: ${e?.message ?? e}`);
  process.exit(1);
}
