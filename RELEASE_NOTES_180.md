# Apex Agent v1.8.0 Release Notes

## 🎯 New Features

### Extension Error Capture for AI Debugging
AI assistants (Claude, Cursor, etc.) can now detect and analyze extension errors directly through MCP tools:

- **`capture_extension_errors`** - Opens an extension page and captures all JavaScript errors via Chrome DevTools Protocol
  - Returns structured error data with full stack traces
  - Includes line numbers and source file locations
  - Captures console errors and warnings

- **`analyze_extension`** - Comprehensive extension health analysis
  - Checks popup and options pages for errors
  - Provides AI-friendly fix suggestions based on error patterns
  - Health assessment: healthy, minor_issues, or needs_attention
  - Actionable next steps for debugging

- **`get_extension_console`** - Retrieve captured console logs
  - Filter by log level (error, warning, log, info)
  - Includes timestamps and source locations

- **`clear_extension_errors`** - Clear captured error data

### Connection Stability Improvements
- More aggressive keepalive ping (10 seconds instead of 30)
- Smarter reconnection detection during keepalive checks
- Auto-connect on service worker startup
- Improved alarm-based reconnection (every 15 seconds)

### CSP Compliance
- Fixed Content Security Policy violations
- Script execution now uses `chrome.scripting.executeScript` with proper worlds
- All inline scripts moved to external files

## 🔧 Technical Changes

- Updated `browser_evaluate`, `browser_execute_safe`, and `browser_execute_on_element` to use Chrome's scripting API
- Added `world: 'MAIN'` and `world: 'ISOLATED'` execution contexts
- Extension error store for persistent error tracking across sessions

## 📦 Files Changed
- `extension/manifest.json` - Version bump to 1.8.0
- `extension/background.js` - Error capture functions, connection improvements
- `mcp-server/index.js` - New MCP tools for error capture
- `README.md` - Version badge update

## 🚀 Usage Example

```
// In Cursor/Claude, ask:
"Analyze the extension with ID abc123def for errors"

// The AI will call:
analyze_extension({ extensionId: "abc123def" })

// Returns:
{
  "health": "needs_attention",
  "analysis": {
    "totalErrors": 2,
    "errors": [
      {
        "message": "Cannot read property 'value' of null",
        "url": "chrome-extension://abc123def/popup.js",
        "lineNumber": 42,
        "stackTrace": [...]
      }
    ],
    "suggestions": [
      {
        "error": "Cannot read property 'value' of null",
        "suggestion": "Object is null/undefined before property access. Use optional chaining (?.) or check existence.",
        "location": "popup.js:42"
      }
    ]
  },
  "nextSteps": [
    "Review the errors and their stack traces above",
    "Check the file locations mentioned in the errors",
    "Apply the suggested fixes",
    "Reload the extension and run analyze_extension again"
  ]
}
```

## 🔐 Privacy
No changes to data handling. All error capture happens locally and data is not transmitted externally.

