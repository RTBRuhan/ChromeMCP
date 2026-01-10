# Privacy Policy for Apex Agent

**Last Updated: January 10, 2026**

## Overview

Apex Agent is a browser extension that enables AI assistants to interact with your browser through the Model Context Protocol (MCP). This privacy policy explains how the extension handles your data.

## Data Collection

### What We DO NOT Collect

Apex Agent does **NOT**:
- Collect any personal information
- Track your browsing history
- Send any data to external servers owned by us
- Use cookies for tracking
- Store any data on remote servers
- Share any information with third parties

### What the Extension Stores Locally

The extension stores the following data **only on your local device** using Chrome's storage API:

1. **User Preferences**: Your settings for the extension (e.g., recording options, agent permissions, visual feedback preferences)
2. **Connection Settings**: MCP server host and port configuration
3. **AI API Keys** (if you use the AI Sidebar feature): Stored locally and only used to communicate directly with the AI provider you choose (OpenAI, Anthropic, Google, or OpenRouter)
4. **Recording Logs**: When you use the recording feature, interaction logs are stored temporarily in local storage

## Data Transmission

### MCP Server Communication

When connected to an MCP server:
- Communication happens **only on your local network** (localhost by default)
- The extension communicates with the MCP server running on your own computer
- No data is sent to any external servers

### AI Sidebar (Optional Feature)

If you enable the AI Sidebar feature and provide an API key:
- Your API key is stored locally in Chrome's storage
- When you send a message, it is sent directly to the AI provider you selected
- The extension does not intercept, store, or process your conversations beyond what's necessary for display
- You are subject to the privacy policy of the AI provider you choose to use

## Permissions Explained

The extension requests the following permissions:

| Permission | Why We Need It |
|------------|----------------|
| `activeTab` | To interact with the current tab when you trigger actions |
| `tabs` | To navigate, create, and manage browser tabs |
| `scripting` | To inject scripts for browser automation |
| `storage` | To save your preferences locally |
| `webNavigation` | To track page navigation for recording features |
| `management` | To list and manage browser extensions for debugging |
| `debugger` | To access Chrome DevTools Protocol for advanced debugging |
| `sidePanel` | To display the AI assistant sidebar |
| `host_permissions: <all_urls>` | To work on any website you choose to automate |

## Security

- All data is stored locally on your device
- API keys are never exposed to websites or third parties
- The extension does not have a backend server
- All automation happens within your browser instance

## Open Source

Apex Agent is open source. You can review the complete source code at:
https://github.com/RTBRuhan/ApexAgent

## Children's Privacy

This extension is not directed at children under 13. We do not knowingly collect information from children.

## Changes to This Policy

We may update this privacy policy from time to time. Any changes will be reflected in the "Last Updated" date above and in the GitHub repository.

## Contact

If you have questions about this privacy policy, please:
- Open an issue on [GitHub](https://github.com/RTBRuhan/ApexAgent/issues)
- Contact the author at [rtbruhan.github.io](https://rtbruhan.github.io)

---

## Summary

**TL;DR**: Apex Agent stores all your data locally on your device. We don't collect, track, or share any of your information. The extension is open source so you can verify this yourself.

