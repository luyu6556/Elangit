#!/usr/bin/env python3
"""Elangit 本地开发服务（同时是任务 9 的发布入口雏形）。

为什么不用 `python3 -m http.server`：
1. 它会发 Last-Modified，浏览器据此做启发式缓存，于是改完 store.js / style.css
   刷新页面拿到的还是旧文件——排查起来极费时间（本项目已经踩过一次：
   调用新加的函数报 undefined，实际是缓存）。
   这里统一加 `Cache-Control: no-store`，保证每次刷新都是磁盘上的最新代码。
2. 分享链接是路径形态（/s/令牌、/i/令牌，PRD 4.6）。静态文件服务遇到这种
   路径只会 404，所以需要把这两条路径转发到 share.html。

关于第 2 点，**必须知道的代价**：路径转发是服务端行为，纯静态托管做不到。
选了路径形态的分享链接，就意味着发布时要用「带一个服务端」的方式（本文件
即是那个服务端），不能用纯静态托管。share.html 同时认 ?t=令牌 形式，
所以如果实测平台跑不了服务端，把链接生成处改成 ?t= 即可，页面代码不用动。

发布要求（平台侧）：监听环境变量 PORT、绑定 0.0.0.0。本地开发默认
127.0.0.1:8791，不占公网。

⚠ 一次一定要知道的发布约束（2026-09-20 实测）：云服务对请求来源做
**Origin 精确匹配**。同一份文件、同一个进程，用 127.0.0.1 打开能读到库，
换成本机局域网地址（http://192.168.1.104:8796）就整页卡在「加载中…」，
最终报 `TypeError: Failed to fetch`，且**浏览器控制台一条错都不报**。
→ 所以发布必须是**复用应用 ID**（`wbapp_az0Z1pxT1CjCvbUNffduqc`，
保留域名 elangit.app.workbuddy.host），换新应用会拿到不匹配的域名、
应用直接读不到数据。见 AGENTS.md 事实第 2 条。
"""
import functools
import http.server
import os
import re
import socketserver
import sys

# /s/<令牌> 或 /i/<令牌>，末尾斜杠可选
SHARE_PATH = re.compile(r"^/([si])/([A-Za-z0-9_-]{4,64})/?$")


class AppHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        # 只改服务端实际去读哪个文件，**不改浏览器地址栏**
        # （share.html 从 location.pathname 里取令牌，所以地址必须留着）。
        if SHARE_PATH.match(self.path.split("?")[0]):
            self.path = "/share.html"
        super().do_GET()

    def log_message(self, fmt, *args):
        # 默认日志太吵，只保留错误
        if not str(args[1] if len(args) > 1 else "").startswith("2"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class ThreadingServer(socketserver.ThreadingTCPServer):
    """发布环境必须多线程。

    默认的 TCPServer 一次只处理一个连接。本地开发看不出来（只有你一个人在刷页），
    但发布后前面有个反向代理：代理的健康检查、浏览器的并发资源请求会互相排队，
    表现成「偶发卡住几秒」——很难归因。daemon_threads 让进程能正常退出。
    """
    allow_reuse_address = True
    daemon_threads = True


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(root)
    handler = functools.partial(AppHandler, directory=root)

    port_env = os.environ.get("PORT")
    if port_env:                      # 发布环境：监听平台给的端口与网卡
        host, port = "0.0.0.0", int(port_env)
    else:                             # 本地开发
        host, port = "127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8791

    with ThreadingServer((host, port), handler) as httpd:
        print("serving %s at http://%s:%d/ (threaded, no-store, share-path rewrite)"
              % (root, host, port), flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
