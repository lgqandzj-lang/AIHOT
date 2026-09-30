# PR2A 第二小提交：摘要片段定位与证据回读

日期：2026-09-30。基线为 `00bd42a76d3e06c096a6c0f9517df2ca6a824ab5`，分支为 `codex/ep-pr2a-metadata`。开始时 HEAD 与该基线一致、工作区干净。本提交只在本地完成，PR1 的源文件和评审边界不改。

## 可运行的行为

`splitAbstractMaterial(db, materialId, ruleVersion?)` 读取已有 `ep_research_materials`，校验其 `payload_hash`，将摘要的来源章节/段落保存为私有片段。每个片段保存材料 ID、材料内容指纹、切分规则版本、序号、章节标签、文本、文本指纹和固定的 `abstract` 范围。没有可用摘要时返回 `empty_abstract` 和空片段列表。

当前规则为 `abstract-source-v1`，不按模型 token 或推测的临床章节切分。相同材料、内容指纹和规则重复/并发执行会复用片段 ID；同一规则下已有切分与当前算法输出不符时拒绝覆盖，要求生产方明确提升规则版本。规则版本参数仅供内部生产方进行版本变更，本提交没有实现第二套切分算法。新材料版本由现有元数据导入器保存为新材料；旧片段、旧引用和旧材料包保留。

`buildAbstractMaterialBundle(db, materialId, { fragmentIds?, ruleVersion? })` 默认提供该次切分的全部片段，也支持明确提供子集。返回包中列出实际提供的片段 ID 和文本，并在数据库保存这份清单。非空摘要但选择空子集时返回 `no_fragments_selected`，与没有摘要的 `empty_abstract` 区分。

`citationForAbstractFragment(fragment)` 生成包含片段 ID、材料 ID、材料指纹、规则版本、片段指纹的引用。`readAbstractFragment(db, bundleId, reference)` 与 `validateAbstractCitations(db, bundleId, references)` 使用数据库中的材料包清单，拒绝不存在、跨材料、跨材料版本、跨规则版本、指纹不符或未提供给本次材料包的引用。调用方修改返回包的清单不能扩大可读范围。回读还核对片段文本指纹，防止损坏的存储数据被当作原证据返回。

这些都是内部数据库函数，没有公开 HTTP 路由。材料包 ID 用于核对本次提供范围，不替代调用方的私有访问授权。引用验证仅返回 `identitiesValidated: true`、`semanticsValidated: false`，不判断结论是否正确。

## 来源解析与兼容性

- JATS 保留 `<sec><title>`、无标题时的 `sec-type` 以及 `<p>` 段落。PubMed 保留 `AbstractText.Label`，无 Label 时保留非 `UNASSIGNED` 的 `NlmCategory`。
- 内联文本按源节点顺序连接，字符实体在 XML 解析时解码。上标/下标采用明确的 `^(...)` / `_(...)` 文本记法，避免 `10<sup>-3</sup>` 变成 `10-3`。外部 DTD 声明被忽略，不发起 DTD 请求；内部实体声明或无效 XML 被拒绝。
- 新取得的 PubMed 元数据可附带 `abstractSections`，其内容必须与保存的摘要一致。旧材料没有这个字段时不添加字段、不重写元数据，原指纹保持兼容。旧纯文本按保存的段落读取；识别已有常见标签前缀时也保留前缀原文。未标注的单段摘要保持整体。
- 已被旧解析器展平并丢失的结构或顺序无法从旧文本恢复；本次不会猜测或改写旧快照。旧纯文本不重复进行实体解码，以免改变已解码文本中的字面实体。

Methods、Results 等标签始终属于 `abstract`。包内固定声明 `fullTextProvided: false`、`processingAuthorization: not_evaluated`、`citationValidation: identity_only`。私有存储或成功回读均不授予模型处理权限。本次没有变更处理/公开权限、应用修订草稿或生成临床字段。

`0041_ep_abstract_evidence.sql` 只追加私有片段表和材料包表，外键复用现有材料 ID；不另建 DOI/PMID 或材料版本系统，不修改旧迁移和公开视图。

## 本机实际验证

Node 24.16.0、独立 PostgreSQL 17.11，数据库 `ep_pr2a_evidence_test`；模型、采集、IndexNow 和飞书推送安全阀关闭。所有新测试使用本项目编写的合成材料；没有读取真实摘要、抓取全文或调用模型。

| 实际执行项目 | 结果 | 退出码 |
| --- | --- | --- |
| `node scripts/ep-pr1-check.ts`（包含迁移） | PR1 55/55；全新库应用 38 个迁移，含 0041 | 0 |
| `node --test --test-concurrency=1 tests/ep-research-metadata.unit.test.ts tests/ep-research-metadata.pg.test.ts` | 已有 PR2A 11/11 | 0 |
| `node --test --test-concurrency=1 tests/ep-abstract-evidence.unit.test.ts tests/ep-abstract-evidence.pg.test.ts` | 新增 15/15：8 个单元、7 个真实 PG 测试 | 0 |
| `npm run typecheck` | 通过 | 0 |
| `node scripts/ep-pr2a-evidence-demo.ts` | 实际切分、子集包构建、引用验证、回读通过 | 0 |
| `npm run build -w @aihot/web` | 通过 | 0 |
| 36 个原有非 shutdown 后端测试文件（命令如下） | 126/153；27 个失败名称与第一小提交的本机基线逐项一致 | 1 |
| `node --test apps/web/tests/*.test.ts` | 7/16；9 个失败名称与基线一致，均为已有 Windows ESM 子进程路径加载问题 | 1 |
| 旧库升级：37 个迁移 → 38 个迁移 | 仅应用 0041；合成旧材料、研究权限和四个公开视图原样保留；旧格式摘要两片段可回读 | 0 |

新增 PG 测试覆盖重复/并发幂等、材料与规则版本变化后的旧引用、结构化/非结构化/空摘要、包清单范围、跨材料/版本和不存在引用拒绝、摘要范围、公开卡片/搜索/权限不变，以及存储指纹损坏拒绝。单元测试另检查内联顺序、数字/单位/否定、字符实体、上下标和来源标签。

原有回归不能称为全绿。未执行完整默认 `npm test`（两个原有 shutdown 文件在此前 PR1 基线验证中发生 120 秒超时，本次未再次运行）；站点未启动，因此未执行运行中站点 smoke。也未执行真实论文材料检查、模型抽取、全文/PDF/OCR、前端或部署验证。

原始输出保留在忽略目录 `.data/ep-pr2a-evidence/`：`pr1.log`、`pr2a-existing.log`、`new-tests.log`、`typecheck.log`、`demo.json`、`upstream-36.log`、`web-build.log`、`web-tests.log`、`baseline-comparison.json` 和 `upgrade-*.log`。只有合成材料进入提交，日志、数据库文件和真实材料均未提交。

## 复现与实际示例

```powershell
$env:DATABASE_URL = 'postgres://TEST_USER@127.0.0.1:55433/ep_pr2a_evidence_test'
$env:NODE_ENV = 'test'
$env:MODEL_CALLS_ENABLED = 'false'
$env:COLLECT_ENABLED = 'false'
$env:INDEXNOW_SUBMIT_ENABLED = 'false'
$env:FEISHU_CONTENT_PUSH_ENABLED = 'false'
$env:FEISHU_INTERNAL_ENABLED = 'false'
Get-ChildItem Env: | Where-Object Name -Match '^FEISHU_.*_ENABLED$' |
  ForEach-Object { Set-Item -LiteralPath ('Env:' + $_.Name) -Value 'false' }
node scripts/ep-pr1-check.ts
node --test --test-concurrency=1 tests/ep-research-metadata.unit.test.ts tests/ep-research-metadata.pg.test.ts
node --test --test-concurrency=1 tests/ep-abstract-evidence.unit.test.ts tests/ep-abstract-evidence.pg.test.ts
npm run typecheck
node scripts/ep-pr2a-evidence-demo.ts
```

原有后端回归实际使用如下文件集合（保持安全阀关闭；提供方备用 URL 均指向本机禁用端口，测试自有 stub 除外）：

```powershell
$epRegressionFiles = @(Get-ChildItem tests -Filter '*.test.ts' -File |
  Where-Object Name -NotMatch '^(ep-|analyze-shutdown|translate-shutdown)' |
  Sort-Object Name | ForEach-Object FullName)
node --test --test-concurrency=1 --test-timeout=120000 $epRegressionFiles
```

本轮合成示例的材料 ID 为 `c181c1f0-f216-4225-a665-239c863e33ef`，材料指纹为 `d5d036b3967ca1040c8f93fb1a06db676e9412e640b4fb336209b28d57f39997`。切出两片段，包 `e3036959-802a-4f71-a2e1-1e39983e0699` 只提供序号 1 的片段 `1fd9bba6-6536-41d9-9eb9-d010e5ff5881`。引用校验通过后，回读结果是：

```json
{
  "ordinal": 1,
  "label": "Methods",
  "scope": "abstract",
  "text": "No sample received ≥5 mg; 2 mm preceded 3 mm."
}
```

上述句子是合成测试文本。身份校验为 `checked: 1`、`identitiesValidated: true`、`semanticsValidated: false`。没有读取正文，也没有授权模型处理。

## 变更文件

- `database/migrations/0041_ep_abstract_evidence.sql`
- `packages/backend/src/research/abstract-text.ts`
- `packages/backend/src/research/abstract-evidence.ts`
- `packages/backend/src/research/metadata.ts`（最小来源结构解析扩展）
- `scripts/ep-pr2a-evidence-demo.ts`
- `tests/ep-abstract-evidence.unit.test.ts`
- `tests/ep-abstract-evidence.pg.test.ts`
- `tests/fixtures/ep-abstract.ts`
- `docs/ep-pr2a-evidence.md`
