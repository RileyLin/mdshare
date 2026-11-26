# KV cache: why time to first token drops

## TL;DR

The KV cache stores the attention keys and values already computed, so the next token doesn't recompute the whole context. The higher the cache hit rate, the lower the time to first token.

## What it solves

- **Repeated work**: without a cache, every new token runs attention over all previous tokens again.
- **Long contexts**: the longer the context, the more a recompute costs; with a cache each step only pays for the new token.
- **Multi-turn chats**: the same system prompt is reused across requests; a prefix-cache hit skips the prefill.

## An example

| Case | Prefill tokens | Cache hits | Time to first token |
|---|---:|---:|---:|
| Cold start | 8,000 | 0 | 1.9 s |
| Same prefix again | 8,000 | 7,600 | 0.3 s |

## The cost

The cache uses GPU memory: per token roughly `2 × layers × hidden size × bytes`. When memory runs out, you evict or shorten the context.
