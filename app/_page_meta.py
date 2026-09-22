#!/usr/bin/env python3
"""Elangit · 抓取目标网页的标题 / 描述 / 首图（只用标准库，无第三方依赖）。

## 为什么必须放在服务端

浏览器的跨域限制。实测（2026-09-21）`www.gooood.cn` 与 `oss.gooood.cn`
**都不发** `Access-Control-Allow-Origin`：

    curl -sI -H "Origin: https://elangit.app.workbuddy.host" \
         https://oss.gooood.cn/uploads/2025/09/xxx-472x303.jpg
    → 只有 content-type / content-length / cache-control，没有 ACAO

所以前端既拿不到对方 HTML，也拿不到图片**字节**。而「取回图片字节 → canvas 缩放
成 400px 缩略图」这一步必须同源，否则 canvas 被污染、`toDataURL()` 直接抛异常。
于是唯一可行的路径是：**我们的服务端去取，前端同源来拿**。

（另外两条也是实测的：gooood 的图片**没有防盗链**——不带 Referer、带外站 Referer
都返回 200；`robots.txt` 是空的 `Disallow:`，即全站允许抓取。这两条决定了
「直接抓」在规则上站得住，不需要绕什么。）

## 两个端点（在 _serve.py 里挂上）

    GET /api/meta?u=<网页地址>   -> {ok, site, title, h1, desc, image, text}
                                   （text 是正文，2026-09-22 加；抽不到就是空串）
    GET /api/img?u=<图片地址>    -> 图片字节原样透传（同源，前端可进 canvas）

## 安全：这个模块等于给公网一个「替我取这个 URL」的入口

所以下面这些不是可选项：

  · 只允许 http / https
  · 解析 DNS 后**逐个地址**校验，只放行公网地址（`ipaddress.is_global`）；
    回环 / 私网 / 链路本地（含云厂商的 169.254.169.254 元数据口）/ 保留段一律拒绝
  · 手工跟随重定向，**每一跳都重新校验**（上限 3 跳）——只校验第一跳等于没校验
  · 连接与读取都有超时，且整条链路上限一个总预算（不是「每跳各 10 秒」）
  · 响应体按字节截断，超上限即报错（防「一个 500MB 的响应」）
  · 校验 Content-Type：HTML 端点只吃 text/html，图片端点只吃 image/*

**已知残留风险（不假装已经解决）**：

  1. DNS 解析与实际连接之间存在 TOCTOU 窗口，理论上可被 DNS rebinding 利用。
     要彻底堵住得把连接钉在已校验的那个 IP 上（自己建连接 + 手工 SNI），本模块没做。
  2. 它仍然是一个「公网图片代理」：拿它转发公开图片不构成越权，但会消耗我们的带宽。
     大小上限与 Content-Type 校验把影响限住了，没做限流。

## 用法（也能当命令行工具，不起服务就能测）

    python3 _page_meta.py https://www.gooood.cn/xxx.htm
"""
import ipaddress
import json
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html import unescape

# 有些站（含 gooood）对空 UA 会返回不同的东西，固定一个正常的浏览器 UA。
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 Elangit/1.0")

MAX_HTML_BYTES = 1_500_000      # HTML 上限 1.5MB（gooood 单页实测 ~460KB）
MAX_IMG_BYTES = 8_000_000       # 图片上限 8MB
HOP_TIMEOUT_S = 8.0             # 单跳超时
TOTAL_BUDGET_S = 12.0           # 整条链路（含所有重定向）的总预算
MAX_HOPS = 3
ALLOW_SCHEMES = ("http", "https")


class FetchError(Exception):
    """失败原因会原样回给前端，所以措辞要能让人看懂。"""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None             # 返回 None = 不自动跟随，交给我们自己走，才能逐跳校验


def check_url(url):
    """校验一个 URL 是否允许去取。不合格就抛 FetchError。"""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ALLOW_SCHEMES:
        raise FetchError("只允许 http/https 链接")
    host = parts.hostname
    if not host:
        raise FetchError("链接里没有主机名")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise FetchError("域名解析失败：%s" % host) from exc

    addrs = []
    for info in infos:
        addr = info[4][0]
        if addr in addrs:
            continue
        addrs.append(addr)
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError as exc:
            raise FetchError("解析出无法识别地址：%s" % addr) from exc
        if not ip.is_global:
            # 这一条是整套防护里最重要的一条：挡住 127.0.0.1 / 192.168.x /
            # 10.x / 169.254.169.254（云元数据）之类「从内网看才存在」的目标。
            raise FetchError("目标地址不是公网地址：%s" % addr)
    if not addrs:
        raise FetchError("域名没有解析出任何地址")


def _open(url, timeout):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "*/*",
        # 刻意不发 Accept-Encoding：urllib 不会自动解压，
        # 一旦对方按 gzip 回，我们拿到的就是乱码而不是 HTML。
    })
    return urllib.request.build_opener(_NoRedirect()).open(req, timeout=timeout)


def fetch_bytes(url, max_bytes, want_type):
    """取回字节。返回 (最终URL, content_type, body)。

    want_type 是「这个 content-type 收不收」的判定函数；每一跳都重新校验地址。
    """
    deadline = time.monotonic() + TOTAL_BUDGET_S
    for _ in range(MAX_HOPS + 1):
        left = deadline - time.monotonic()
        if left <= 0:
            raise FetchError("整体超时（超过 %.0f 秒）" % TOTAL_BUDGET_S)
        check_url(url)
        try:
            resp = _open(url, min(HOP_TIMEOUT_S, left))
        except urllib.error.HTTPError as exc:
            if exc.code in (301, 302, 303, 307, 308):
                loc = exc.headers.get("Location")
                if not loc:
                    raise FetchError("重定向没有给目标地址") from exc
                url = urllib.parse.urljoin(url, loc)
                continue
            raise FetchError("目标站返回 %d" % exc.code) from exc
        except urllib.error.URLError as exc:
            raise FetchError("连接失败：%s" % exc.reason) from exc
        except (socket.timeout, TimeoutError) as exc:
            raise FetchError("连接超时") from exc

        with resp:
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if not want_type(ctype):
                raise FetchError("内容类型不接受：%s" % (ctype or "(空)"))
            body = resp.read(max_bytes + 1)
            if len(body) > max_bytes:
                raise FetchError("响应体超过 %dKB 上限" % (max_bytes // 1024))
            return resp.geturl(), ctype, body
    raise FetchError("重定向超过 %d 跳" % MAX_HOPS)


# ---------- HTML 解析 ----------

def _meta_content(text, names):
    """按名字顺序找 <meta property/name=... content=...>，取第一个非空值。

    只在**匹配到的那一个标签内部**找 content，所以属性顺序反着写
    （content 在前、property 在后）也能取到。
    """
    for name in names:
        tag = re.search(
            r'<meta[^>]+(?:property|name)\s*=\s*["\']' + re.escape(name) + r'["\'][^>]*>',
            text, re.I)
        if not tag:
            continue
        val = re.search(r'content\s*=\s*["\']([^"\']*)["\']', tag.group(0), re.I)
        if val:
            v = unescape(val.group(1)).strip()
            if v:
                return v
    return ""


def _clean_title(raw):
    """去掉标题末尾挂的站名。

    gooood 的 og:title 是「…，上海 / 同济原作工作室 | 谷德设计网 - gooood」，
    竖线后面是站名。这里只做「取最后一个竖线之前」这一条规则——不猜别的分隔符，
    猜错会把真标题切掉，而标题的进一步收敛本来就是 AI 的活（它被要求 ≤12 字）。
    """
    t = " ".join((raw or "").split())
    if "|" in t:
        head = t.split("|")[0].strip()
        if len(head) >= 4:          # 太短说明竖线切在了标题本身里，那就别切
            t = head
    return t[:160]


# ---------- 正文抽取（2026-09-22 新增） ----------
#
# 为什么必须抽正文：AI 生成摘要时原本只有 og:title / og:description 可用，而
# og:description 在 gooood 这类案例站上是**每篇都一样的客套模板**
# （「非常感谢 … 予gooood分享以下内容。更多关于：…」）——实测零信息量。
# 结果就是摘要只能把标题和站名拼一遍（线上 id=28 的实测结论）。
# 抽到正文，摘要才可能真的总结「这份设计说明讲了什么」。
#
# 为什么不引正文抽取库（trafilatura / readability）：这个模块是「给公网一个
# 替我取 URL 的入口」，依赖越少越好部署；而且它是纯标准库的（见文件头）。
# 代价是长尾站点抽不准——那就返回空串，调用方退回原来的行为，不会更差。
#
# 上限只影响落库；喂给 AI 时还会再截一次（ai.js 的 BODY_LIMIT），
# 因为 token 就是首字延迟：实测 1160 字提示词首字 21.1s，而超时是 60s。
MAX_BODY_CHARS = 8000

# 页面的「动作位」：收藏、分享、推广入口、相关阅读。这些不是内容，
# 抽进去只白占 AI 的 token。**注意不删**「设计公司 / 位置 / 类型 / 材料 / 标签」
# 这类元信息行——对一份设计说明的总结来说，类型与材料恰恰是有效信息。
_CHROME_LINE = re.compile(
    r"^(?:收藏|分享|点赞|评论|转发|举报|扫码|投稿|订阅|广告|关注我们|相关文章|相关阅读|"
    r"热门|推荐阅读|上一篇|下一篇|返回列表|阅读全文|查看推广方案|业主找设计师|提交项目|"
    r"在线项目|查看机会|设计师接项目|建材品牌推广|品牌展示|进入材料库|项目标签|文章项目推广)\b")

_CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def _drop_translation(lines):
    """中英双语页面只留中文那一半。

    为什么要做：gooood 每个中文段落后面都跟着同一段的英文。实测同一篇
    8,000 字里中文只有 1,506 字，其余是英文原文与双语的图注——纯粹白占
    AI 的 token，而 token 就是首字延迟（实测 1160 字提示词首字 21.1s，
    超时 60s）。所以这不是「优化」，是让正文塞得进预算。

    判据：**整篇中文够多（>200 字）才认为这是双语页**，此时丢掉「几乎不含
    中文」的行。纯英文页照旧全留——否则会把英文案例清空。全滤掉（说明判据
    在这页上失效）时也退回不滤，宁可多送。
    """
    total = sum(len(_CJK.findall(l)) for l in lines)
    if total < 200:
        return lines
    kept = [l for l in lines if len(_CJK.findall(l)) / max(1, len(l)) >= 0.25]
    return kept if sum(len(l) for l in kept) >= 200 else lines


def _strip_chrome(html_text):
    """删掉页面骨架：脚本、样式、导航、页头页脚。

    整块删 <header>/<footer>/<nav> 是安全的：案例站的标题图与正文都不在里面。
    替换成换行而不是空格，免得把前后两段正文粘成一句。
    """
    for tag in ("script", "style", "noscript", "nav", "header", "footer",
                "aside", "form", "svg", "iframe"):
        html_text = re.sub(r"<%s\b[\s\S]*?</%s\s*>" % (tag, tag), "\n",
                           html_text, flags=re.I)
    return html_text


def _blocks_to_text(fragment):
    """块级标签换成换行 → 去标签 → 反转义 → 逐行清理。

    保留段落结构是有用的：挤成一行之后就没法按行丢掉动作位了。
    """
    fragment = re.sub(r"<(?:br|/p|/div|/li|/h[1-6]|/tr|/section|/article|/main)\b[^>]*>",
                      "\n", fragment, flags=re.I)
    text = unescape(re.sub(r"<[^>]+>", " ", fragment))
    out, seen = [], set()
    for line in text.split("\n"):
        line = " ".join(line.split())
        if not line or _CHROME_LINE.match(line):
            continue
        if line in seen:        # 同一句在导航与正文各出现一次时只留一份
            continue
        seen.add(line)
        out.append(line)
    return "\n".join(_drop_translation(out))


def _balanced_blocks(html_text, tag, attr_pattern, limit=40):
    """按标签配对取出容器内容。

    不能用「<div[^>]*class=content[^>]*>[\\s\\S]*?</div>」这种非贪婪写法：
    它停在**最近的**闭标签上，正文里嵌套一层 div 就被截断，只剩开头一句。
    所以这里自己数开闭标签的深度，取真正配平的那一段。
    """
    out = []
    opening = re.compile(r"<" + tag + r"\b[^>]*" + attr_pattern + r"[^>]*>", re.I)
    paired = re.compile(r"<(/?)" + tag + r"\b[^>]*>", re.I)
    for m in opening.finditer(html_text):
        if len(out) >= limit:
            break
        start, depth = m.end(), 1
        end = len(html_text)
        for t in paired.finditer(html_text, start):
            depth += -1 if t.group(1) else 1
            if depth == 0:
                end = t.start()
                break
        out.append(html_text[start:end])
    return out


def extract_body(html_text):
    """抽出正文文本。抽不到返回 ""，调用方照旧走「只有标题」的降级。"""
    try:
        cleaned = _strip_chrome(html_text)
        best = ""
        # 容器语义从强到弱：<article> → <main> → class/id 里带 content/entry 之类的 div
        groups = [
            _balanced_blocks(cleaned, "article", ""),
            _balanced_blocks(cleaned, "main", ""),
            _balanced_blocks(cleaned, "div",
                             r'(?:id|class)\s*=\s*["\'][^"\']*'
                             r'(?:content|entry|post|article|detail|main|body)[^"\']*["\']'),
        ]
        for group in groups:
            for frag in group:
                t = _blocks_to_text(frag)
                if len(t) > len(best):
                    best = t
        # 容器都没找到（或者都短得不像正文）就退回整页：宁可带点导航噪声，
        # 也别让摘要继续靠标题猜。
        if len(best) < 200:
            best = _blocks_to_text(cleaned)
        return best[:MAX_BODY_CHARS]
    except Exception:
        return ""


def parse_meta(html_text, base_url):
    raw_title = _meta_content(html_text, ["og:title", "twitter:title"])
    if not raw_title:
        m = re.search(r"<title[^>]*>(.*?)</title>", html_text, re.S | re.I)
        raw_title = unescape(m.group(1)).strip() if m else ""

    desc = _meta_content(html_text, ["og:description", "twitter:description", "description"])
    image = _meta_content(html_text, ["og:image", "twitter:image", "twitter:image:src"])

    m = re.search(r"<h1[^>]*>(.*?)</h1>", html_text, re.S | re.I)
    h1 = unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip() if m else ""
    h1 = " ".join(h1.split())

    title = _clean_title(raw_title)
    # <h1> 通常是最干净的那个标题，优先用它——但要挡住「h1 是站点名/很短的通用词」
    # 这种列表页情况，所以加了长度与「不等于站名」两个条件。
    site = urllib.parse.urlsplit(base_url).netloc
    if 2 <= len(h1) <= 80 and h1.lower() not in site.lower():
        title = h1[:160]

    return {
        "site": site,
        "title": title,
        "rawTitle": _clean_title(raw_title),
        "h1": h1[:160],
        "desc": " ".join(desc.split())[:400],
        "image": urllib.parse.urljoin(base_url, image) if image else "",
        # 正文（2026-09-22）。抽不到就是空串——前端照旧只拿标题与描述去喂 AI。
        "text": extract_body(html_text),
    }


def fetch_meta(url):
    """返回 dict：{site, title, rawTitle, h1, desc, image, text}。失败抛 FetchError。"""
    final, _ctype, body = fetch_bytes(
        url, MAX_HTML_BYTES,
        lambda t: t.startswith("text/html") or t.startswith("application/xhtml"))
    return parse_meta(body.decode("utf-8", "replace"), final)


def fetch_image(url):
    """返回 (最终URL, content_type, bytes)。失败抛 FetchError。"""
    return fetch_bytes(url, MAX_IMG_BYTES, lambda t: t.startswith("image/"))


def _main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    url = argv[1]
    try:
        if argv[2:3] == ["--img"]:
            final, ctype, body = fetch_image(url)
            print("%s\n%s\n%d bytes" % (final, ctype, len(body)))
            return 0
        meta = fetch_meta(url)
        if argv[2:3] == ["--body"]:
            print(meta["text"] or "（没抽到正文）")
            return 0
        # 正文可能有上千字，默认只报长度 —— 不然这个工具的输出没法读。
        body = meta.get("text") or ""
        meta["text"] = "（%d 字，加 --body 看全文）" % len(body) if body else ""
        print(json.dumps(meta, ensure_ascii=False, indent=2))
    except FetchError as exc:
        print("失败：%s" % exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
