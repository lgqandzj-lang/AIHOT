# VARIPULSE 计数

日期：2026-10-02。名单在 `docs/gold/varipulse-candidates.json`。

PubMed 检索 `VARIPULSE[Title/Abstract]` 返回 65 条。题名点名的 13 篇电生理研究仍然在内。摘要点名、但题名没有写出 VARIPULSE 的，又收了 39 篇。PMID `3736805` 是 1986 年的二氧化碳激光，PMID `39702987` 是勘误，这两条排除。没有在摘要里写出 VARIPULSE 的不收。

计数只从 PubMed 摘要里抄写明的整数，并保留那一句原文。摘要没给本篇入组人数的，计数留空。百分比不反算。别的研究里的数字、手术时间、成功率和并发症不写入。

人数写入研究库 `ep_research_records` 和 `ep_research_arms`，不公开。原句留在组别的私有依据里。页面在设置了 `EP_CATALOG_DATABASE_URL` 时读这张库，否则读这份 JSON。

```powershell
$env:DATABASE_URL = 'postgres://ep_pr1@127.0.0.1:55433/ep_gold_catalog_test'
node scripts/migrate.ts
node scripts/ep-gold-import.ts
```

```powershell
node scripts/ep-gold-set.ts
```
