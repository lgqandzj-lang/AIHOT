# PR2A 第一小提交：真实文献元数据与修订草稿

日期：2026-09-30。基于已验证的 PR1 提交 `d55b6484ce747e39d463505e21b27308340eaae3`，在独立分支 `codex/ep-pr2a-metadata` 开发；PR1 的 13 个文件和评审边界不改。

## 本次能做什么

- `fetchCrossrefMetadata(doi)` 从 Crossref REST 获取 DOI 元数据；`fetchPubmedMetadata(pmid)` 从 PubMed EFetch XML 获取 PMID 元数据。两者只作单篇查询，不搜索或下载全文，不调用模型。
- 保存来源标识、来源链接、取得时间、标题、作者、期刊、已知的出版年与精确日期、摘要及其来源位置、来源版本。只有年或年月时，精确日期保持 `null`；没有摘要、标题或临床信息时不补写。新研究的 `study_design` 为 `unknown`，没有自动生成组别、结果或分母。
- DOI/PMID 身份都指向同一 `ep_research_records` 记录。相同来源、同版本内容重复取得时复用材料和已有草稿；取得时间不会让相同材料伪装成新版本。
- 新文献只建不公开的研究草稿。已有文献出现新的来源、摘要或版本时，新增私有材料和 `ep_research_revision_drafts` 草稿，记录当时的 `input_hash` 与相异字段；不修改旧研究记录、人工修正、结果、权限或公开视图。DOI/PMID 指向不同记录时材料以 `identity_conflict` 留存，不自动合并。缺标题且无法匹配记录时以 `needs_metadata` 留存，不编造标题。
- `ep_research_materials.id` 与元数据内的 `abstractLocator` 是后续正文定位、提取和核查的连接点；本次不实现应用草稿、正文抽取或审核界面。材料和草稿均没有公开视图。

`0040_ep_research_metadata.sql` 仅增表和回填已有 PR1 DOI/PMID 身份，不改 PR1 表、公开视图或前端。导入事务使用原 postgres.js 连接；所有 SQL 值都绑定参数。联网函数接收可注入的 `fetcher`，离线测试使用固定的合成响应，不访问外部服务。

## 来源与材料边界

Crossref 的元数据和 PubMed 的书目信息不自动赋予摘要或全文公开展示权。摘要保存在私有材料 JSON 中，不进入 PR1 的公开白名单。PubMed 这里只调用 EFetch 的单篇 XML；没有 PDF、PMC 全文、付费模型、采集任务或推送。来源版本采用提供方的修订/存入时间（若有）以及归一化内容哈希；原始响应未归档。来源规则见 [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) 与 [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25497/)。

## 本地验证方法

使用 Node >=24.11 与独立 PostgreSQL 17 测试库，库名以 `_test` 或 `_ci` 结尾。`DATABASE_URL` 指向测试库，模型、采集、推送和 IndexNow 安全阀设为 `false`；不读取生产 `.env`。

```powershell
$env:DATABASE_URL = 'postgres://TEST_USER@127.0.0.1:55433/ep_pr2a_test'
$env:MODEL_CALLS_ENABLED = 'false'
$env:COLLECT_ENABLED = 'false'
$env:INDEXNOW_SUBMIT_ENABLED = 'false'
$env:FEISHU_CONTENT_PUSH_ENABLED = 'false'
$env:FEISHU_INTERNAL_ENABLED = 'false'
node scripts/ep-pr1-check.ts
node --test tests/ep-research-metadata.unit.test.ts
node --test --test-concurrency=1 tests/ep-research-metadata.pg.test.ts
npm run typecheck
```

本轮本机实际使用 PostgreSQL 17.11；迁移总数 37（含 0039、0040）。PR1 验收 55/55、PR2A 离线单元与数据库共 11/11、全工作区类型检查、Web build 均通过，退出码均为 0。36 个原有非 shutdown 测试文件为 126/153，通过数与 PR1 同提交基线相同，27 个失败名称逐一相同；原有 Web 测试为 7/16，9 个失败均发生在 Windows ESM 子进程路径加载，与 PR1 基线相同。两组回归退出码均为 1，不能称为完整回归通过。原始命令输出保留在忽略目录 `.data/ep-pr2a/`；完整 `npm test` 的两个原有 shutdown 文件和运行中站点 smoke 未在本次取得通过结果。

另在 `ep_pr2a_upgrade_test` 先由原 PR1 检出应用 36 个迁移，插入一条明确标记的模拟公开记录，再由 PR2A 检出只应用 0040。升级前后公开记录数均为 1；0040 回填 DOI、PMID 两条身份映射，未创建材料或修订草稿。

## 单独的真实联网试跑

脚本要求显式 `EP_PR2A_LIVE_TRIAL=1`，只允许测试库。它按 PMID 取 PubMed 元数据，再按返回的 DOI 取 Crossref 元数据；仅打印身份、标题、是否有摘要与导入结果，不输出摘要正文。

```powershell
$env:DATABASE_URL = 'postgres://TEST_USER@127.0.0.1:55433/ep_pr2a_live_verified_test'
$env:EP_PR2A_LIVE_TRIAL = '1'
node scripts/migrate.ts
node scripts/ep-pr2a-live-trial.ts 41129023
```

先用 VARIPULSE 论文 PMID `41129023` / DOI `10.1007/s10840-025-02162-0` 跑通，发现并修正 PubMed 数字字符实体未解码的问题后，在全新测试库重新执行。PubMed 创建一个私有记录，Crossref 补充同一 DOI 时形成一份修订草稿；再次联网取得相同材料时两者均返回 `unchanged`。随后对 PMID `40412874` 和 `40115621` 各执行同一流程。最终测试库为 **3 条研究、6 份来源材料、3 份修订草稿、0 条公开记录、0 个自动生成的组别和结果**。分篇日志在 `.data/ep-pr2a/live-*.log`，不提交；这不是临床字段抽取或准确率评测。

## 已知限制与下一步最小任务

- 不共享 DOI 或 PMID 的两个来源不会靠标题相似度自动合并；同 DOI/PMID 出现冲突会留在待核查材料中。
- 摘要的提供方标记和内容哈希已保存，但原始 XML/JSON 和正文页码尚未保存；来源后续更新只能重取并形成新版本。
- 目前没有草稿应用/驳回操作，也没有人工审核 UI。下一项最小任务是给私有材料建立稳定的正文/段落定位与核查输入契约，再决定何时启用模型辅助提取；本提交不启动 PR2B。
