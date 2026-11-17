"""浏览器渲染冒烟测试：逐个 tab 打开构建产物，检查 Vue 运行时错误与关键内容。"""
import os
import subprocess
import tempfile
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 项目根，随仓库位置自动推导
CHROME = os.environ.get("CHROME_PATH") or r"C:\Program Files\Google\Chrome\Application\chrome.exe"
# 构建产物 index.html 已使用相对资源路径，可直接用 file:// 打开，无需本地服务
BASE = "file:///" + (ROOT.replace(os.sep, "/") + "/dist/index.html").replace(" ", "%20")
OUT = os.path.join(ROOT, "tests", "ui-smoke")
TABS = {
    # 首页同时校验状态条与仪表盘四块真实内容
    "home": ["内核运行：", "节点信息", "快捷操作", "节点列表", "开始连接", "等待真实采样"],
    "nodes": "节点管家",
    "subscribe": "订阅管理",
    "qrcode": "全协议二维码智能识别中心",
    "config": "配置导入中心",
    "rules": "规则管理 · 智能分流",
    "monitor": "网络连接监控 · 真实连接",
    "stats": "流量统计 · 内核真实数据",
    "logs": "运行日志",
    "settings": "内核运行层",
}
SHOT = {"home", "config", "qrcode", "settings", "logs", "nodes", "rules", "monitor", "stats", "subscribe"}
# 功能入口已收进汉堡 ≡ 弹层（默认收起，不再常驻顶栏），此处只校验菜单按钮存在


def chrome(url, extra):
    udd = tempfile.mkdtemp(prefix="wbui_")
    cmd = [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
           "--allow-file-access-from-files", "--no-proxy-server",
           "--hide-scrollbars", "--window-size=1440,1000",
           "--virtual-time-budget=3000", "--user-data-dir=" + udd] + extra + [url]
    try:
        return subprocess.run(cmd, capture_output=True, timeout=90)
    finally:
        shutil.rmtree(udd, ignore_errors=True)


def main():
    if not os.path.exists(os.path.join(ROOT, "dist", "index.html")):
        print("ERROR: dist/index.html 不存在，请先运行 npm run build")
        return 1
    os.makedirs(OUT, exist_ok=True)
    ok = 0
    for tab, keyword in TABS.items():
        r = chrome(BASE + "#" + tab, ["--dump-dom"])
        dom = r.stdout.decode("utf-8", "ignore")
        has_error = 'id="runtime-error-banner"' in dom
        keywords = [keyword] if isinstance(keyword, str) else keyword
        has_keyword = all(k in dom for k in keywords)
        status = "OK" if (not has_error and has_keyword) else "FAIL"
        if tab == "home":
            has_menu = 'menu-btn' in dom
            print(f"       汉堡菜单按钮={'有' if has_menu else '无'}")
            if not has_menu:
                status = "FAIL"
        if status == "OK":
            ok += 1
        print(f"  {status:4} #{tab:10} 关键内容={'有' if has_keyword else '无'}  运行时错误={'有' if has_error else '无'}")
        if has_error:
            pos = dom.find('id="runtime-error-banner"')
            print("       ", dom[pos:pos + 300].replace("\n", " "))
        if tab in SHOT:
            png = os.path.join(OUT, tab + ".png")
            chrome(BASE + "#" + tab, ["--screenshot=" + png])
            print(f"        截图: {png} ({os.path.getsize(png)//1024 if os.path.exists(png) else 0} KB)")
    print(f"\n结果: {ok}/{len(TABS)} 个界面渲染正常")
    return 0 if ok == len(TABS) else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
