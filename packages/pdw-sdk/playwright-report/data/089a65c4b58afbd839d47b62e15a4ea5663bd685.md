# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - heading "SimplePDWClient E2E Test" [level=1] [ref=e2]
  - generic [ref=e3]: Tests failed - see log
  - generic [ref=e5]:
    - strong [ref=e6]: "initialization:"
    - text: "FAIL - Failed to fetch dynamically imported module: http://localhost:3456/dist-browser/pdw-sdk.browser.js"
  - heading "Log:" [level=3] [ref=e7]
  - generic [ref=e8]: "[2025-12-09T04:18:40.417Z] Starting E2E tests... [2025-12-09T04:18:40.823Z] ERROR: Failed to fetch dynamically imported module: http://localhost:3456/dist-browser/pdw-sdk.browser.js"
```