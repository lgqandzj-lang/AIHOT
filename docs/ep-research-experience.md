# 电生理研究：读者体验与验收

验收日期：2026-10-01。本地分支 `codex/ep-research-experience`，基于 PR2B `e7183b99d8eea12495b25111d78811d00152de39`。本次交付为本地前端体验，未推送或部署。

## 打开与使用

当前预览：<http://127.0.0.1:3200/research>。

2026-10-01 补充：现有阅读页已接入两张本机私有基础草稿。页面入口为 `/research/read/private-a` 与 `/research/read/private-c`；文献库保留此前的真实书目与合成阅读示例。新增页面只展示前序原文对照已支持的研究对象、本组人数及其人群口径，依据与核查方式按需展开。页面标明“私有自动整理草稿”和“尚无人类审核批准”；暂缓的临床结果不进入阅读数据。测试材料不进入文献库。

私有来源、实际字段、模型响应和本次截图仅保存于忽略目录，不写入代码或公开发布记录。默认 `EP_RESEARCH_PRIVATE_DRAFTS_ENABLED=false`；关闭时不序列化私有基础字段。开启时 Web 启动必须使用回环监听、回环 HTTP 适配器且关闭代理信任；HTML、single-fetch 和 API 处理前拒绝非回环连接、外部 Host/Origin 及转发请求。私有适配器拒绝转发的材料请求，现有公开站点元数据请求允许由本机 Web 代理读取。公共 publication 视图、公开状态和正式对外 API 未改。

本轮实际验证：全工作区类型检查与 Web 构建通过，27/27 项 Web 测试通过；真实浏览器核查两张基础卡、初始折叠和展开依据、测试路径 404、390 像素宽度无横向溢出，浏览器无 error/warn。使用已安装 Edge 和 Codex 的 Playwright 临时隔离会话；未安装浏览器或新增依赖。日志和截图在 `.data/frontend/private-cards-20261001/`。未重跑后端全量测试，后端业务代码未改；未验证 Safari、Firefox 或实体手机。本轮模型对照在独立工作区执行，预览进程的所有调用安全阀保持关闭，未启动 worker。

当前私有预览重启入口为 `.data/frontend/private-cards-20261001/reload-private.ps1`。原来的书目预览脚本、数据、报告与截图保留；当前进程状态仍在 `.data/frontend/state.json`。

- **探索**：直接显示可搜索、筛选和排序的研究文献；同屏提供证据阅读示例入口。
- **文献库**：搜索标题、作者、DOI、PMID；筛选主题；切换列表和网格；排序。
- **我的收藏**：保存在当前浏览器，刷新后仍保留；不需要注册账户。
- **文献阅读**：书目信息、引用复制、出版社与 PubMed 链接。
- **证据阅读示例**：按组别阅读；点击要点定位并高亮所提供的原文片段。桌面为左右对照，手机为原文弹层。未报告的信息保留为未知。

`EP / 电生理研究` 是本地体验的功能标识，正式站名仍待用户决定。

## 品质方向与五轮修正

按视觉、内容、导航、交互、可用性和性能检查实际页面，不给自己编造获奖分数。参考 [Webby 网站评审维度](https://www.webbyawards.com/judging-criteria/) 与 [Awwwards 移动体验指南](https://www.awwwards.com/mobile-excellence-guidelines.pdf)；Awwwards、Webby、FWA 是设计目标，不代表已获得外部评审认可。

| 轮次 | 实际发现 | 已完成的修正 |
| --- | --- | --- |
| 1 | 工程报告式展示缺少读者路径 | 重建探索、文献库、收藏和阅读页面；从主界面移出内部哈希、预算、回执与开发状态 |
| 2 | 装饰图溢出；手机点击要点后原文在屏外；阅读标题占位过大 | 收束图形边界；制作非对称心房概念点阵；手机使用原生 modal dialog；压缩阅读页标题区并高亮引用片段 |
| 3 | 中文字体加载过重；长刊名影响扫读；未经筛选的 API 对象可能进入 SSR | 将 UI 中文字体裁为 80 KB；刊名省略并提供完整 title；对白名单字段逐层投影；校验来源、引文、链接和 404 |
| 4 | 网格中多行标题的空白区域不可点击；手机说明文字出现不齐整的换行 | 标题链接覆盖整个标题区域；手机说明采用统一图标与两行文字；在真实浏览器完成交互和响应式验收 |
| 5 | 用户反馈设计过多、信息密度低 | 删除首页 Canvas、宣传标题和装饰区；首页直接进入文献列表；压缩导航、标题、字段和间距；文献列表增加 PMID，阅读页保留原文对照 |

最终紧凑版使用冷白、深蓝和钴蓝，Manrope 与中文可变字体搭配。首页已删除 Canvas 组件和绘制逻辑。默认 1280 × 720 画幅可完整看到 3 篇文献，证据阅读页可完整看到 6 个字段；390 × 844 的手机画幅也实际确认了这两项结果。记录见 `browser-density-qa.json`。

## 内容与读取边界

初次本地文献库展示 3 篇从前序隔离测试环境读取的真实 PubMed 书目（PMID `41129023`、`40412874`、`40115621`），只使用标题、作者、期刊、年份、DOI、PMID 和来源记录。本轮另接入上文所述的本机私有基础草稿；没有向正式公开站点提供摘要、未经人类审核的研究结论或私有草稿。

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
| 全工作区类型检查 | 紧凑版 exit 0 | `typecheck-dense.log` |
| Web 生产构建 | 紧凑版 exit 0 | `build-dense.log` |
| Web 测试 | 紧凑版 22/22 通过，exit 0 | `web-tests-dense.log` |
| 关闭新体验开关的原网站 smoke | 31 通过，3 个榜单未发布而跳过，0 失败 | `legacy-smoke-final.log` |
| 新体验 HTTP 检查 | 7/7；首页 302 正确跳转，其余页面与 404、缓存和索引头符合预期 | `research-http-final.log` |
| 实际浏览器 | 搜索及刷新保留查询、空结果恢复、网格与排序、标题导航、收藏及刷新保留、取消收藏、引用复制、组别和未知值、引用高亮、手机弹层、Escape 返回原字段均已确认 | `browser-qa.json` |
| 响应式 | 320、390、768、1440 像素下检查首页、文献库或阅读布局；所记录的 `scrollWidth` 与 `clientWidth` 相等 | `browser-qa.json` 与截图 |
| 减少动效 | 控件隐藏，CSS transition 为 0，滚动为 auto；验收后恢复浏览器设置及正常画幅 | `browser-qa.json` |
| 浏览器控制台 | 最终检查无 error/warn | `browser-qa.json` |
| 紧凑版浏览器复验 | 首页查询刷新保留；3 篇文献、6 个字段完整可见；原文高亮、未知值和 Escape 返回正确；320、390、768 宽度无水平溢出；控制台无 error/warn | `browser-density-qa.json` 与 `*-dense*.jpg` |

新增的 6 项 SSR 测试针对：默认关闭的隔离、私有字段剔除、缺失来源、引文不在原片段、危险链接与未知路径。另修复已有 Windows ESM 文件路径导入问题，原有 16 项 Web 测试现在通过。

初次在新预览上直接运行旧 smoke，出现 2 个预期不兼容项：首页为 302，而旧脚本要求 200；只读适配器拒绝 MCP POST。保留 `site-smoke-final.log`，未把该次结果写成通过。随后分别在关闭开关的临时服务器验证旧站，在新预览验证实际研究路径。更早的启动就绪前检查失败记录保留为 `site-smoke-startup.log`。

没有重跑后端完整 `npm test`：本次未改后端；PR2B 的既有后端回归及 Windows shutdown 超时边界见 `ep-pr2b-extract.md`。不宣称全仓测试通过。此次浏览器验收使用 Codex 内置 Chromium；没有 Safari、Firefox 或实体手机验收。原生弹层的初始焦点和 Escape 返回已确认，一次 Tab 观察不足以证明完整焦点循环，原始观察及说明保留。

## 性能与字体

紧凑版最终构建中研究路由 CSS 28.30 KB（gzip 9.07 KB），JS 45.27 KB（gzip 11.54 KB）；这是路由资源，不是全站总下载量。中文 UI 字体 69,748 字节、263 个码点，替代首次试验中浏览器下载的约 655 KB 中文分片。Manrope 拉丁字体约 24.83 KB。动态中文书目信息通过系统字体回退。

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

重启脚本只停止身份核对匹配的本次预览进程；旧预览和独立 PostgreSQL 保留。临时旧站回归服务器在检查后停止。紧凑版截图为 `home-dense.jpg`、`home-dense-mobile.jpg`、`reader-dense.jpg` 和 `evidence-dense-mobile.jpg`；此前四轮截图作为修改记录保留。

## 2026-10-01：私有提取草稿的通用读取

现有 PaperReader/PrivatePaperContent 继续共用。A/C 的旧双卡 JSON 适配器已在本机替换为 PR2B 的只读数据库适配器：`E:\EPVOICE\AIHOT-PR2B\scripts\ep-pr2b-private-api.ts`。每次通过 HTTP 读取持久化模型草稿和独立助手比较；前端没有逐篇人数、组别或结论常量，也没有数据库或模型密钥。

未核查、格式失败、传输不明或仅索引记录保留书目。样本数量须与自身单位和人群范围一起获得有引用绑定的助手比较；缺失字段不继承其他组的值。临床结果暂缓展示，内部原始输出及问题记录保持完整，不因此提高验收成绩。助手比较不写成人类批准。

本批新增三篇实际摘要记录，B 删减测试不进目录。通用 `.data` 路由和从文献库点击进入阅读页均已验证；私有模式拒绝非本机 Host/Origin、`Forwarded` 及任意 `X-Forwarded-*`，HTML、single-fetch 和本地 API 使用相同边界。默认关闭和原 publication 出口保持原状态。

当前私有预览重启用 `E:\EPVOICE\AIHOT-PR2B\.data\ep-pr2b\new-literature-20261001-065824-398976134\reload-db-private.ps1`。旧静态预览脚本及证据保留；状态文件中的 `apiEntry` 指向当前适配器。模型、采集、推送安全阀关闭，没有 worker。

本轮前端类型检查、构建及 30 项检查通过；三个实际记录桌面 1440/手机 390 截图、点击跳转、依据展开、A/C 保留地址、B 404 均通过。关闭体验开关的旧站 smoke 31 通过、3 项未发布榜单跳过。完整材料、费用及后端 Windows 退出测试边界见 PR2B `docs/ep-pr2b-new-literature.md`；没有全仓、实体手机或实际扣费对账的通过声明。

## 2026-10-02：内容首页与 N3 中文研究解读

当前首页主张为“看懂电生理新进展，找到产品研究依据。”，主要入口为“看最新进展”“查产品研究”，明确 VARIPULSE 试点。首页展示保存的真实中文解读；近期为空时不补造内容，历史补录单列。主导航为首页、最新进展、产品研究、收藏，文献库作为查询辅助入口。

N3（PMID 40566035）新增基于已保存摘要与获许可 PMC 正文的中文解读，正文含六节、流程比较和 AB/FT 证据入口。前端通过固定本机 HTTP 3202 读取保存结果，无数据库、模型或密钥。英文原题/书目折叠，原始摘要、PMC 正文与内部核对版保留。

同 record 的中文稿在核对 PMID、DOI、原题后映射到最高既有 readerVersion，首页、产品解读区及产品列表统一使用 `/research/read/draft-f3bcc383-e025-481d-8372-7d6baa73e5de`。产品返回与阅读位置通过 location.state 保留；兼容旧 returnTo 查询并拒绝外部地址。

原始模型稿独立保留，3 项 AI 原文对照修订可展开看 before/after 与来源，没有人类批准声明。未新增临床提取 schema、产品或筛选器。7 天资讯试运行清单、17 个冻结文件、原账本及 3201 API 保持原状态。

1280×900 和 390×844 浏览器路径、引用弹窗、摘要、修订记录与核对版已验证；证据与本轮实际费用见 `E:/EPVOICE/AIHOT-PR2B/docs/ep-chinese-reading.md`。当前重载入口为该文档的 `reload-content-preview.ps1`，旧预览脚本只作历史留存。
