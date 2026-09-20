#!/usr/bin/env python3
"""一次性接收端：把浏览器里导出的数据库 JSON 落到磁盘。

为什么需要它：数据库里的 item_images.data_base64 总共约 0.9MB，直接经由
代理的上下文（先打印再转存）会灌进几十万 token。让页面自己 POST 到本机文件，
数据不经过模型上下文。

用法：python3 elangit_dump_recv.py <输出目录> [端口]
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else "/tmp"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8792

os.makedirs(OUT_DIR, exist_ok=True)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        name = os.path.basename((parse_qs(parsed.query).get("name") or ["dump.json"])[0])
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        path = os.path.join(OUT_DIR, name)
        with open(path, "wb") as fh:
            fh.write(body)
        payload = json.dumps({"ok": True, "path": path, "bytes": len(body)}).encode()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print("recv listening on 127.0.0.1:%d -> %s" % (PORT, OUT_DIR), flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
