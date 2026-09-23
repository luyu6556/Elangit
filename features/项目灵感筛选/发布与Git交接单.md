# Elangit｜发布与 Git 交接单

> 日期：2026-09-23  
> 交接对象：WorkBuddy  
> 任务状态：**部署包已组装且自检通过；公开仓库已本地提交；尚未上传云平台、尚未成功推送 GitHub。**

## 0. 这次要完成什么

把已确认的「首页 = 全库翻阅」及其后的移动端手势优化，发布到既有 Elangit 云应用；并把同一版本的脱敏公开仓库推送到既有 GitHub 远端。

本次不是继续开发功能。除非发布过程明确报出由当前版本代码造成的错误，否则不要顺手改 UI、数据库、分享、埋点或项目功能。

## 1. 当前成果与版本真相

### 1.1 已进入本次版本的产品变更

- 根入口 `app/index.html` 已是全库翻阅：首页左上「新建项目」、右上「添加素材」、底部居中「进入素材库」；素材库完整迁至 `app/library.html`。
- 首页无项目时点爱心，会要求「选择已有项目／新建项目」，不会静默收藏。
- 项目翻阅与首页共用同一套牌堆逻辑；侧卡点选为跳到中央卡、不翻面，中央卡才翻面。
- 手机端翻阅已优化：长拖使用连续指数阻尼，不再在固定距离突然顶死；翻阅页锁住整页纵向滚动，卡背详情仍可独立竖滚；首页前后翻页按钮手机端为 **46px**。
- 素材库卡片标签与筛选标签支持横向滑动，并会吞掉横滑后浏览器补发的 click，避免误进详情或误切筛选。

完整需求与实现记录见：

- `features/项目灵感筛选/PRD.md` v0.9
- `features/项目灵感筛选/项目修改记录.md` #029～#034
- `docs/构建记录.md` #051～#055

### 1.2 已完成的验证（不是推测）

- 真实移动端浏览器：首页横拖进度从 **第 1 / 17 张** 变为 **第 2 / 17 张**。
- 翻阅页 body 计算样式为 `overflow: hidden`，类名含 `deck-mobile-lock`；牌堆仍为 `touch-action: pan-y`；手机端“下一张”计算高度 **46px**。
- 素材库卡片标签真实横滑：`scrollLeft` **0 → 77.5px**，页面仍停留 `/library.html`，未跳详情。
- 相关页面 console 的 error / warning 为 **0**。
- `app/_verify_projects.html`：**192 / 192 通过 / 0 失败 / 0 跳过**。

### 1.3 已组装的发布件

已执行：

```bash
cd '/Users/luyu/Documents/Elan git'
python3 tools/build-deploy.py
```

输出目录：`/Users/luyu/Documents/Elangit-部署/`

- 文件数：**24**
- 构建脚本输出体积：**473.3 KB**（文件系统占用 `du` 为 **520 KB**，两者口径不同）
- 自查① 发布件逐字节等于真源 `app/`：通过（24 个文件）
- 自查② `_verify_` / `_demo_` 文件未混入：通过（0 个）
- 自查③ `config.js` 保留真 publishableKey：通过（这是运行版要求）

### 1.4 Git 现状

已执行脱敏导出：

```bash
cd '/Users/luyu/Documents/Elan git'
python3 tools/push-to-github.py --export-to '/Users/luyu/Documents/Elangit-公开仓库'
```

公开仓库 `/Users/luyu/Documents/Elangit-公开仓库` 已有本地提交，工作区干净：

```text
fce4acd92263f60c26043df2ec1acd469f8e99e4
优化移动端翻阅与标签手势
2026-09-23T20:29:54+08:00
```

远端为：`https://github.com/luyu6556/Elangit.git`（`origin`）。

已尝试 `git push origin main`，失败，原文如下：

```text
fatal: could not read Username for 'https://github.com': Device not configured
```

这代表**本地提交没有推上 GitHub**；不是代码或 Git 冲突。需要在有 GitHub 登录态的 WorkBuddy／GitHub Desktop 环境中继续推送。

## 2. 发布时不可变的参数与顺序

线上既有地址：`https://elangit.app.workbuddy.host/`

必须复用：

```text
appId    = wbapp_az0Z1pxT1CjCvbUNffduqc
language = python
startCmd = python3 _serve.py
```

上传目录必须是：`/Users/luyu/Documents/Elangit-部署/`，不要上传真源 `app/`，也不要上传脱敏公开仓库。

三条绝对约束：

1. 必须以 `python3 _serve.py` 启动，不能静态托管；路径式分享需要服务端把 `/s/*`、`/i/*`（未来可能的 `/p/*`）转给 `share.html`。
2. 不得把 `app/_serve.py` 的 `ThreadingTCPServer` 改回单线程服务器。
3. 不得新建云应用，必须复用上方 `appId`。云服务会做 Origin 精确匹配；新应用可出现“页面能开、数据全读不出、控制台也无错”的假成功。

## 3. WorkBuddy 的执行顺序

### A. 发布前只读核验

```bash
cd '/Users/luyu/Documents/Elan git'
python3 tools/build-deploy.py
```

若三条自查任一失败，停止上传，报告完整原文错误。不要手改 `/Users/luyu/Documents/Elangit-部署/` 来绕过。

### B. 平台上传与线上验收

1. 使用第 2 节的既有 appId、语言和启动命令上传部署目录。
2. 上传完成后打开既有线上地址；确认首页能读出真实素材，而不是无限“加载中”。
3. 真实浏览器至少验四项：
   - 首页能打开全库牌堆；
   - 「进入素材库」进入 `library.html`，标签横滑不跳详情；
   - 手机宽度下横拖至少翻到下一张，整页不随横拖上下滚；
   - 既有路径分享链接 `/s/<已有令牌>` 仍返回并显示只读内容。
4. 如线上页面能开但读不到数据，**先核对 appId 是否复用**，不要开始改数据库或前端。

### C. GitHub 推送

在已登录的公开仓库中执行：

```bash
cd '/Users/luyu/Documents/Elangit-公开仓库'
git status --short
git log -1 --oneline
git push origin main
git status --short
git ls-remote --heads origin main
```

预期本地 HEAD 为 `fce4acd`；推送后工作区仍应为空，远端 `main` 指向同一提交（或包含该提交的更新提交）。若远端先于本地有新提交，停止并报告 `git pull --rebase` 前后的完整状态；**不要**用 force push 或 reset 覆盖远端。

## 4. 当前不该做的事

- 不执行 P3-7 项目访客只读分享迁移；它仍待用户确认，不能先动 DDL。
- 不改 `items`、`item_images`、`settings` 表结构或既有 `items.share_token`／`settings.share_token` 规则。
- 不新建应用、不换域名、不新增埋点、不开始第三期。
- 不把真源 `/Users/luyu/Documents/Elan git` 当 Git 仓库执行提交；它不是 Git 工作树。Git 只在生成的公开仓库目录执行。
- 不把 `_verify_*`、`_demo_*` 文件手动放进发布件或公开仓库；两条导出脚本已有排除规则。

## 5. 失败时的汇报格式

请明确写出：执行的命令／平台参数、失败原文、当时的页面 URL 或 Git 状态、是否已产生任何线上变更。测不出来写「存疑」，不要把“页面能打开”写成“线上读库成功”。

