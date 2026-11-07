"""
一键把本项目文件同步到 https://github.com/Zayn0329/A-share-sector-analysis

用途：当网络无法直连 github.com（git push 被拦）但可访问 api.github.com 时，
通过 GitHub Contents API 上传文件；不会覆盖仓库里已有的 README.md。

用法（Windows）：
    set GITHUB_TOKEN=你的token
    python upload_to_github.py

令牌要求：classic PAT 勾选 repo，或 fine-grained PAT 对该仓库授予 Contents 读写。
令牌只从环境变量读取，不会写入本文件、不会打印。
"""

import os
import sys
import json
import base64
import urllib.request
import urllib.error

OWNER = "Zayn0329"
REPO = "A-share-sector-analysis"
BRANCH = "main"
API = f"https://api.github.com/repos/{OWNER}/{REPO}/contents/"

FILES = [
    ".gitignore",
    "package.json",
    "server.js",
    "start.bat",
    "upload_to_github.py",
    "public/index.html",
    "public/styles.css",
    "public/app.js",
]

TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
if not TOKEN:
    print("缺少令牌：请先设置环境变量 GITHUB_TOKEN（需要 Contents 读写权限）。")
    sys.exit(1)


def request(method, path, body=None):
    url = API + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": "Bearer " + TOKEN,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "market-dashboard-uploader",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as res:
            raw = res.read().decode("utf-8") or "{}"
            return res.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return 404, {}
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"HTTP {e.code}: {detail}") from None


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    for rel in FILES:
        full = os.path.join(root, *rel.split("/"))
        if not os.path.isfile(full):
            print("跳过（文件不存在）:", rel)
            continue
        with open(full, "rb") as f:
            content = f.read()

        status, current = request("GET", rel)
        body = {
            "message": ("Update " if status == 200 else "Add ") + rel,
            "content": base64.b64encode(content).decode("ascii"),
            "branch": BRANCH,
        }
        if status == 200 and current.get("sha"):
            body["sha"] = current["sha"]

        _, out = request("PUT", rel, body)
        action = "更新" if status == 200 else "新增"
        print(f"{action} {rel} -> {out.get('content', {}).get('html_url', 'OK')}")

    print(f"\n完成：https://github.com/{OWNER}/{REPO}/tree/{BRANCH}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("上传失败:", exc)
        sys.exit(1)
