# VARIPULSE 私有资讯：手动运行

## 入口与本轮范围

运行入口为 `scripts/ep-private-news.ts`。一次执行会发现候选、复用现有材料入口去重、保存来源与日期、处理已授权的中文题名草稿，并写入现有私有读取页面。浏览器读取保存记录，不调用模型。

固定使用两个来源：

| 来源 | 获取方式 | 保存、展示和模型处理范围 |
| --- | --- | --- |
| PubMed | 官方 ESearch + 已有 EFetch 书目适配器；`VARIPULSE[Title/Abstract]` | 保存题名、作者、期刊、日期、PMID/DOI；丢弃 API 返回的摘要及摘要分段。模型仅接收题名、来源、类型和期刊。 |
| Johnson & Johnson | 已有 RSS 适配器；官方 `https://www.jnj.com/rss-feed/all` | 按题名匹配 VARIPULSE；保存题名、日期、原文链接；不请求新闻正文。若 RSS 简介中存在明确 DOI/PMID 链接，可连接已有研究记录，新闻和论文仍有独立身份。 |

读取与使用依据：[PubMed 下载/API 说明](https://pubmed.ncbi.nlm.nih.gov/download/)、[NCBI 政策](https://www.ncbi.nlm.nih.gov/home/about/policies/)、[J&J RSS 说明](https://www.jnj.com/rss)、[J&J 使用条款](https://www.jnj.com/terms-of-use)。公开 API 或 RSS 的可读取性不表示获得摘要、正文或全文的再利用权限，本实现只处理上述范围。

仅原题明确出现 VARIPULSE 时确认产品关联；搜索发现但原题未点名的资料保留关联候选。题名明确出现 follow-up、long-term、sub-analysis 或 secondary analysis 时标为后续研究报告，其余研究条目标为新论文，厂商来源标为官方动态。分类和产品证据来自来源记录，不交给模型猜测。

平台发现日期和来源发表日期独立保存。沿用现有材料入口的历史补录标记：发表时间早于平台发现 48 小时，或没有发表日期的记录进入历史补录；近期没有记录时显示空状态。PubMed 的检索日期口径与记录中最早发表日期可能不同，页面始终显示已保存的来源发表日期，不改成发现当天。

## 操作

当前私有页为 `http://127.0.0.1:3200/research/news`。从探索页点击“浏览研究资讯”，或从顶部“资讯”进入；卡片连接 VARIPULSE 产品研究及研究详情。新书目详情只显示书目信息，未提取摘要和研究结果。来源状态失败时单独显示“暂时无法读取”，不会解释成没有新增。

当前流程限定本机隔离测试数据库，必须明确设置以 `_test` 结尾的数据库 URL。保持全局模型、采集和推送开关关闭；本脚本只在本次已授权前台进程中短暂打开模型调用。两个来源均设置为 `isolated`、`enabled=false`、全文开关关闭，不加入 worker 或公开出版队列。

在后端目录运行以下免费入口（输出目录每次应使用新名字）：

```powershell
$env:DATABASE_URL='postgres://ep_pr1@127.0.0.1:55433/ep_pr2b_admire_test'
node --env-file=.env scripts/ep-private-news.ts --days 30 --limit 2 --model deepseek-flash --bibliography ../AIHOT-FRONTEND/.data/frontend/private-cards-20261001/prior-experience.json --pricing .data/ep-pr2b/private-news-20261001-609052587/pricing.json --out .data/ep-pr2b/private-news/runs/my-new-run
```

没有 `--authorization` 时，脚本只发现、保存、去重和生成待调用计划，模型请求数为 0。它不会代写中文文案或把旧样板计为本次成功。`--model` 只选择既有服务预设，不写入默认模型配置；`--pricing` 是当前核实的官方峰时价格、有效时间和货币边界，过期后不能执行模型请求。

真实调用必须先报告清单、最多请求数、费用上界及材料处理范围，并获得该批次的新授权。授权 JSON 位于所批准的 `plan.json` 旁，包含 `version=ep-private-news-authorization-v1`、`planHash`、`currency=CNY`、`authorizedMicros`、`maxRequests`、`requestHashes`、`expiresAt` 和真实用户授权文字 `humanRequest`。未经授权不得创建“已授权”文件。旧论文提取授权不可用于本轮资讯。

取得授权后，同一入口增加 `--authorization <授权文件路径>`，使用新的 `--out`。请求被限制为批准计划中的记录与请求哈希；后来发现的新记录只保存为候选。单篇输出上限为 512 tokens，自动重试为 0，不自动更换模型。回执沿用已有 `chatJson`、预算熔断和 receipts；先有回执，再事务性保存独立中文展示文案。

## 重复执行、保存与限制

- 复用 `sources`、`articles`、材料版本和 `analyses`；没有新增数据表、第二套内容存储或论文提取结构。
- 中文展示标题与一句说明保存在独立资讯分析中，原题仍在来源材料中，论文临床提取结果不变。
- 相同资料复用已有文章身份和版本；已有该版本的资讯分析不会再次调用模型。已有回执也按请求身份复用，不付费重试。
- 官方动态以“厂商题名信息”归属厂商。题名草稿以“题名介绍”标明范围，不能新增结果、样本数、结论或来源未点名的品牌。
- 当前每轮研究/官方来源分别最多保存 `--limit` 条候选，查询窗口只检查 PubMed 前 20 个返回结果，页面最多读取 100 条保存资讯。本轮默认 30 天、2 条，并非全量历史采集。
- 仅有题名的资料不能完成临床结果提取；官方 RSS 也不保证近期有 VARIPULSE 项目。新闻无明确标识引用时不猜测论文关联。
- 供应商 token usage 可用于按已核实价格估算；未提供账单扣费金额时记录 `actualDeduction=null`，不把估算说成实际扣款。
- 本轮不启用定时任务、推送、公开部署或自动扩展来源。

本轮运行证据保存在忽略目录 `.data/ep-pr2b/private-news-20261001-609052587/`。其中每轮的 `discovery.json`、`plan.json`、`summary.json` 和 `saved-feed.json` 分别对应来源发现、调用边界、执行统计及页面读取记录；执行模型后才会出现真实 `execution-*.json`。截图、保存检查和测试日志在同目录。密钥与 `.data` 不提交。
