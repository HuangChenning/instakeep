# InstaKeep Implementation Plan

> 历史文档：保留早期规划与当时的验证结果，不代表当前支持范围、保存方式或测试数量。当前版本见 [README](../../../README.zh-CN.md)与[验收记录](../../validation.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现本机使用的 Instagram 单主页备份扩展，覆盖帖子、轮播、Reels、当前快拍和精选，并支持增量去重及任务恢复。

**Architecture:** Instagram 页面负责登录会话内读取；扩展内容脚本校验并转发数据；后台负责持久队列、去重和 Chrome 下载。弹出窗口只负责操作与显示，关闭窗口不停止任务。先验证读取能力，再锁定接口实现；不将未知的 Instagram 接口写成已成立的假设。

**Tech Stack:** Chrome Manifest V3、原生 JavaScript ES modules/JSDoc、HTML/CSS、IndexedDB、chrome.storage.local、chrome.downloads、Node 内置测试运行器。首版无框架、无构建步骤、无线上后端；最低 Chrome 版本由 Task 1 实测后记录。

**Spec:** [REQUIREMENTS.md](../../../REQUIREMENTS.md)

## Global Constraints

- 产品名称：InstaKeep；中文名：IG 留存；项目目录及建议 GitHub 仓库名：instakeep。
- 个人使用，通过 Chrome 加载已解压扩展安装；中文界面。
- 使用当前 Instagram 网页已有登录状态，不收集密码，不要求第三方登录。
- 从当前打开的 Instagram 主页启动，一次处理一个账号。
- 可靠性优先于速度，必要时适度限速。
- 设置、任务和完成记录只保存在本机。
- 不加入统计上报、云端同步或扩展自己的服务器。
- 首版不包含应用商店发布、多账号列表、定时备份、任意磁盘目录选择、评论、点赞列表、关注者列表。
- 全部内容类型仍是交付目标；某类型无法可靠读取时报告证据，由用户决定是否调整范围。
- 每阶段更新本计划勾选项和验证记录；未实测项目不得标为通过。

## Review Focus

1. 登录账号或目标主页发生变化：暂停，不将两个账号的数据混入任务（Task 2/6）。
2. 分页重复、空响应、格式变化：保持未确认状态，不误报扫描完成（Task 2）。
3. 后台在下载启动与落盘记录之间退出：先对账，再决定恢复，不盲目重复下载（Task 5）。
4. 临时媒体 URL 过期：用媒体 ID 刷新地址，不永久缓存旧 URL（Task 5）。
5. 模板路径穿越、同名精选、页面伪造消息：校验输入并隔离冲突，不扩大访问权限（Task 3/6）。

## 文件与接口

以下为待创建文件，目前仓库只有 REQUIREMENTS.md。

| 文件 | 责任 |
|---|---|
| manifest.json、package.json | 扩展声明；npm test 调用 node --test |
| src/content.js、src/page-reader.js | 扩展隔离环境消息转发；页面环境内受限读取 |
| src/instagram.js | 分类读取、分页及响应标准化 |
| src/model.js | 共用数据约定、媒体键和完成判定 |
| src/paths.js、src/metadata.js | 路径模板与来源 JSON |
| src/store.js | IndexedDB 任务、检查点、队列、完成记录；本地设置 |
| src/queue.js、src/downloads.js、src/background.js | 状态变更；Chrome 下载适配；事件协调 |
| ui/popup.html、ui/popup.js、ui/popup.css | 中文操作与状态显示 |
| tests/*.test.js、tests/fixtures/*.json | 业务测试及脱敏响应样本 |
| docs/feasibility.md、docs/validation.md、README.md、THIRD_PARTY_NOTICES.md | 可行性证据、验收记录、安装与许可说明 |

数据约定：
- `Content = {id, accountId, username, category, permalink, publishedAt: string|null, caption, highlight: {id,title}|null, media: Media[]}`。
- `Media = {id, index, kind: 'image'|'video', url, extension, width, height, qualityNote: string|null}`；index 从 1 开始。缺少稳定 ID 的项报错，不能用临时 URL 代替身份。
- `ScanPage = {contents: Content[], nextCursor: string|null, terminal: boolean, context: {accountId, viewerId}, warnings: string[]}`；terminal 必须有已验证的源端结束依据。
- `Task = {id, context, selectedCategories, settingsSnapshot, state, scans, counts}`；扫描状态为 pending/scanning/complete/unknown/failed；任务状态为 scanning/downloading/paused/complete/incomplete。
- `QueueItem = {id, taskId, contentId, mediaKey, type: 'media'|'metadata', state, relativePath, downloadId: number|null, attempts}`；状态为 pending/starting/downloading/succeeded/skipped/failed/unknown。
- 使用唯一索引保护 mediaKey；来源 JSON 使用独立 contentId 完成键。关闭 JSON 保存时不创建对应项。重复媒体可被多条 Content 引用。

## Task 1：读取可行性与最小可加载扩展

**Files:** manifest.json、package.json、src/content.js、src/page-reader.js、docs/feasibility.md、tests/manifest.test.js。
**Interfaces:** 产出 `readContext() -> Promise<{accountId,username,viewerId}>`，以及每种类型的读取证据；读取实现由证据决定。

- [ ] 核查 SocialSnag 的 MIT 许可和相关读取代码，记录可复用部分及需要删除的多平台权限；默认采用本项目骨架，只复用经审阅且实测通过的必要代码。
- [x] 创建最小 MV3 壳与 npm test；测试断言无 all_urls、cookies、webRequest、debugger、unlimitedStorage 权限。运行 `node --test tests/manifest.test.js`，应先因缺失声明失败。
- [x] 实现点击扩展后的当前页注入：基础权限 downloads/storage/activeTab/scripting；不预先添加 CDN 访问权限。只有验证确有跨域 fetch 需求时才记录并申请必要域权限。
- [ ] 在用户已有登录的 Chrome 中，验证上下文识别、跨两页帖子、轮播、Reels、当前快拍、精选列表及精选内部分页；记录请求类别、稳定 ID、质量来源及明确结束条件，不提交 Cookie、令牌或完整私密响应。
- [ ] 验证读取不需要第三方服务器、额外登录、请求头伪装或绕过访问限制；若必要能力不成立，停止后续依赖开发并报告。
- [ ] 运行声明测试及加载检查；记录 Chrome 版本和每类型 passed/failed/unverified。交付最小壳与可行性报告。

**Gate:** 未取得某类型可靠枚举证据时，不将其标为支持；网页 DOM 滚到底不能单独证明完整性。

## Task 2：标准化媒体与扫描检查点

**Files:** src/instagram.js、src/model.js、tests/instagram.test.js、tests/fixtures/*.json。
**Interfaces:** `scanPage(context, category, cursor) -> Promise<ScanPage>`；`refreshMedia(context, contentId, mediaId) -> Promise<Media>`；`mediaKey(media) -> string`；`completion(task, items) -> 'complete'|'incomplete'`。

- [ ] 添加脱敏样本测试：轮播每项保留、跨类别同一媒体键相等、精选 ID 与标题分离、缺日期保留 null；重复 cursor 和非预期响应不能产生 terminal=true。运行 `node --test tests/instagram.test.js`，应失败。
- [ ] 实现已验证的分类读取和响应标准化；分页串行；数据结构变化、上下文变化或无法判定结束时返回明确错误，不返回伪空列表。
- [ ] 为 complete 判定写测试：所有所选扫描 complete、所有所需下载 succeeded/skipped 才为 complete；JSON 失败、未知扫描或任何 failed/unknown 项都为 incomplete。
- [ ] 运行本任务测试，应全部通过；实际读取样本与脱敏夹具对应，记录未覆盖情况。

## Task 3：命名模板与来源信息

**Files:** src/paths.js、src/metadata.js、tests/paths.test.js、tests/metadata.test.js。
**Interfaces:** `buildPath(content, media, settings) -> string`；`buildMetadata(content, mediaPaths) -> object`；`validateSettings(settings) -> {valid, errors}`。

- [x] 写测试断言默认目录、ISO 日期、轮播序号、无日期省略日期段；更名模板不改变媒体键；拒绝绝对路径、.. 和未知占位符。运行 `node --test tests/paths.test.js tests/metadata.test.js`，应失败。
- [x] 实现字段 {username}/{date}/{type}/{id}/{index}；默认文件名为日期_ID_序号，非轮播省略序号。精选目录用标题，标题冲突时加精选 ID；清理非法文件名字符，保留 ID 防止冲突。
- [x] 输出 JSON 原帖链接、账号、时间、文案、媒体 ID/类型/相对路径和质量说明，不保存会话凭据及临时签名 URL。
- [x] 运行测试应通过，人工核对文件名示例及精选重名处理。

## Task 4：持久队列与去重记录

**Files:** src/store.js、src/queue.js、scripts/browser-check.mjs、tests/settings.test.js。
**Interfaces:** `saveScanPage(taskId, category, page) -> Promise<void>`；`enqueue(taskId, contents) -> Promise<void>`；`claimNext(taskId) -> Promise<QueueItem|null>`；`markSucceeded(itemId, downloadId) -> Promise<void>`；`loadTask(taskId)`；`clearAccountHistory(accountId)`。

- [x] 在真实 Chromium 中验证跨类别媒体去重、失败不写完成记录、设置快照、增量入队及并发领取；不使用 Map 模拟数据库。
- [x] IndexedDB 使用 tasks/items/completed 三个对象存储；检查点和新增队列项同事务提交，防止只推进 cursor 丢失媒体。设置保存 chrome.storage.local。
- [x] 用事务实现领取和完成写入；强制重下仅绕过所选项完成记录，清除账号历史不删除本地文件、不修改进行中的任务。
- [x] 实际 Chromium 关闭并重开后，数据库、检查点、队列及本地设置保留；补充 JSON 等待媒体并引用实际路径、强制重下、失败记录与游标循环测试。

验证记录（2026-10-13）：上述数据库检查由 scripts/browser-check.mjs 在独立 Chromium 151.0.7922.34 完成。saveScanPage 同事务执行 enqueue，无单独写入接口；真实 Instagram 下载尚未接入。

## Task 5：下载调度与恢复

**Files:** src/downloads.js、src/background.js、tests/downloads.test.js、tests/recovery.test.js。
**Interfaces:** `startDownload(item, url) -> Promise<number>`；`reconcile(taskId) -> Promise<void>`；`pump(taskId) -> Promise<void>`；`pauseTask(taskId, reason)`；`resumeTask(taskId, context)`；`retryFailed(taskId)`。

- [ ] 写测试：收到 Chrome complete 才成功；用户取消不自动重试；登录失效和限流暂停；过期 URL 重新读取；starting 项无可确认关联时转 unknown，不能盲目重发。运行 `node --test tests/downloads.test.js tests/recovery.test.js`，应失败。
- [ ] 默认扫描请求串行、下载并发 2；临时网络错误最多额外重试 3 次，间隔 2/5/15 秒。计数及下次可重试时间持久化，不依赖后台长时间 timer；用下载事件和页面保持在线时的唤醒触发调度。
- [ ] 下载前持久化 starting，调用 Chrome API 后记录 downloadId；后台重启使用 downloads.search/onChanged 对账。启动记录缺口无法唯一匹配时要求用户重试，不误标成功。
- [ ] 暂停停止新扫描和新下载，已提交 Chrome 的文件允许完成；恢复验证 viewerId/accountId 并刷新过期媒体 URL。关闭浏览器后的任务保持暂停，等待手动继续。
- [ ] 来源 JSON 通过本地编码 data URL 下载，复用完成事件处理。文件名冲突采用 uniquify，去重仍按完成记录；强制重下不覆盖旧文件。
- [ ] 运行测试应通过；真实 Chrome 验证后台退出、浏览器重开及 JSON 下载。记录无法实现字节级断点续传的情况，恢复至少达到任务级。

## Task 6：中文界面与消息校验

**Files:** ui/popup.html、ui/popup.js、ui/popup.css、src/content.js、src/background.js、tests/messages.test.js。
**Interfaces:** 扩展消息 `START/PAUSE/RESUME/RETRY_FAILED/GET_STATUS/SAVE_SETTINGS/CLEAR_HISTORY`；后台响应 `{ok,data,error}`；页面读取消息只允许已定义 readContext/scanPage/refreshMedia 操作，不支持任意 URL 请求。

- [ ] 写测试：非 Instagram 标签页、错误发送方、过期任务请求和未知消息被拒绝；无权访问页面返回说明而非空成功。运行 `node --test tests/messages.test.js`，应失败。
- [ ] 校验 tab URL、sender、消息大小与字段、当前 context；所有页面提供的数据视为不可信。媒体只接受已实测的 HTTPS Instagram 媒体域名与图片/视频类型。
- [ ] 实现全类型默认勾选、根目录与模板、JSON 开关、开始/暂停/恢复/失败重试、强制重下和账号记录清除。清除记录时确认并解释不会删除文件。
- [ ] 显示每类型扫描状态、内容数/媒体数、成功/重复/失败、质量受限原因及完整性未确认；扫描结束前不显示虚假总量百分比。
- [ ] 运行消息测试应通过；人工检查中文界面、键盘操作、模板报错和弹窗关闭后任务继续。

## Task 7：真实验收与 GitHub 交付资料

**Files:** docs/validation.md、README.md、THIRD_PARTY_NOTICES.md、.gitignore。
**Interfaces:** 产出加载目录、复现步骤和证据矩阵，逐项标识 verified/unverified/failed。

- [ ] 运行 `npm test`，要求零失败；未运行的测试单独记录。
- [ ] 在已登录页面验证各类型、轮播全部项、音视频可播放、JSON、路径模板及文件数量；随后重复运行、新增项、同媒体跨类别与强制重下验收。
- [ ] 验证暂停、后台退出、浏览器关闭恢复、链接过期、网络失败、登录变化和限流提示；无法安全复现的限流使用自动测试并标注非真实实测。
- [ ] 写安装步骤、必要权限说明、备份边界、模板说明、下载前询问保存位置设置对批量下载的影响及故障排查。忽略会话数据、下载文件和本地验收私密样本。
- [ ] 记录所有复用代码来源和许可；GitHub 上传、仓库创建及发布不在本次计划执行范围内。未确定本项目许可证前不宣称为开源授权。
- [ ] 核对 REQUIREMENTS.md 全部条目映射到 Task 1–7；输出交付状态及未解决项。只有真实验收通过才宣称完整支持。

## 参考与决策记录

- [Chrome downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads)：下载权限、相对路径及下载状态对账。
- [后台生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)：后台状态必须持久化，不能依赖常驻内存。
- [SocialSnag](https://github.com/jamditis/socialsnag)：复用候选，不代表其功能已在当前 Instagram 验证。

提交策略：当前目录没有 Git 仓库；计划不自动初始化或推送。若开发阶段初始化本地仓库，每个通过验证的 Task 单独提交，保留失败及未验证情况。

自审结果：已覆盖需求各节；真实枚举与下载作为明确门槛；统一数据及消息接口；五项 Review Focus 均对应测试或真实验证；当前所有开发步骤未开始。

执行进度：第一阶段诊断壳已实现；本地 5 项测试通过。真实读取与加载未验证，详见 docs/progress.md 及 docs/feasibility.md。
