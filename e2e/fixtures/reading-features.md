# 实时语音推理：一份速读

## 一句话结论

在 Trainium 上做实时语音，瓶颈不在模型主干，而在最后一步的波形还原；先量首段延迟，再谈吞吐。

## TTS 为什么慢

先说几个容易误标的词：SMS 和 TTSX 不是术语，`TTS` 在代码里不标，[TTS 文档](https://example.com/tts) 是链接也不标。

一个实时 TTS 系统先用 backbone 生成语音 token，再由 codec 把 token 还原成波形。VoxServe 的测量里，flow matching 占了 codec 九成以上的时间。用户最在意的是 TTFA：从发请求到听到第一声。第二次出现的 TTS 和 codec 不再加下划线。

## 图表

**每月请求量：柱状图加折线图**

```mermaid
xychart-beta
  title "每月请求量（万次）"
  x-axis ["7月", "8月", "9月", "10月", "11月"]
  y-axis "请求量" 0 --> 120
  bar [32, 45, 61, 78, 104]
  line [30, 41, 57, 74, 98]
```

**一次请求的耗时构成：饼图**

```mermaid
pie title 一次请求的耗时
  "波形还原" : 62
  "模型主干" : 23
  "网络" : 10
  "其他" : 5
```

**先做哪件事：象限图**

```mermaid
quadrantChart
  title 投入与收益
  x-axis 投入小 --> 投入大
  y-axis 收益小 --> 收益大
  quadrant-1 值得规划
  quadrant-2 先做
  quadrant-3 暂缓
  quadrant-4 交给别人
  合并算子: [0.3, 0.85]
  换大模型: [0.8, 0.35]
  加缓存: [0.2, 0.55]
  重写调度: [0.72, 0.76]
```

**知识地图：思维导图**

```mermaid
mindmap
  root((实时语音))
    模型
      主干
      波形还原
    指标
      首段延迟
      吞吐
    硬件
      Trainium
      GPU
```

**计划：时间线**

```mermaid
timeline
  title 优化计划
  section 11 月
    测量 : 跑性能剖析
  section 12 月
    优化 : 合并算子 : 换声码器
  section 1 月
    上线 : 灰度 10%
```

**流量去向：桑基图**（mermaid 的桑基图只认英文节点名）

```mermaid
sankey-beta
Requests,Cache hit,35
Requests,Generated,65
Generated,OK,60
Generated,Timeout,5
```

## 怎么做

:::steps reveal 优化步骤
1. **测量**：在 Trn2 上跑性能剖析，记录每个模块的耗时。
2. **找瓶颈**：对比模型主干和波形还原的占比。
3. **改实现**：先合并转置卷积，再试更快的声码器。
4. **复测**：看首段延迟是否低于 200 ms。
:::

:::steps reveal
- [x] **11 月**：完成测量
- [ ] **12 月**：完成优化
- [ ] **1 月**：灰度上线
:::

## 术语表

- **TTS, Text-to-Speech（文本转语音）**：把文字变成声音。这里说的是实时 TTS，边说边出声。
- **backbone（骨干网络）**：语音模型里处理语义的主干部分。
- **codec（音频编解码器）**：把模型生成的语音 token 还原成波形的部分。
- **flow matching（流匹配）**：分多步"去噪"生成音频特征的方法，很耗算力。
- **TTFA, Time to First Audio（首段音频时间）**：从发请求到听到第一声的时间。
- **SM**：GPU 的计算单元。正文只在 SMS 里出现，所以不会被标出来。

## 要点回顾

- 实时语音的瓶颈在波形还原，不在模型主干。
- 先量首段延迟，再谈吞吐。
- 一次只改一处，每次都复测。
