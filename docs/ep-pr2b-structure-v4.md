# PR2B 最小结构修订：v4

本轮只修《三篇错误归因表》提出的三类表达缺口。基于本地 `06791bed`，先验证合成 fixture，再接入提取约定、同源生成的提示词和现有私有草稿 JSONB。新增模型请求为 0。

## 原结构缺口 → 新表达方式

| 原结构缺口 | v4 表达方式 |
|---|---|
| 每组只有一个 `sample`，总体与组内多单位计数不能同时独立保存 | `overallSample[]` 保存总体计数；`groups[].sample[]` 保存该组计数。每项独立保存 `quantity/unit/denominator` 及引用；`denominator` 保留原有“人口/纳入口径”含义，所属范围由总体/组容器确定。 |
| 缺少“人群/组别 → 指标 → 数值”的独立结果 | `results[]` 保存本地 `resultId`、`population`、`metric`、`resultValue`、`unit`、已报告的 `statistic` 及各自引用。`comparisons[]` 只接收有引用的明确比较关系。 |
| `time` 自由文本混合操作阶段、操作时长和观察窗口 | `proceduralContexts[]` 保存操作阶段；`results[].kind=duration` 保存操作时长；`observationTimes[]` 必须通过 `resultId` 关联 `kind=outcome` 的具体结局，`time` 是带起点/终点/单位/锚点的 `observation_window`。 |

总体、两组的数量分别保存，不求和校正、不分摊、不自动成为结局分母。结果的 `population` 只能引用本次响应中的 `groupId` 或明确的总体人群。跨记录属性、未声明组别、材料包之外的片段引用均被拒绝。

归属不明的数字仍保存原值；`population` 是 `value:null,status:unknown`，依赖检查记 `local_population_required`，草稿状态为 `invalid_output`（待确定）。不会按数字/组别顺序、大小或临床知识分配。百分比及其他小数放在 `resultValue`；未报告的 `numerator/outcomeDenominator/countUnit` 保持未知，不反算、不继承，不写入 PR1 数值字段。

## 私有保存与旧版本

- `extraction-structure.ts` 的同一份 Zod 定义生成 v4 wire schema、私有保存形状及提示词中的 JSON Schema；规则说明由同一模块导出。
- 模型只填写研究字段及片段 ID。`schemaVersion=ep-abstract-extract-v4` 和校验状态由程序填写。结构/引用通过仍是 `semanticStatus=not_evaluated`、`qualified=false`、`realModelEffectValidated=false`。
- 新结果写入既有 `ep_research_extraction_drafts.raw_output/parsed_output` JSONB，没有新增数据库迁移或业务表。
- v1/v2/v3 按各自旧定义读取。v3 的提示词可以显式重现；旧值、时间字符串、错误状态及引用不补写、不迁移。
- PR1 数据层、公开查询、现有页面及默认模型配置没有修改。

真实 N3 仍是原来 3/7 组的模型遗漏；旧分母判定仍为“待判断”。结构修订不构成真实模型效果改善的证据，未新增论文或归因轮次。

## 明确标记的测试记录

见 `tests/fixtures/ep-extraction-structure.TEST.json`：顶层 `recordType=SYNTHETIC_TEST_RECORD_ONLY`；`modelOutput` 中没有版本、权限、核查通过或公开状态。`inputManifest` 与 `programValidation` 是程序/测试记录部分。

示例为作者编写的测试数据：总体 22 名参与者、88 条肺静脉；Alpha/Beta 各自有两种计数；两组操作时长 48/26 分钟；Alpha 成功率 78.4%，分子/分母未报告；12 个月观察窗口只关联成功结局；消融前 mapping 为流程上下文。所有计数均在合成材料中分别明示。

另有归属不明的 17/29 分钟 fixture；两个数值原样保留，各自人口归属待确定，不形成比较关系。

## 离线长度比较

| 口径 | 压缩 JSON / 字符数 |
|---|---:|
| v3 能表达的合成记录子集 | 1,773 |
| v4 完整合成记录 | 5,383 |
| 新/旧比例 | 约 3.04 倍 |

旧结构不能表达全部新字段，因此这不是信息等量的模型比较。同一材料的生成提示词由 8,280 增至 17,017 字符。未测模型 token 数、效果或截断率；提取原有 `max_tokens=4096` 和默认模型保持原设置。

## 运行与检查

从仓库根目录运行：

```powershell
npm run typecheck
node --test tests/ep-extraction-structure.unit.test.ts

# 使用新建的空测试库，名称必须以 _test / _ci 结尾；不得指向实际私有草稿库。
$env:DATABASE_URL = 'postgres://ep_pr1@127.0.0.1:55433/<new_empty_name>_ci'
$env:NODE_ENV = 'test'
$env:MODEL_CALLS_ENABLED = 'false'
$env:COLLECT_ENABLED = 'false'
$env:INDEXNOW_SUBMIT_ENABLED = 'false'
$env:FEISHU_CONTENT_PUSH_ENABLED = 'false'
node scripts/migrate.ts
node --test --test-concurrency=1 tests/ep-extraction-structure.pg.test.ts tests/ep-extraction.pg.test.ts
```

新增单元检查 12 项、PostgreSQL 检查 4 项覆盖 a–h，以及程序版本/权限字段拒绝、提示词同源定义、测试记录可解析、旧产品约束保留和截断拒绝。PG 测试使用注入的合成响应，没有模型入口；公开及 PR1 记录前后完全一致。

### 本次实际结果

| 检查 | 结果 |
|---|---|
| 接入生产定义之前的合成 fixture 首轮验证 | 7/7 通过 |
| 新 v4 单元 + PG 目标检查 | 16/16 通过 |
| 结构、旧约定和私有读取单元回归 | 48/48 通过 |
| 新旧草稿保存 PG 回归 | 18/18 通过 |
| CLI 私有导出、不可重复发送、旧错误读取 | 5/5 通过；提供器是本机 HTTPS 合成桩，没有实际模型 |
| 全仓 `npm run typecheck` | 通过 |
| 仓库自带 Web 构建 | 通过 |
| Web 测试 | Windows 原生执行 7 通过 / 9 路径失败；仅用临时 ESM 路径适配后 16/16 通过，未改应用或测试源文件 |
| 隔离空库站点烟雾检查 | 全部通过 |
| 全仓 `npm test` | 首轮 330 项：314 通过、10 失败、6 超时取消；完成下述必要复查后仍保留 5 项既有 Windows SIGTERM 超时，**未标为全通过** |

首轮失败的复查：CLI 的当前响应合成桩由 v3 更新为 v4；提前加载配置的临时测试适配器导致的媒体失败修正后，媒体 13/13 通过。普通翻译受同一失败库中的残留候选数据干扰，在新建空库中 3/3 通过。没有修改这些无关业务实现，也未反复执行已知无法在 Windows 完成的 SIGTERM 用例。

本次保留校验：真实私有库的 11 份原回执和 6 类表内容前后完全一致；原审阅材料 168 个文件、前端 569 个文件及无关工作区改动保持原字节。旧 N3 的实际 v3 提示词能够逐字重现，默认 `.env` 与模型配置未变。

完整本地检查结果及原材料/前端/真实私有数据库的保留校验，见 `.data/ep-pr2b/structure-v4-20261001-091246-745508713/work/`。该目录不进入提交。
