---
This document starts with a horizontal rule, not frontmatter.

# Edge cases that must render as plain Markdown

A sentence with **bold in the middle** stays a sentence.

**This bold line is deliberately much longer than forty characters so it stays a paragraph**

1. Plain first item
2. **Bold** second item

- not a key point
- **Bold** without a colon

> Just a normal quote, not a callout.

:::unknownblock
This block name is not supported and must show as text.
:::

## First section

Text.

## Second section

## Summary

This summary heading is deep in the document, so it is not turned into a card.

Price is $5 == $5 and a==b stays text. A single = sign.

===CHAT===

A line of equals signs like the one above stays text.
