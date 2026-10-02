# 中文研究解读任务与私有阅读

本轮以内容价值与首页信息架构为范围，使用 N3（PMID 40566035，DOI 10.3390/jcm14124290）。当前为本机私有预览；VARIPULSE 是试点。没有增加产品、发布内容或改变 7 天资讯试运行。

## 已保存材料与实际生成

- 复用原 PubMed 摘要材料包，旧摘要提取和临床 schema 保留。
- 新增 PMC12194171 正文，核实文章明确许可 CC BY 4.0；保存完整来源 HTML、独立全文 hash、45 个 FT 片段及许可信息。摘要片段标 AB，正文片段标 FT。
- 本轮单独获得明确授权：1 次 DeepSeek Flash 非思考请求，最多 0.50 CNY，8192 输出 token，零自动重试及换模型。独立内容库 `epvoice_content_20261002` 保存结果，未使用资讯试运行额度。
- 实际请求 1 次，成功并保存；输入 10699、输出 2596 token。按已核实输入 2 / 输出 8 CNY 每百万 token 估算为 0.042166 CNY；保守请求上界 0.153220 CNY。供应商实际扣费未对账。
- 原始模型输出未覆盖。AI 原文对照后独立记录三项修订：antral 的译法、优化流程的逐条肺静脉顺序、导语补明术后缺血性卒中。页面可看变更前后及来源。无人类审核批准。

私有材料与回执证据目录：`E:/EPVOICE/AIHOT-PR2B/.data/ep-chinese-reading/n3-20261002/`。其中 `model-output.json` / `saved-draft.json` / `中文研究解读.md` 为原始生成；`source-review.json` / `阅读稿.md` 为明确标示的 AI 对照修订。`execution.json` 的 readerUrl 保留执行时版本；当前页面选择同一 record 的最新既有阅读版本。

## 阅读交付

- 首页：`http://127.0.0.1:3200/research`；主张为“看懂电生理新进展，找到产品研究依据。”，主要入口为“看最新进展”“查产品研究”。首页展示真实中文解读，近期与历史补录分开；近期无内容时如实显示为空。
- VARIPULSE：`http://127.0.0.1:3200/research/products/varipulse`；中文解读在已有筛选器之前。
- N3：`http://127.0.0.1:3200/research/read/draft-f3bcc383-e025-481d-8372-7d6baa73e5de`；首页和产品页复用这一地址。已有旧版本和收藏保留。
- 正文六节：研究问题、方法与流程差别、关键结果、安全信息、研究限制、阅读分析。事实、作者解释、平台阅读分析明确标示。
- 英文原题与书目折叠；摘要、PMC 正文及出版社入口保留；内部核对版保留旧摘要字段，属于辅助入口。
- 正文引用可打开实际提供给模型的 AB/FT 片段及原始来源链接，未使用聊天示例作为前端内容。

内容核查通过的复述要点：前 3 例先完成完整左房标测，后 7 例逐条肺静脉标测后立即消融；10 例、41 条肺静脉，优化/传统操作时长 68/144 分钟、左房停留 46/107 分钟、重复标测 1/3 次；1 例术后约 10 小时缺血性卒中。正文说明顺序非随机、小样本、学习曲线、基线不平衡与未评估隔离持久性，不把组间差异写成确定因果。

## 可重复任务

`scripts/ep-chinese-reading.ts` 提供 `prepare` / `run` / `status`。生成流程读取材料、验证许可及身份、准备请求、预算与回执约束、生成、校验引用并保存私有稿，不需用户填表或复制输出。新生成必须有本轮独立授权；未知或失败的已发送请求不自动释放授权或重试。

已保存且输入、全文与请求 hash 相同的 `prepare` / `run` 会在收费准备之前返回保存稿。复验结果为 `reused_saved_private_draft`、`actualRequests:0`、`receiptId:15`。任务现可接受其他 PMID；每篇新生成须有独立的材料与授权，不复用 N3 或资讯额度。

```powershell
Set-Location -LiteralPath 'E:\EPVOICE\AIHOT-PR2B'
$env:DATABASE_URL='postgres://ep_pr1@127.0.0.1:55433/epvoice_content_20261002'
$env:NODE_ENV='development'
$env:MODEL_CALLS_ENABLED='false'
node --env-file=.env scripts/ep-chinese-reading.ts status 40566035 --directory '.data/ep-chinese-reading/n3-20261002'
node --env-file=.env scripts/ep-chinese-reading.ts run 40566035 --directory '.data/ep-chinese-reading/n3-20261002'
```

页面仅通过 HTTP 读取保存稿，新增只读 API 为 `127.0.0.1:3202`。GET/HEAD 之外返回 405，异 Host/Origin 或 Forwarded 请求返回 403；接口和页面为 private/no-store/noindex。现有资讯 API 3201 保留。

## 验证与留存

真实浏览器以 Edge 的 1280×900 与 390×844 视口走通首页→产品→中文稿→FT23 原文弹窗，亦验证摘要、修订差异、内部核对版及返回产品。无横向溢出、浏览器 JS 错误或外部资源请求；浏览前后资讯与读稿数据一致。视口模拟未代替实体手机验收。

证据为 `browser-content-verification.json`、`reuse-verification.json`、`preservation-verification.json` 及同目录截图。试运行 17 个冻结文件（包括 `.env`）、清单和持久账本保持原值；N3 原始保存稿与数据库内容逐值一致。实际资讯账本仍为 1 个批次、3 次请求。

类型检查、Web 构建、相关合成数据测试及原有 Web 回归均执行。一次旧测试期待“返回文献库”，本轮改为“返回首页”后对应返回地址隔离测试通过。未宣称全仓后端回归或公开部署。只读 API 的 Host 检查使用 curl 实际发送 header；Node fetch 没有发送指定 Host 的探测结果不能当成服务器边界结果。

最终 Web 回归 56 项与后端中文稿边界 3 项通过。一次并发构建/测试使测试启动时构建文件暂不存在；失败日志保留为 `work/web-tests-build-race.log`，等待构建结束后独立运行通过。最终日志为 `work/final-build.log`、`work/final-web-typecheck.log`、`work/final-web-tests.log`、`work/final-chinese-reading-tests.log`。阅读路径验收与原文复核单独记录，不用测试数量替代阅读质量。

## 本地重载

在现有本机 PostgreSQL、资讯 API 3201 仍运行的前提下：

```powershell
Set-Location -LiteralPath 'E:\EPVOICE\AIHOT-FRONTEND'
npm run build -w @aihot/web
& 'E:\EPVOICE\AIHOT-PR2B\.data\ep-chinese-reading\n3-20261002\work\reload-content-preview.ps1'
```

脚本在停止进程前核对本次脚本身份，只重载 3200 前端和 3202 中文稿接口；不运行采集、模型或资讯试运行任务。

## 2026-10-02 通用任务开发

`prepare <PMID>` 优先读取已保存的 PubMed 材料；缺失时读取官方书目并导入独立内容库。摘要材料包不依赖此前的临床字段提取。任务核对摘要所属 record、PMID、DOI，再解析官方 PMC 身份并核验全文自身的书目与版权区域。当前只处理文章明确许可 CC BY 4.0 的全文；无摘要、无全文、身份冲突、其他许可或正文覆盖不全均保存阻断状态，不调用模型。

全文准备改为通用正文、表格和图注读取，不再要求某篇论文特有的 Complications/Limitations 标题或固定版权年份。新稿使用 `ep-chinese-reading-v2`：根据本篇实际研究设计组织六节正文，保留摘要与正文的不一致，不为单臂研究编造对照。N3 的 V1 输入、提示词和保存稿继续复用。

每个私有任务目录保留 `material-manifest.json`、原始 HTML、全文片段、模型输入、最终请求和预检；`job-status.json` 记录准备、材料阻断、等待授权、执行中或保存状态。执行前再次从 HTML 重抽取全文，与片段快照逐值比较，校验输入、提示词、请求文件及审批 token 上界。相同请求的重复保存也不得改写原始输出或独立修订记录。

3202 增加白名单补充书目，仅供没有旧临床草稿的新保存论文使用。前端逐条校验书目、产品证据和读稿；一条错误不影响其他有效稿件。旧版本与收藏的 readerId 均保留，中文解读附在同 record 的最新既有阅读版本；产品列表继续按 record 去重。页面访问仅读取保存稿。

第二篇真实材料为 admIRE 早期/晚期复发分析，PMID 39820338、DOI 10.1093/europace/euaf007、PMC11879039。原始全文与许可来自 [PMC 论文原页](https://pmc.ncbi.nlm.nih.gov/articles/PMC11879039/)。保存材料为 3 个 AB、61 个 FT，目录 `E:/EPVOICE/AIHOT-PR2B/.data/ep-chinese-reading/admire-recurrence-20261002/`。最终请求输入上界 44103 token，输出上限 8192；预检的保守费用上界 0.153742 CNY，最多 1 次请求、零重试。**本轮付费授权仍待用户答复；新增模型请求为 0，尚无第二篇生成稿。**

官方身份接口旧地址发生重定向，已按[当前官方接口文档](https://pmc.ncbi.nlm.nih.gov/tools/id-converter-api/)更新地址；实际新接口返回 HTTP 429，本轮停止该自动查找。随后从论文原页独立核对 PMCID，使用 `prepare` 的可选 `--pmcid PMC11879039` 指定同一来源；仍须通过正文自身 PMID、DOI、PMCID 及许可校验，不跳过身份或许可检查。正常输入只需 PMID；来源接口不可用时如实阻断，不自动重试。

```powershell
node --env-file=.env scripts/ep-chinese-reading.ts prepare 39820338 --directory '.data/ep-chinese-reading/admire-recurrence-20261002'
node --env-file=.env scripts/ep-chinese-reading.ts status 39820338 --directory '.data/ep-chinese-reading/admire-recurrence-20261002'
```

验证：四种实际 CLI 阻断（错 readerId、错摘要包、篡改全文片段、缺少授权）均在发送前终止，回执逐值未变；证据为 `free-job-verification.json`。后端相关单测 20 项、前端全套回归 66 项、类型检查、独立脚本类型检查和 Web 构建通过。真实浏览器核验新构建首页到现有 N3 详情；HTTP 核验旧版地址仍可打开。冻结的 17 个资讯文件、7 天清单与持久账本、N3 原始模型输出及三项独立修订保留。实际第二篇生成、原文对照及页面验收将在取得本轮授权后执行。

## 2026-10-02 免费准备队列与进度页

已将“已确认产品关联论文 → 准备材料 → 保存中文解读 → 页面阅读”接成可重复的工作队列。新增私有页 `http://127.0.0.1:3200/research/work`，从 VARIPULSE 产品页底部的“内容整理进度”进入。页面显示待整理、材料已就绪、整理中、需补材料、可阅读；有真实保存稿时才出现中文阅读入口。阅读入口根据同一 PMID、DOI、原题选择最新实际中文稿，沿用现有阅读地址。

`scripts/ep-reading-queue.ts plan` 将现有目录中已确认属于 VARIPULSE 的论文去重入队，并同步已保存稿或已准备材料。`prepare --limit 2` 只处理最多两篇待整理任务；每次上限 3 篇、串行、无自动重试，来源不可用则停止本批次。已有材料、保存稿和阻断记录均跳过。队列写入使用互斥锁及原子替换；这是手动运行的单批次入口，尚未新增定时整理任务。

```powershell
Set-Location -LiteralPath 'E:\EPVOICE\AIHOT-PR2B'
$env:DATABASE_URL='postgres://ep_pr1@127.0.0.1:55433/epvoice_content_20261002'
$env:NODE_ENV='development'
$env:MODEL_CALLS_ENABLED='false'
$env:COLLECT_ENABLED='false'
$env:INDEXNOW_SUBMIT_ENABLED='false'
node --env-file=.env scripts/ep-reading-queue.ts plan
node --env-file=.env scripts/ep-reading-queue.ts prepare --limit 2
```

本轮实际确认 8 篇，最终为 **1 篇可阅读、3 篇材料已就绪、4 篇待整理**。新完成的免费材料为：

| PMID | 论文 | 已保存材料 |
| --- | --- | --- |
| 39669927 | 零透视脉冲电场消融的操作流程 | 4 AB、20 FT，PMC11632259 |
| 41239566 | admIRE 当日出院亚组分析 | 3 AB、74 FT，PMC12618193 |

以上均已核对全文自身 PMID、DOI、PMCID 和 CC BY 4.0。准备过程发现并修复三项实际兼容问题：官方 JSON 的 PMID 是数字；部分版权区用带 CC BY 4.0 链接的许可条款措辞；短报告正文没有方法/结果小标题。无小标题分支要求至少 4 个各 200 字符的实际正文段落、正文合计至少 1500 字符及包含表头与数据行的表格，摘要、图注和行政说明不能补足正文。该版式的 `.p` 表格包装不再吞掉行列分隔。此门槛只核对提取材料覆盖，不代表已完成论文解释或临床审核。

第一轮自动准备因数字 PMID 被误判而停止，两篇在修复后人工触发复验并成功；未加自动重试。第一轮错误保留在各论文的 `queue-prepare.log` 中，当前状态已同步为就绪。新增模型请求 **0**，没有新增中文生成稿。3 篇就绪材料的新生成仍需独立授权，既有 N3 授权与资讯试运行额度不可复用。

新增只读接口 `127.0.0.1:3202/api/research-preview/reading-jobs` 仅输出页面字段，不输出文件路径、请求、凭据或原始错误。打开与刷新进度页仅 GET，不启动准备或收费生成。实际 Host、Origin、转发头均返回 403，POST 返回 405，附加 query 返回 404；GET/HEAD 为 private/no-store/noindex。

验证：连续两次 `plan` 均 added=0、attempted=0，队列及已准备文件逐值未变；页面刷新及读取前后中文稿回执仍仅原有 1 条。相关后端单测 24 项、前端相关回归 56 项、后端/测试/脚本类型检查、Web 类型检查与构建通过。浏览器走通产品页→进度页→规范中文稿，桌面及 390×844 视口无横向溢出，浏览器无警告或错误。API 3201 保持原进程，冻结 17 个资讯文件、7 天账本与 N3 原始稿保持原值。当前仍为本机私有预览。

证据：`.data/ep-chinese-reading/queue-verification.json`、`queue.json`、各篇 `preflight.json`，以及 `queue-work/desktop.png`、`queue-work/mobile.png`。`queue-work/verify-queue.mjs` 可重复核验去重、只读 API 边界及回执未新增。
