Vendored, unmodified browser builds (same-origin so pages don't depend on third-party CDNs):

- marked-12.0.2.min.js — npm `marked@12.0.2` (`marked.min.js`), MIT
- purify-3.4.18.min.js — npm `dompurify@3.4.18` (`dist/purify.min.js`), Apache-2.0 / MPL-2.0
- highlight-11.9.0.min.js — npm `@highlightjs/cdn-assets@11.9.0` (`highlight.min.js`), BSD-3-Clause

Mermaid is still loaded from jsDelivr, and only when a document contains a mermaid block.
