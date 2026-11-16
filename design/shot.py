"""把 mockups.html 的 10 个界面逐张截成 1402x1122 PNG。"""
import os
import sys
import shutil
import hashlib
import tempfile
import subprocess
from PIL import Image, ImageStat

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
HTML = "file:///E:/AAAAA/Codex/VPN/design/mockups.html"
OUT = r"E:\AAAAA\Codex\VPN\design\png"
W, H = 1402, 1122
NAMES = [
    "01-home", "02-nodes", "03-subscribe", "04-qrcode", "05-import",
    "06-rules", "07-monitor", "08-traffic", "09-logs", "10-settings",
]
TITLES = [
    "首页 / 实时状态", "节点管理 / 延迟测速", "订阅管理 / 自动更新",
    "二维码识别 / 多种格式", "配置导入 / 支持多协议", "规则管理 / 智能分流",
    "网络连接监控 / 代理状态识别", "流量统计 / 详细报表", "日志查看 / 运行日志",
    "设置中心 / 高级设置",
]


def shot(i):
    png = os.path.join(OUT, NAMES[i - 1] + ".png")
    udd = tempfile.mkdtemp(prefix="wbshot_")
    cmd = [
        CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
        "--hide-scrollbars", "--force-device-scale-factor=1",
        "--window-size=%d,%d" % (W, H), "--virtual-time-budget=2500",
        "--user-data-dir=" + udd, "--screenshot=" + png, HTML + "#" + str(i),
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=90)
    finally:
        shutil.rmtree(udd, ignore_errors=True)
    if not os.path.exists(png):
        err = r.stderr.decode("utf-8", "ignore")[-500:] if "r" in dir() else ""
        print("FAIL", NAMES[i - 1], err)
        return False
    im = Image.open(png).convert("RGB")
    raw = im.size
    if raw != (W, H):
        im = im.resize((W, H), Image.LANCZOS)
        im.save(png)
    st = ImageStat.Stat(im)
    print("%-14s %-22s raw=%s  std=%s" % (
        NAMES[i - 1], TITLES[i - 1], raw,
        [round(v, 1) for v in st.stddev],
    ))
    return True


def main():
    os.makedirs(OUT, exist_ok=True)
    only = [int(x) for x in sys.argv[1:]] or list(range(1, 11))
    ok = [shot(i) for i in only]
    print("\n--- 校验 ---")
    digests = {}
    for name in NAMES:
        p = os.path.join(OUT, name + ".png")
        if os.path.exists(p):
            d = hashlib.md5(open(p, "rb").read()).hexdigest()[:8]
            digests.setdefault(d, []).append(name)
            print("%-14s %8d KB  md5=%s" % (name, os.path.getsize(p) // 1024, d))
    dup = [v for v in digests.values() if len(v) > 1]
    print("重复图片:", dup if dup else "无")
    print("结果:", sum(ok), "/", len(only), "张成功")


if __name__ == "__main__":
    main()
