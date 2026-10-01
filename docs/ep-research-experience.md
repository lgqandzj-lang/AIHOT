# 电生理研究：读者体验与验收

验收日期：2026-10-01。本地分支 `codex/ep-research-experience`，基于 PR2B `e7183b99d8eea12495b25111d78811d00152de39`。本次交付为本地前端体验，未推送或部署。

## 打开与使用

当前预览：<http://127.0.0.1:3200/research>。

- **探索**：电位流线概念视觉、研究主题、文献入口、证据阅读示例。
- **文献库**：搜索标题、作者、DOI、PMID；筛选主题；切换列表和网格；排序。
- **我的收藏**：保存在当前浏览器，刷新后仍保留；不需要注册账户。
- **文献阅读**：书目信息、引用复制、出版社与 PubMed 链接。
- **证据阅读示例**：按组别阅读；点击要点定位并高亮所提供的原文片段。桌面为左右对照，手机为原文弹层。未报告的信息保留为未知。

`EP / 电生理研究` 是本地体验的功能标识，正式站名仍待用户决定。

## 品质方向与四轮修正

按视觉、内容、导航、交互、可用性和性能检查实际页面，不给自己编造获奖分数。参考 [Webby 网站评审维度](https://www.webbyawards.com/judging-criteria/) 与 [Awwwards 移动体验指南](https://www.awwwards.com/mobile-excellence-guidelines.pdf)；Awwwards、Webby、FWA 是设计目标，不代表已获得外部评审认可。

| 轮次 | 实际发现 | 已完成的修正 |
| --- | --- | --- |
| 1 | 工程报告式展示缺少读者路径 | 重建探索、文献库、收藏和阅读页面；从主界面移出内部哈希、预算、回执与开发状态 |
| 2 | 装饰图溢出；手机点击要点后原文在屏外；阅读标题占位过大 | 收束图形边界；制作非对称心房概念点阵；手机使用原生 modal dialog；压缩阅读页标题区并高亮引用片段 |
| 3 | 中文字体加载过重；长刊名影响扫读；未经筛选的 API 对象可能进入 SSR | 将 UI 中文字体裁为 80 KB；刊名省略并提供完整 title；对白名单字段逐层投影；校验来源、引文、链接和 404 |
| 4 | 网格中多行标题的空白区域不可点击；手机说明文字出现不齐整的换行 | 标题链接覆盖整个标题区域；手机说明采用统一图标与两行文字；在真实浏览器完成交互和响应式验收 |

视觉使用冷白、深蓝和钴蓝，Manrope 与中文可变字体搭配。首页 Canvas 是以电生理为灵感的概念作品，不是患者数据、测量结果或准确解剖图。支持暂停、系统减少动效；绘制频率上限约 30 fps，页面隐藏或图形离屏时停止绘制。

## 内容与读取边界

本地文献库展示 3 篇从前序隔离测试环境读取的真实 PubMed 书目（PMID `41129023`、`40412874`、`40115621`）。只使用标题、作者、期刊、年份、DOI、PMID 和来源记录。没有把真实摘要、未审核研究结论或私有草稿放入浏览器。

阅读示例来自本项目自有的合成材料，页面明确标注，不能据此推断真实模型效果或临床结论。A、B 组分别呈现。`without fluoroscopy` 显示为“未使用透视”，不扩大成“无射线”。前端只核对引用片段存在及所提供的引文确实包含于该片段；**原文是否支持研究要点仍需人工判断**。

- 前端只经 HTTP 读取数据，没有数据库或模型调用。
- 默认 `EP_RESEARCH_PREVIEW_ENABLED=false`：预览数据不请求、不序列化，首页沿用原网站；`/research` 显示空状态。
- 显式开启本地预览后，只接受回环地址的 `API_BASE_URL`，从 `/api/research-preview/experience` 读取受控数据。当前该端点由忽略目录中的本地只读适配器提供。
- API 返回对象按 `contracts.ts` 逐层投影；额外私有和调试字段不进入 SSR。数据无效时显示可理解的失败状态。
- 页面为 `private, no-store`、`noindex`。不存在的文献或研究路径返回 404。
- 本次没有新增正式公开发布端点。生产文献读取尚未接入 `packages/backend/src/publication/`，不能将本地预览当作已上线的公开研究站。
- `COLLECT_ENABLED`、`MODEL_CALLS_ENABLED`、`FEISHU_*_ENABLED`、`INDEXNOW_SUBMIT_ENABLED` 均保持关闭，没有启动 worker。

## 实际验证

本地证据均在 `.data/frontend/`，不进入 Git。

| 检查 | 结果 | 证据文件 |
| --- | --- | --- |
| 全工作区类型检查 | exit 0 | `typecheck-final.log` |
| Web 生产构建 | exit 0 | `build-final.log` |
| Web 测试 | 22/22 通过，exit 0 | `web-tests-final.log` |
| 关闭新体验开关的原网站 smoke | 31 通过，3 个榜单未发布而跳过，0 失败 | `legacy-smoke-final.log` |
| 新体验 HTTP 检查 | 7/7；首页 302 正确跳转，其余页面与 404、缓存和索引头符合预期 | `research-http-final.log` |
| 实际浏览器 | 搜索及刷新保留查询、空结果恢复、网格与排序、标题导航、收藏及刷新保留、取消收藏、引用复制、组别和未知值、引用高亮、手机弹层、Escape 返回原字段均已确认 | `browser-qa.json` |
| 响应式 | 320、390、768、1440 像素下检查首页、文献库或阅读布局；所记录的 `scrollWidth` 与 `clientWidth` 相等 | `browser-qa.json` 与截图 |
| 减少动效 | 控件隐藏，CSS transition 为 0，滚动为 auto；验收后恢复浏览器设置及正常画幅 | `browser-qa.json` |
| 浏览器控制台 | 最终检查无 error/warn | `browser-qa.json` |

新增的 6 项 SSR 测试针对：默认关闭的隔离、私有字段剔除、缺失来源、引文不在原片段、危险链接与未知路径。另修复已有 Windows ESM 文件路径导入问题，原有 16 项 Web 测试现在通过。

初次在新预览上直接运行旧 smoke，出现 2 个预期不兼容项：首页为 302，而旧脚本要求 200；只读适配器拒绝 MCP POST。保留 `site-smoke-final.log`，未把该次结果写成通过。随后分别在关闭开关的临时服务器验证旧站，在新预览验证实际研究路径。更早的启动就绪前检查失败记录保留为 `site-smoke-startup.log`。

没有重跑后端完整 `npm test`：本次未改后端；PR2B 的既有后端回归及 Windows shutdown 超时边界见 `ep-pr2b-extract.md`。不宣称全仓测试通过。此次浏览器验收使用 Codex 内置 Chromium；没有 Safari、Firefox 或实体手机验收。原生弹层的初始焦点和 Escape 返回已确认，一次 Tab 观察不足以证明完整焦点循环，原始观察及说明保留。

## 性能与字体

最终构建中研究路由 CSS 37.41 KB（gzip 11.02 KB），JS 58.53 KB（gzip 15.17 KB）；这是路由资源，不是全站总下载量。中文 UI 字体 80,116 字节、297 个码点，替代首次试验中浏览器下载的约 655 KB 中文分片。Manrope 拉丁字体约 24.83 KB。动态中文书目信息通过系统字体回退。

中文字体从官方 Noto Sans SC 派生，修改后命名为 `EP Reader Sans UI`；两种字体的 OFL 均随应用分发。脚本、语料和哈希见 `scripts/build-ep-ui-font.py` 与 `app/features/research/fonts/`。完整 TTF 和临时构建工具不进入 Git。

没有用本地暖缓存载入时间冒充移动网络性能或 Core Web Vitals 分数；本次未作实体低端设备、弱网或长期用户性能测量。

## 本地交付与重启

代码位于 `E:\EPVOICE\AIHOT-FRONTEND`。本机预览已启动，原 PR1、PR2A、PR2B 工作区保留。运行状态在 `.data/frontend/state.json`，本次预览只监听 `127.0.0.1:3200` 与 `127.0.0.1:3201`。

本机已有适配器与数据时，修改后可执行：

```powershell
Set-Location -LiteralPath 'E:\EPVOICE\AIHOT-FRONTEND'
npm run build -w @aihot/web
& '.data/frontend/reload-built.ps1'
```

重启脚本只停止身份核对匹配的本次预览进程；旧预览和独立 PostgreSQL 保留。临时旧站回归服务器在检查后停止。截图包括 `home-final.jpg`、`home-mobile.jpg`、`library-mobile.jpg`、`reader-mobile.jpg`、`reader-desktop.jpg` 和 `paper-desktop.jpg`。
