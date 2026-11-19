# XSS probe

</script><script>window.__xss = 'script'</script>

<img src="x" onerror="window.__xss = 'img'">

[click](javascript:window.__xss='link')

<svg onload="window.__xss='svg'"></svg>

<iframe src="javascript:window.__xss='iframe'"></iframe>

TEXT-AFTER-PROBE
