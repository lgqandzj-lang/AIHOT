# PR2B：私有摘要提取与单次试跑

基线为 PR2A `699f7d3f63b6e83555ac1555715e361f483ea346`；独立分支 `codex/ep-pr2b-extract`，本地工作区 `E:\EPVOICE\AIHOT-PR2B`。PR1、PR2A 的已有提交和分支未改写。本次仅本地提交。

## 当前一次真实试跑结果（2026-10-01）

**真实 DeepSeek 提取已经执行一次，零重试。返回的 JSON 完整，但字段结构被拒绝；尚未形成合格研究卡。** 以下原实现和准备记录保留为历史证据。

- 用户明确不授权向模型发送 PMID `41129023`；该实际材料包的试跑与提取草稿仍为 0。未覆盖其原快照或研究记录，未沿用其答案。
- 本轮替代材料为 PMID `39820338`、DOI `10.1093/europace/euaf007`，标题 *Early versus late atrial fibrillation recurrence after pulsed field ablation: insights from the admIRE trial*。已核对[出版社页面](https://academic.oup.com/europace/article/27/2/euaf007/7954794)标注的 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。完整作者、来源、版权声明、许可、核对时间与修改标识保存在私有输出包的 `attribution-license.json`。不声称另有作者或出版社许可。
- 使用 PubMed 的 Aims、Methods and results、Conclusion 摘要文字，并逐段对照出版社摘要。PubMed 另附的注册号段、关键词、图表、全文与第三方材料未进入输入。建立独立隔离库 `ep_pr2b_admire_test`（39 个迁移）及独立材料/包。
- 研究提取器使用 `deepseek-flash`、`https://api.deepseek.com`、`thinking={"type":"disabled"}`、`response_format={"type":"json_object"}`、`temperature=0`、`max_tokens=2048`。配置只在被 Git 忽略的本地 `.env`；未修改 Codex 自身设置。没有收费连接测试、批量任务、worker 或自动恢复。
- 新材料重新计量：摘要 1,657 字符、3 片段；system/user 消息 4,681 字符、4,685 UTF-8 字节。使用固定官方仓库版本 `dba1be0a40aa45a94ad051997016db3960a90277` 的 V4.1 tokenizer 与消息编码，离线计数为 1,408 token，计入 response-format 指令的变体为 1,430 token。依据无扩展 normalizer、无前缀补空格的字节级 BPE，对完整编码及请求体核定保守输入上界 4,829 token；没有把字节统计当成精确 token 用量。
- 调用前从[官方人民币计价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)核对并留存快照、时间与哈希。按高峰、输入全部缓存未命中价格预留：输入 2 CNY/百万 token，输出 8 CNY/百万 token，费用上界 **0.026042 CNY**。用户限额为本轮 2 CNY，绑定同一材料、最终请求与价格合同，没有提高额度。
- **实际回执：1 次请求，输入 1,430 token（命中 0、未命中 1,430），输出 1,233 token，总计 2,663 token，`finish_reason=stop`。** 使用量与官方离线带格式指令的变体计数一致；输出没有被上限截断。供应商金额字段仍为 `null`。按使用量及高峰价保守估算 **0.012724 CNY**（闲时价估算 0.006362 CNY）；估算及预留均不等于实际账单，不能报告为确切扣费或免费。
- 严格字段错误有 3 项：`sample.quantity`、`sample.unit` 未按 `{value,citations}` 返回；`imagingMethods` 返回空数组，未知值应为 `null`。数据库保存 `invalid_output`，严格引用检查为 `not_checked`，语义状态仍为 `not_performed`。不能因为 JSON 可解析而标为格式合格。
- 本地助手回读了模型实际提供引用的 7 个字段，引用身份有效；这不改变整个输出的拒绝状态。逐字段语义对照还发现产品字段把技术类别作为产品、分母和部分观察用途/分层遗漏。完整实际值、原文引用、支持判断与缺失原因位于私有 `field-check.md/json`，仍待人工确认和修改。没有自动改写原始响应、授予审核或公开状态。
- 在入口中补充结构错误 JSON 的原始字段诊断显示。它保留裸值、空数组、缺失引用与不合法引用，只用于阅读，不自动修复或进入 `parsed_output`。这次既有严格报告和原始回执保留，另从相同回执生成 `raw-field-diagnostic.json`，没有重发请求。
- 最终本地核对：1 轮、执行计数 1、1 草稿、1 回执、1 个 live attempt、0 条公开记录；原材料包试跑/草稿均 0；所有持久化外发任务开关均关闭。原始材料、响应、授权文件、计价快照和私有日志均不进入 Git。

### 当前可核对的交付物及检查

私有输出目录：`.data/ep-pr2b/live-2d834b26-9a24-49b8-b200-1c598802ada5/`。

| 交付物/检查 | 内容或结果 |
|---|---|
| `field-check.md/json` | 实际回执的 12 行逐字段对照，附遗漏项与完整原文片段；区分模型引用和助手补链对照 |
| `field-report.md/json` | 原始严格拒绝结果及 3 项结构错误，保留未通过状态 |
| `raw-field-diagnostic.json` | 同一响应的原始字段诊断，不归一化或修改草稿 |
| `provider-receipt.json`、`execution.json` | 原始供应商响应、用量及唯一执行记录 |
| `final-state-and-cost.json` | 计数、开关、原材料保全、账单未知及估算口径 |
| `attribution-license.json` | 完整署名、标题、DOI、来源、许可、时间与修改标识 |
| `final-request.json`、`input-count-evidence.json`、`official-pricing-evidence.json` | 本次最终参数、固定 tokenizer/编码、计价核验及指纹，不含 API 密钥 |
| 既有 PR2B 24 项 + 最初新增入口 3 项 | 27/27，exit 0；`.data/ep-pr2b/varipulse-offline-tests.log` |
| 最终入口检查 | 5/5，exit 0；`.data/ep-pr2b/admire-cli-final-tests.log`；仅合成材料与回环 HTTPS，无外部服务 |
| 最终完整 workspace 类型检查 | exit 0；`.data/ep-pr2b/admire-typecheck-final.log` |

最终入口检查覆盖禁发与路径边界、结构错误值保全、准备时强制关闭模型、安全授权阻断、回环 HTTPS 一次响应导出和重跑不能再发送。更改未涉及 PR1/PR2A、Web 或原后端回归范围，复用原记录；上文已知失败不改写为通过。

回环 HTTPS 检查首轮 4 个用例通过后，测试清理因试跑外键引用材料包而失败；失败日志保留为 `varipulse-cli-afterhook-failure.log`。清理顺序修正为删除本用例草稿/试跑/回执，再删除本用例记录，并保证数据库关闭。修正后 4/4 通过；补充结构错误诊断值检查后最终 5/5。所有这些请求只到回环 stub，不属于实际供应商调用。

## 实现及边界

- 从 PR2A 数据库中读取已经持久化的材料包，并验证材料内容指纹；模型输入记录准确的材料 ID、版本指纹、切分规则、标题与实际提供的片段。
- 只提取产品角色、研究对象、样本数量/单位/分母口径、影像方式、射线策略、观察时间及用途。分组保存，未知为 `null`。模型必须为每个非空值提供片段身份；不同组别不进行程序合并。
- 输出使用严格 schema。额外的公开权限、审核状态、SQL 字段及 SQL 语句被拒绝，输出始终作为数据处理，不执行代码或 SQL。
- 分别保存格式检查、引用身份检查、`semantic_status=not_performed`。不存在、其他材料/版本、未提供的片段被拒绝。真实引用也可能不支持结论；没有自动语义审核，也不根据身份检查授予审核或公开状态。
- 草稿与原始输出保存到私有表；固定 Markdown 模板逐字段显示草稿值、引用及原文回读。既有研究结果和公开状态不变。
- 真实路径复用 `chatJson`、`paidRequest` 及现有回执。默认需要显式 `enableRealRequest=true` 才可能发送，并同时要求模型安全阀、严格授权/费用预检和已持久化的试跑记录。离线路径要求可注入响应，不能回退到真实模型。
- 没有全文/PDF/OCR/向量检索、前端、审核后台、批量文献任务、worker 或定时任务。示例的三个材料包均是作者编写的合成测试材料。

私有材料包不是向模型发送材料的许可。材料 ID/包 ID 也不是用户认证凭证；这些函数没有新增 HTTP 路由，只供可信本地/后端调用。

## 变更文件（14 个）

| 文件 | 作用 |
|---|---|
| `database/migrations/0042_ep_extraction_drafts.sql` | 新增私有草稿、试跑金额/次数记录；向回执追加兼容的重试策略列 |
| `packages/backend/src/research/abstract-evidence.ts` | 最小扩展：受控读取已持久化的材料包 |
| `packages/backend/src/research/extraction-schema.ts` | 严格字段结构、未知值、分组、片段引用和提示词 |
| `packages/backend/src/research/extraction-budget.ts` | 请求/授权/计价核对、整数费用上界、金额预留和单次执行认领 |
| `packages/backend/src/research/abstract-extraction.ts` | 离线与显式真实提取、独立检查、私有保存、逐字段报告 |
| `packages/backend/src/providers/llm.ts` | 复用同一最终请求构建函数；核对预检指纹；单次路径拒绝重定向 |
| `packages/backend/src/providers/receipts.ts` | `retry_policy=never` 持久化，禁止失败后再次请求 |
| `packages/backend/src/admin/runs.ts` | 自动/旧人工恢复流程不能释放单次试跑回执 |
| `scripts/ep-pr2b-extract-demo.ts` | 可执行的离线闭环，生成三个材料包、报告和真实调用预检 |
| `tests/fixtures/ep-extraction.ts` | 完全合成的原材料、删除依据后的材料、独立对照及固定响应；运行模块不导入测试答案 |
| `tests/ep-extraction.unit.test.ts` | 结构、未知、组别、删除检查、计价和最终 token 上限测试 |
| `tests/ep-extraction.pg.test.ts` | 私有草稿/引用/公开保全、金额限制、真实子进程重启后次数保全 |
| `tests/ep-extraction-receipts.pg.test.ts` | 本机 HTTP 固定响应、最终参数漂移、超时、不重试及重定向检查 |
| `docs/ep-pr2b-extract.md` | 本交付记录 |

## 首次真实调用保护

检查原实现发现：`budgets` 是按分钟/小时/天统计**请求次数**的熔断，不是金额预算；`chatJson` 的费用字段为 `null`，不能从回执次数推断实际花费。原实现会至少给 512 输出 token，`-think` 预设追加 4000 token，且模型 `extra` 可以覆盖请求字段。原恢复逻辑会放行未知请求一次。

本次补充：

1. 预检与实际调用复用最终请求构建逻辑。最终请求指纹覆盖模型、消息、输出 cap 和预设覆盖参数；调用前再次核对指纹与服务地址。提取器拒绝预设覆盖 `messages`，保证实际发送的材料与已记录的片段清单一致。回执摘要记录最终 `max_tokens`，不会只记覆盖前的值。
2. 明确授权必须绑定单一材料包/内容版本、单模型、服务地址、最终请求指纹、币种、额度及材料处理依据。授权和计价都有有效期。
3. 计价合同必须给出与本请求绑定的已核对输入 token 上界及计数依据、输入/输出单价上界、额外费用上界、计价来源和核对时间，并明确最终输出 cap 覆盖全部收费输出（包括 reasoning）。缺项即阻断。输入字符/UTF-8 字节不是已核对 token 数。
4. 使用整数微元（1 币种单位 = 1,000,000 微元）和 `BigInt` 向上取整计算上界：`ceil((输入 token 上界 × 输入每百万 token 微元单价 + 最终输出 cap × 输出每百万 token 微元单价) / 1,000,000) + 额外费用微元`。与获准额度同币种比较并在事务中预留。
5. 一份人类授权唯一对应一轮，执行认领在网络请求前持久化，最多 1 次；跨进程全局认领限制试跑并发为 1。重启不能清零额度预留或执行计数。
6. `retry_policy=never` 禁止失败后的再次发送，也阻止旧恢复入口释放该回执。请求不跟随 HTTP 重定向。超时或崩溃留下 `unknown`/`in_flight` 与费用预留，阻止新的试跑进入；需要另行人工核对供应商结果及账单，没有自动退款或重新请求。
7. 执行计数是保守认领记录，不能等同供应商已收费次数；预留上界也不是实际账单。既有回执仍保留 usage/raw response 机制，实际费用没有被伪填。

计价/计数依据必须在具体模型试验前从适用服务规则核对。首个提交时没有选择收费服务，没有已批准模型/额度，也没有调用任何真实模型；当前一次试跑见文首。测试中的 `provider.example` 和费率仅为合成算法样本，不能作为任何服务的当前价格或用户授权。

## 实际运行环境及命令

Node.js 24.16.0；独立 PostgreSQL 17.11，`127.0.0.1:55433`。主测试库 `ep_pr2b_extract_test`，升级测试库 `ep_pr2b_upgrade_test`。无生产库、无 `.env` 加载。

以下 PowerShell 配置后执行测试；现有 FEISHU 开关均为关闭：

```powershell
$env:DATABASE_URL='postgres://ep_pr1@127.0.0.1:55433/ep_pr2b_extract_test'
$env:MODEL_CALLS_ENABLED='false'
$env:COLLECT_ENABLED='false'
$env:INDEXNOW_SUBMIT_ENABLED='false'
$env:EP_PR1_REPORT_DIR='.data/ep-pr2b/pr1'
node scripts/ep-pr1-check.ts
node --test --test-concurrency=1 tests/ep-research-metadata.unit.test.ts tests/ep-research-metadata.pg.test.ts tests/ep-abstract-evidence.unit.test.ts tests/ep-abstract-evidence.pg.test.ts
node --test --test-concurrency=1 --test-timeout=120000 tests/ep-extraction.unit.test.ts tests/ep-extraction.pg.test.ts tests/ep-extraction-receipts.pg.test.ts
npm run typecheck
node scripts/ep-pr2b-extract-demo.ts
npm run build -w @aihot/web
node --test apps/web/tests/*.test.ts
```

HTTP/回执测试只对进程内 `127.0.0.1` stub 临时开启 transport 的配置值并使用假密钥，结束后恢复关闭；没有收费服务请求。离线提取通过注入固定响应完成。

| 检查 | 实际结果 | 本地日志（未进入 Git） |
|---|---|---|
| PR1 验收（含真实 PostgreSQL / EXPLAIN） | 55/55，exit 0；空库累计 39 迁移 | `.data/ep-pr2b/pr1-final.log`、`pr1/ep-pr1-explain.json` |
| PR2A 元数据 + 摘要证据验收 | 26/26（11 + 15），exit 0 | `.data/ep-pr2b/pr2a-final.log` |
| PR2B 新增离线工程测试 | 24/24（7 单元 + 11 数据库 + 6 HTTP/回执），exit 0 | `.data/ep-pr2b/new-tests-final.log` |
| 原有回执契约，独立本机固定响应验证 | 7/7，exit 0；仅本机 stub，含原恢复策略兼容性 | `.data/ep-pr2b/legacy-receipts-local-stub.log` |
| 完整 workspace 类型检查 | exit 0 | `.data/ep-pr2b/typecheck-final.log` |
| 离线示例 | 3 个合成包分别形成报告，exit 0，真实请求 0 | `.data/ep-pr2b/demo.log` |
| Web 构建 | exit 0 | `.data/ep-pr2b/web-build.log` |
| 原有后端 36 文件回归 | 126/153，27 失败，exit 1 | `.data/ep-pr2b/upstream-36.log` |
| Web 测试 | 7/16，9 失败，exit 1 | `.data/ep-pr2b/web-tests.log` |
| PR2A 旧库升级 | 38 → 39，仅新增 `0042`；旧数据/公开视图/预算/回执保全，exit 0 | `.data/ep-pr2b/upgrade-*.log`、`upgrade-snapshot.json` |

原有后端与 Web 的失败名称均逐项与 PR2A 基线比较，分别 27/27、9/9，一致且没有新增失败名称；记录为 `.data/ep-pr2b/baseline-comparison.json`。这不表示完整回归通过。后端主要是模型开关关闭下的旧用例失败；Web 为已有 Windows ESM 路径错误（`ERR_UNSUPPORTED_ESM_URL_SCHEME`）。

36 文件回归的实际筛选命令（完整文件列表保存在 `upstream-files.json`）：

```powershell
$epRegressionFiles=@(Get-ChildItem -LiteralPath tests -Filter '*.test.ts' |
  Where-Object { $_.Name -notmatch '^ep-' -and $_.Name -notin @('analyze-shutdown.test.ts','translate-shutdown.test.ts') } |
  Sort-Object Name | ForEach-Object { 'tests/' + $_.Name })
node --test --test-concurrency=1 --test-timeout=120000 $epRegressionFiles
```

该回归还把模型地址限制到本机回环、清除继承的模型密钥并禁用 credentials 文件路径。未运行默认完整 `npm test`：两个 shutdown 文件在既有 Windows 基线已各出现 120 秒超时，本轮不重复该已知阻断。没有启动站点，因此站点 smoke 未运行。

为验证共享回执代码的正常调用路径，另执行 `node --import ./.data/ep-pr2b/legacy-local-stub-setup.mjs --test --test-concurrency=1 --test-timeout=120000 tests/receipts.test.ts`。该测试辅助文件先核对模型地址均在 `127.0.0.1`，再对当前子进程临时启用 transport；测试自身用进程内 HTTP stub 和假密钥。7/7 通过，不涉及真实服务或费用。此辅助文件保留在本地忽略目录，不是生产启动入口。

首轮新增测试 20/21，有 1 个测试输入碰撞：超时与非法输出使用同一提示词，回执按设计阻断再次发送。修复合成输入身份后通过，首轮日志保留为 `new-tests-initial.log`。随后补充重定向、重试策略不可降级和 `messages` 覆盖拒绝用例，最终 24/24。升级辅助脚本首轮相对路径错误也保留在 `upgrade-before-initial.log`，修正后实际完成升级比较。

## 逐字段报告与后续模型试验材料

离线示例实际生成，全部文件位于 `.data/ep-pr2b/`，不进入提交：

- `bundle.original.json`：3 片段，原合成材料；`field-report.original.md`：20 字段，两个组别的样本量为 12、8，分母口径分别保留。引用身份有效，语义核查尚未进行。
- `bundle.ablated.json`：2 片段；删除 Group A 的唯一射线策略依据。标题和全部剩余片段检查没有同一依据残留；固定响应对应值为未知。`field-report.ablated.md`：20 字段。
- `bundle.control.json`：独立合成材料、1 片段；5 动物、CT、48 hours 的定位观察，射线策略未知。`field-report.control.md`：10 字段。
- `offline-reports.json`：结构化逐字段回读结果；`evaluation-only.json`：独立评测对照，未传入提取输入。

另实际测试了“源片段写 30 days，固定响应写 365 days，引用真实存在”的情况：格式/身份均有效，但 `semantic_status` 仍为 `not_performed`，不会标成语义审核通过。

报告用固定模板生成；没有独立的文案模型调用。固定响应通过验证的是工程闭环，不是模型提取准确率。

## 首个提交的合成材料预检

真实预检文件：`.data/ep-pr2b/live-preflight.json`，基于原合成摘要包实际生成。

| 项目 | 当前值 |
|---|---|
| 模型名称/服务 | 未获明确批准，未选择 |
| 材料范围 | 单份合成摘要包，3 个实际提供的片段；无全文 |
| 输入规模 | system + user 消息序列化为 3,474 字符 / 3,474 UTF-8 字节；不是 token 数 |
| 输出上限 | 提取器请求 2,048 token；最终上限需结合获批模型及预设核对，当前未知 |
| 输入 token 上界/计数依据 | 未核对，未知 |
| 计价规则/币种/费用上界 | 未核对，未知；不使用猜测价格 |
| 金额授权/材料处理授权 | 未获得 |
| 首次试跑限制 | 单材料、单模型、单并发、最多 1 次、自动重试 0 |
| 当前是否可发送 | 否：`ready=false`、`canSendRealRequest=false`、模型开关关闭 |

真实模型效果尚未验证。未做真实服务的格式/准确率/语义支持试验，没有向模型提供真实论文摘要或其他受限材料；没有实时计价核验、真实 token 计数或供应商账单对账。

该预检属于首个提交的合成材料工程验证，不是 VARIPULSE 实际模型试验。后续单次试跑改用下节已取得的真实摘要，不自动执行其他材料。

## 2026-10-01：PMID 41129023 历史准备（未获发送许可）

先核对本地进度：`codex/ep-pr2b-extract` 已有 `e7183b99d8eea12495b25111d78811d00152de39`，父提交为用户指定的 `699f7d3f63b6e83555ac1555715e361f483ea346`，开始时工作区干净。复用现有模块，新增一个可执行入口和最终五个有费用/隐私意义的入口测试，没有重写提取器、材料包、回执或预算模块。该节准备随后被用户明确替换，不能当作当前获准材料。

### 已准备的实际输入与当前结果

- 使用此前已经取得的 PubMed 摘要（PMID `41129023`）。摘要为 1,871 字符，实际材料包提供 4 个片段；没有抓取全文或任何新材料。
- 原快照只读；为本次准备创建隔离库 `ep_pr2b_varipulse_test`，39 个迁移。核对源快照指纹后复制同一版本，材料及研究记录仍为私有。
- 提供给模型的 system/user 消息序列化为 5,433 字符、5,457 UTF-8 字节。这是字符/字节统计，尚无已核对的 token 上界。
- 原文与输入文件保留在 `.data/ep-pr2b/live-<bundle-id>/provided-input.json`；预检在同目录 `preflight.json`。真实摘要、运行日志及原始响应不进入 Git。
- **工程链路已准备，模型效果尚未验证。** 当前 `ready=false`，实际模型请求 0，真实材料包的试跑记录、提取草稿和回执均为 0；未得到可逐字段核对的实际模型输出。
- 同目录 `preparation-status.md` 明确列出“字段 / 模型输出 / 原文引用 / 是否支持 / 错误或缺失原因”，各字段当前标注“未调用，无输出 / 未评估”，不以合成响应或手填答案代替结果。真正的 `field-report.md` 留给实际调用结果，后续准备命令不会覆盖已有结果。

### 可执行入口

```powershell
# 只准备输入/预检；即使继承 MODEL_CALLS_ENABLED=true，也强制关闭模型调用。
node --env-file-if-exists=.env scripts/ep-pr2b-extract-one.ts prepare --material '<material-id>'

# 对既有包重新检查；只有显式选择模型时才构造该模型的最终请求。
node --env-file-if-exists=.env scripts/ep-pr2b-extract-one.ts prepare --bundle '<bundle-id>' --model '<model-key>' --approval '.data/ep-pr2b/approval.json'

# 仅在材料、服务、价格和额度已获授权且预检通过后运行一次。
# 还要求当前子进程显式 MODEL_CALLS_ENABLED=true；不会自行开启安全阀。
node --env-file-if-exists=.env scripts/ep-pr2b-extract-one.ts run --bundle '<bundle-id>' --approval '.data/ep-pr2b/approval.json' --execute-once
```

入口只接受回环地址的隔离 `_test`/`_ci` 数据库，拒绝生产环境。授权文件只能位于忽略的 `.data/`。`prepare` 不创建回执、试跑预留或模型草稿；`run` 复用现有金额预留、持久化认领和 `retry_policy=never`。执行结果写入同目录的 `field-report.md/json`、`provider-receipt.json`、`execution.json`，原始响应仍为私有。引用身份和语义判断分别记录；不会自动授予核查或公开状态。

### 本次实际验证

| 检查 | 实际结果 | 本地证据 |
|---|---|---|
| 既有 PR2B 24 项 + 新入口 3 项 | 27/27，exit 0；全部为合成材料或回环 HTTP stub | `.data/ep-pr2b/varipulse-offline-tests.log` |
| 完整 workspace 类型检查 | exit 0，包含新脚本与测试 | `.data/ep-pr2b/varipulse-typecheck.log` |
| 实际摘要准备入口 | exit 0；4 个片段，零请求，预检阻断 | `.data/ep-pr2b/varipulse-preflight.log` |
| 数据库状态核对 | 真实包试跑/草稿/回执均 0；canonical `draft`、公开许可 false | `.data/ep-pr2b/varipulse-database-check.json` |
| 当前模型配置只读核对 | 根目录无 `.env`，未配置 credentials 目录；5 类模型密钥与 API 地址均缺失，没有输出密钥 | `.data/ep-pr2b/current-config-audit.json` |

测试重点是：准备命令不能因继承开关而发送；未授权的运行不能创建试跑或回执；私有输入不变成虚构模型输出；并继续验证既有计价、引用、未知、跨组、超时和零重试契约。PR1/PR2A、Web 和原后端大范围回归复用前序提交的验证记录，未重复运行；其已知失败和未运行项仍按上文报告。未执行真实模型、准确率或人工语义核查。

### 真实试跑所缺的条件与费用口径

1. 明确模型服务、模型名和 API 地址，并把 API 密钥配置在本地；不要在聊天或提交中提供密钥。
2. 明确允许向该服务发送本次摘要、仅形成私有研究草稿的处理依据；已取得材料不是该授权。
3. 明确本次获准的最高金额和币种。
4. 服务确定后核对官方适用价格、最终请求指纹、准确的输入 token 上界，以及输出/推理和其他收费项。提取器请求 2,048 输出 token，但最终 cap 仍需结合实际模型预设确认。

该准备阶段服务、价格和 token 上界均缺失，**当时费用上界无法核定**，未以其他服务的示例价格估算。该材料包的真实请求次数与调用用量仍为 0，没有供应商模型回执。用户之后明确不授权发送此篇摘要，当前唯一真实试跑已经改用文首的独立替代材料。缺项清单不是要求用户再次授权已完成的一次调用。
