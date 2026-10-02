# 字段合同

日期：2026-10-02。查询本体是迁移 `0039` 的研究表。`ep-abstract-extract-v4` 只作为草稿形状，保存在提取草稿的 JSON 里。本文件不新增迁移，也不改提示词。提示词要等金标之后再删字段，避免在召回出来之前再改一版 schema。

材料只允许两类：来源提供的摘要；文章自身标明 CC BY 4.0 的全文。其他全文不进入模型输入。

## v4 键可以写入哪里

自动写入不存在。下表是以后确定性映射的唯一允许方向。对不上的值保持草稿，不换算，不猜测枚举。

| v4 键 | 研究表 | 规则 |
|---|---|---|
| `overallSample` | 不写入 | 不进入 `ep_studies.reported_counts`，也不进入任何终点分母。 |
| `groups[].groupId` | `ep_research_arms.arm_key` | 只是本篇草稿里的局部编号，不能当作数据库主键。 |
| `groups[].groupLabel` | `ep_research_arms.label` | 须有引用。 |
| `groups[].researchSubjects` | 不写入 `population` | `population` 只能是 human、animal、bench、simulation、mixed、unknown。自由文本留在草稿。不能从文字猜枚举。 |
| `groups[].sample` | 当前不能整组写入 | 表上每个组别只有一组 `reported_n`、`n_unit`、`n_scope`。多条计数不能压成一条，也不能只取第一条。金标证明需要多条计数之前不加列。 |
| `groups[].productRoles` | `ep_context_products` | 只有人选定已存在的 `ep_products.id` 之后才写。不自动建产品。PFA、RF 这类技术名称不能当产品。 |
| `groups[].imagingMethods` | `ep_research_contexts.imaging` | 只有能逐字对应 ICE、TEE、TTE、OTHER 才写。自由文本不映射。 |
| `groups[].radiationStrategy` | `ep_research_contexts.radiation_strategy` | 只有能逐字对应 zero_fluoro、low_fluoro、unspecified 才写。策略不等于完成比例。 |
| `results[].kind=outcome` 的整数 `numerator` 与 `outcomeDenominator` | `ep_research_findings` | 须先有人指定的 `endpoint` slug、所属场景，以及 `numerator <= denominator`。百分比和小数留在 `resultValue`，不反算成分子分母。 |
| `results[].resultValue`、`unit`、`statistic` | 不写入数值列 | 表上没有比率、置信区间或统计量列。 |
| `results[].kind=duration` | 不写入随访 | 操作时长不是 `time_role=follow_up`。 |
| `comparisons` | 不写入 | 相邻数字不构成比较。 |
| `proceduralContexts` | 不写入 | 流程阶段不是终点。 |
| `observationTimes` | `ep_research_findings` 的时间列 | 单位只接受 day、week、month、year 中表已有的对应项。分钟和小时不换算。日不换算成月。起止不同的区间不折成一个时间点。`time_basis` 不能从自由文本推断，未说明就是 unknown。 |

`source_locator` 必须指向本次材料包里的片段。模型没给引用的值不能入库。

## 阅读与公开是两道门

阅读允许：人把该字段标为已核对。公开发布：记录 `publication_state=published`，字段 `public_allowed` 为真，且权利依据未过期。公开读取只走 `publication/research.ts` 和四个白名单视图。

当前阅读页仍直接读预览适配器，不读这张表。这是阶段 5 要收口的缺口，不是本文件已经完成的状态。

## 金标之前页面上的数字

组别计数和终点如果只存在于 v4 草稿，页面必须仍能看出它们未经人审核。本文件不把任何现有草稿改成已核对。
