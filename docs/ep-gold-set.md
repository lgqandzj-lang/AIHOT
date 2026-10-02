# VARIPULSE 计数

日期：2026-10-02。名单在 `docs/gold/varipulse-candidates.json`。

PubMed 题名检索 `VARIPULSE[Title]` 返回 15 条。13 条是电生理研究。PMID `3736805` 是 1986 年的二氧化碳激光，PMID `39702987` 是勘误，这两条排除。

计数只从 PubMed 摘要里抄写明的整数，并保留那一句原文。摘要没给本篇入组人数的，计数留空。百分比不反算。别的研究里的数字、手术时间、成功率和并发症不写入。

```powershell
node scripts/ep-gold-set.ts
```
