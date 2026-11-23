# 训练方式怎么选

## 五种做法

先说结论：大多数客户不需要训练。下面这张表把五种做法放在一起比较，方便你判断什么时候值得训练。

| 类型 | 白话解释 | 什么时候适合 | 主要客户 | 谁来做 | 厂商怎么赚钱 | 先例 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 不训练 | 只改提示词、加检索、接工具 | 大部分问题 | 所有客户 | 客户自己，我们给方法 | 调用量 | 多数场景不需要训练 |
| 1 轻量微调 | SFT（监督微调，模仿示范答案）或 LoRA（只训练少量新增参数），学格式、风格、领域说法 | 有几百到几千条好示范 | S3、S5 | 客户自助，在训练平台上做 | 衍生模型的推理量 | 训练平台的自助产品 |
| 2 蒸馏 | 用大模型的输出训练一个小模型，专做一件事 | 一个固定任务、调用量很大、要省钱 | S3、S6 | 客户 + 训练平台 | 蒸馏阶段的大模型调用 + 授权 | 后训练能把推理成本降很多 |
| 3 强化学习 | 让模型反复尝试、按得分调整，学会把任务做完 | 有可验证的结果，比如测试通过 | S1、S2 | 客户 + 我们的研究员 | 授权 + 分成 + 推理量 | 编程助手用开源模型做强化学习 |
| 4 从头训练 | 自己训练一个基础模型 | 几乎没有 | 极少数 | 不建议 | 无 | 无 |

## 其他表格

小表格保持原样：

| 指标 | 数值 | 变化 |
| --- | --- | --- |
| 活跃用户 | 12,400 | +8% |
| 留存 | 61% | +3% |

很宽的数据表在页面里横向滚动，第一列固定：

| Region | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep | Oct | Nov |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| North America West Coast | 1,204 | 1,310 | 1,422 | 1,518 | 1,640 | 1,702 | 1,815 | 1,930 | 2,044 | 2,160 | 2,275 |
| Europe Central | 804 | 812 | 845 | 901 | 950 | 1,002 | 1,066 | 1,120 | 1,188 | 1,240 | 1,301 |
| Asia Pacific | 640 | 655 | 702 | 744 | 790 | 845 | 900 | 962 | 1,010 | 1,075 | 1,130 |

## 作者指定的视图

:::table cards compact 训练方式速查
| 方式 | 数据要求 | 成本 | 一句话 |
| --- | --- | --- | --- |
| 提示词 | 无 | 最低 | 先试这个 |
| 微调 | 几百到几千条示范 | 中 | 学格式和风格 |
| 强化学习 | 可验证的评分 | 高 | 学会把事做完 |
:::

:::compare
### 方案 A
| 项目 | 说明 |
| --- | --- |
| 速度 | 快 |
### 方案 B
| 项目 | 说明 |
| --- | --- |
| 速度 | 慢 |
:::

## 矩阵和格式

| Feature | Model A | Model B | Model C | Model D |
| --- | --- | --- | --- | --- |
| Disaggregated prefill and decode | tested (one prefill server feeding two decode servers for the small model and four for the large one) | tested | refused | tested (one prefill server feeding five decode servers, measured on the eight-chip node) |
| Expert parallelism | tested | refused (this model has no experts, so the flag is rejected at startup) | tested | refused |
| Async scheduling | tested | tested | tested | refused |
| Speculative decoding | refused | tested (a small draft model proposing two tokens ahead on every step) | refused | tested |

:::table cards
| Candidate | Anxiety amplification risk level for this family of products | Evidence |
| --- | --- | --- |
| Family agent | Low | *Relieves* rather than reflects anxiety; [survey](https://example.com/survey) |
| Scam check | Moderate | **Strong** primary source and `public data` |
:::
