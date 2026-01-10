// Apex Agent - Background Service Worker
// Handles communication between popup, content scripts, and MCP server

// State
let mcpServerRunning = false;
let mcpPort = 3052;
let mcpHost = 'localhost';
let agentEnabled = true;
let agentPermissions = {
  mouse: true,
  keyboard: true,
  navigation: true,
  scripts: true,
  screenshot: true,
  showCursor: true,
  highlightTarget: true,
  showTooltips: true
};
let mcpWebSocket = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let shouldReconnect = false;
let messageQueue = [];
let isProcessingMessages = false;

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 3000;

// Extension error monitoring storage
let extensionErrorStore = new Map(); // extensionId -> { errors: [], console: [], monitored: boolean }

// ============ BADGE STATUS ============
function updateBadge(connected, reconnecting = false) {
  if (connected) {
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' }); // Green
    chrome.action.setTitle({ title: 'Apex Agent - Connected' });
  } else if (reconnecting) {
    chrome.action.setBadgeText({ text: '◐' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }); // Orange
    chrome.action.setTitle({ title: 'Apex Agent - Reconnecting...' });
  } else {
    chrome.action.setBadgeText({ text: '○' });
    chrome.action.setBadgeBackgroundColor({ color: '#666666' }); // Gray
    chrome.action.setTitle({ title: 'Apex Agent - Disconnected' });
  }
}

// Initialize
chrome.runtime.onInstalled.addListener(() => {
  console.log('Apex Agent installed');
  updateBadge(false);
  
  chrome.storage.local.set({
    isRecording: false,
    recordLog: [],
    mcpPort: 3052,
    mcpHost: 'localhost',
    agentEnabled: true,
    autoReconnect: true
  });
});

// Set initial badge state
updateBadge(false);

// Auto-connect on service worker startup
(async () => {
  try {
    const stored = await chrome.storage.local.get(['mcpPort', 'mcpHost', 'autoReconnect']);
    if (stored.autoReconnect !== false) {
      shouldReconnect = true;
      console.log('Auto-connecting to MCP server...');
      setTimeout(() => {
        startMCPServer(stored.mcpPort || 3052, stored.mcpHost || 'localhost');
      }, 1000); // Small delay to let service worker fully initialize
    }
  } catch (e) {
    console.log('Auto-connect error:', e);
  }
})();

// ============ MESSAGE HANDLER ============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'SIDEBAR_TOOL_CALL':
      // Handle tool calls from the AI sidebar
      return await executeToolCall(message.tool, message.params);
    
    case 'OPEN_SIDEBAR':
      // Open the side panel
      try {
        await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id });
        return { success: true };
      } catch (e) {
        return { error: e.message };
      }
    
    case 'GET_MCP_STATUS':
      return { connected: mcpServerRunning, reconnecting: reconnectTimer !== null };
    
    case 'START_MCP_SERVER':
      shouldReconnect = true;
      reconnectAttempts = 0;
      return await startMCPServer(message.port, message.host);
    
    case 'STOP_MCP_SERVER':
      shouldReconnect = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      return await stopMCPServer();
    
    case 'SET_AGENT_ENABLED':
      agentEnabled = message.enabled;
      agentPermissions = message.permissions || {};
      return { success: true };
    
    case 'GET_AGENT_STATUS':
      return { enabled: agentEnabled, permissions: agentPermissions };
    
    case 'LOG_ENTRY':
      chrome.runtime.sendMessage({ type: 'LOG_ENTRY', entry: message.entry }).catch(() => {});
      return { success: true };
    
    case 'GET_ACTIVE_TAB':
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab;
    
    case 'NAVIGATE':
      return await navigateTab(message.url, message.tabId);
    
    case 'TAKE_SCREENSHOT':
      return await takeScreenshot(message.options);
    
    case 'EXECUTE_SCRIPT':
      return await executeScript(message.tabId, message.script);
    
    case 'GET_TAB_INFO':
      return await getTabInfo(message.tabId);
    
    case 'AGENT_ACTION':
      return await forwardAgentAction(message.action, message.tabId);
    
    default:
      return { error: 'Unknown message type' };
  }
}

// ============ MCP SERVER CONNECTION ============
async function startMCPServer(port, host) {
  try {
    mcpPort = port || 3052;
    mcpHost = host || 'localhost';
    
    // Clear any existing reconnect timer
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    
    return new Promise((resolve) => {
      try {
        mcpWebSocket = new WebSocket(`ws://${mcpHost}:${mcpPort}`);
      } catch (e) {
        updateBadge(false);
        resolve({ success: false, error: 'Invalid WebSocket URL' });
        return;
      }
      
      mcpWebSocket.onopen = () => {
        mcpServerRunning = true;
        reconnectAttempts = 0;
        updateBadge(true);
        console.log(`Connected to MCP server on ${mcpHost}:${mcpPort}`);
        
        mcpWebSocket.send(JSON.stringify({
          type: 'register',
          client: 'apex-agent'
        }));
        
        // Start keepalive ping
        startKeepalive();
        
        resolve({ success: true, port: mcpPort, host: mcpHost });
      };
      
      mcpWebSocket.onerror = (error) => {
        console.error('MCP WebSocket error:', error);
        mcpServerRunning = false;
        updateBadge(false);
        resolve({ success: false, error: 'Failed to connect. Make sure MCP server is running.' });
      };
      
      mcpWebSocket.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        mcpServerRunning = false;
        stopKeepalive();
        
        // Auto-reconnect if enabled
        if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          updateBadge(false, true);
          console.log(`Reconnecting... attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
          
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            startMCPServer(mcpPort, mcpHost);
          }, RECONNECT_DELAY);
        } else {
          updateBadge(false);
        }
        
        chrome.runtime.sendMessage({ type: 'MCP_STATUS_CHANGED', connected: false }).catch(() => {});
      };
      
      mcpWebSocket.onmessage = (event) => {
        try {
          handleMCPMessage(JSON.parse(event.data));
        } catch (e) {
          console.error('Failed to parse MCP message:', e);
        }
      };
      
      setTimeout(() => {
        if (!mcpServerRunning && mcpWebSocket?.readyState === WebSocket.CONNECTING) {
          mcpWebSocket.close();
          updateBadge(false);
          resolve({ success: false, error: 'Connection timeout.' });
        }
      }, 5000);
    });
  } catch (error) {
    updateBadge(false);
    return { success: false, error: error.message };
  }
}

// Keepalive ping to prevent disconnection
let keepaliveInterval = null;

function startKeepalive() {
  stopKeepalive();
  // Ping every 10 seconds to prevent Chrome service worker suspension
  keepaliveInterval = setInterval(() => {
    if (mcpWebSocket && mcpWebSocket.readyState === WebSocket.OPEN) {
      mcpWebSocket.send(JSON.stringify({ type: 'ping' }));
    } else if (shouldReconnect && !reconnectTimer) {
      // Connection lost without triggering onclose - try to reconnect
      console.log('WebSocket not open, triggering reconnect...');
      mcpServerRunning = false;
      updateBadge(false, true);
      startMCPServer(mcpPort, mcpHost);
    }
  }, 10000); // Ping every 10 seconds
}

function stopKeepalive() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

async function stopMCPServer() {
  stopKeepalive();
  if (mcpWebSocket) {
    mcpWebSocket.close();
    mcpWebSocket = null;
  }
  mcpServerRunning = false;
  updateBadge(false);
  return { success: true };
}

async function handleMCPMessage(message) {
  console.log('MCP message:', message.type, message.id);
  
  if (message.type === 'pong') {
    return; // Keepalive response
  }
  
  if (message.type === 'registered') {
    console.log('Registered with MCP server');
    return;
  }
  
  if (message.type === 'tool_call') {
    // Queue the message for processing
    messageQueue.push(message);
    processMessageQueue();
  }
}

async function processMessageQueue() {
  if (isProcessingMessages || messageQueue.length === 0) return;
  
  isProcessingMessages = true;
  
  while (messageQueue.length > 0) {
    const message = messageQueue.shift();
    
    let result;
    try {
      console.log(`Processing tool: ${message.tool} (id=${message.id})`);
      result = await executeToolCall(message.tool, message.params);
    } catch (error) {
      console.error('Tool execution error:', error);
      result = { error: error.message };
    }
    
    // Send result back
    try {
      if (mcpWebSocket && mcpWebSocket.readyState === WebSocket.OPEN) {
        mcpWebSocket.send(JSON.stringify({
          type: 'tool_result',
          id: message.id,
          result
        }));
        console.log(`Sent result for tool: ${message.tool} (id=${message.id})`);
      } else {
        console.error('Cannot send result - WebSocket not open');
      }
    } catch (sendError) {
      console.error('Failed to send tool result:', sendError);
    }
  }
  
  isProcessingMessages = false;
}

async function executeToolCall(tool, params) {
  // Extension management tools don't require agent to be enabled
  const noAgentRequired = [
    'browser_snapshot', 'get_page_info', 
    'list_extensions', 'reload_extension', 'get_extension_info', 
    'enable_extension', 'disable_extension',
    'open_extension_popup', 'open_extension_options', 'open_extension_devtools',
    'open_extension_errors', 'trigger_extension_action', 'get_extension_popup_content', 
    'interact_with_extension', 'close_tab', 'cdp_attach', 'cdp_detach', 'cdp_command'
  ];
  
  if (!agentEnabled && !noAgentRequired.includes(tool)) {
    return { error: 'Agent control is disabled' };
  }
  
  // Tools that manage their own tabs or don't need one
  const noTabRequired = [
    'list_extensions', 'reload_extension', 'get_extension_info',
    'enable_extension', 'disable_extension',
    'open_extension_popup', 'open_extension_options', 'open_extension_devtools',
    'open_extension_errors', 'trigger_extension_action', 'get_extension_popup_content', 
    'interact_with_extension', 'close_tab'
  ];
  
  let tab = null;
  if (!noTabRequired.includes(tool)) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) {
      return { error: 'No active tab' };
    }
    tab = activeTab;
  }
  
  try {
    switch (tool) {
      case 'browser_navigate':
        return await navigateTab(params.url);
      
      case 'browser_click':
        return await forwardAgentAction({
          type: 'CLICK',
          selector: params.selector || params.ref,
          options: params
        });
      
      case 'browser_type':
        return await forwardAgentAction({
          type: 'TYPE',
          selector: params.selector || params.ref,
          text: params.text,
          options: params
        });
      
      case 'browser_scroll':
        return await forwardAgentAction({
          type: 'SCROLL',
          selector: params.selector || 'window',
          options: params
        });
      
      case 'browser_hover':
        return await forwardAgentAction({
          type: 'HOVER',
          selector: params.selector || params.ref
        });
      
      case 'browser_press_key':
        return await forwardAgentAction({
          type: 'PRESS_KEY',
          key: params.key,
          options: {
            selector: params.selector || params.ref,
            modifiers: params.modifiers || [],
            repeat: params.repeat || 1,
            delay: params.delay || 50
          }
        });
      
      case 'browser_snapshot':
        return await forwardAgentAction({ type: 'GET_SNAPSHOT' });
      
      case 'browser_evaluate':
        // Use chrome.scripting.executeScript to bypass CSP restrictions
        try {
          const code = params.script || params.code;
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN', // Execute in page context
            func: (codeToRun) => {
              try {
                // eslint-disable-next-line no-eval
                return { success: true, result: eval(codeToRun) };
              } catch (e) {
                return { error: e.message };
              }
            },
            args: [code]
          });
          return results[0]?.result || { error: 'No result' };
        } catch (e) {
          return { error: e.message };
        }
      
      case 'browser_wait':
        return await forwardAgentAction({
          type: 'WAIT',
          condition: params,
          timeout: params.timeout
        });
      
      case 'browser_screenshot':
        return await takeScreenshot(params);
      
      case 'get_page_info':
        return await forwardAgentAction({ type: 'GET_PAGE_STATE' });
      
      case 'get_element_info':
        return await chrome.tabs.sendMessage(tab.id, {
          type: 'GET_ELEMENT_INFO',
          selector: params.selector
        });
      
      // ===== DEVTOOLS INSPECTION TOOLS =====
      case 'inspect_element':
        return await forwardAgentAction({
          type: 'INSPECT_ELEMENT',
          selector: params.selector
        });
      
      case 'get_dom_tree':
        return await forwardAgentAction({
          type: 'GET_DOM_TREE',
          selector: params.selector || null,
          depth: params.depth || 3
        });
      
      case 'get_computed_styles':
        return await forwardAgentAction({
          type: 'GET_COMPUTED_STYLES',
          selector: params.selector,
          properties: params.properties || null
        });
      
      case 'get_element_html':
        return await forwardAgentAction({
          type: 'GET_ELEMENT_HTML',
          selector: params.selector,
          outer: params.outer !== false
        });
      
      case 'query_all':
        return await forwardAgentAction({
          type: 'QUERY_ALL',
          selector: params.selector,
          limit: params.limit || 20
        });
      
      case 'get_console_logs':
        return await forwardAgentAction({ type: 'GET_CONSOLE_LOGS' });
      
      case 'get_network_info':
        return await forwardAgentAction({ type: 'GET_NETWORK_INFO' });
      
      case 'get_storage':
        return await forwardAgentAction({
          type: 'GET_STORAGE',
          storageType: params.type || 'local'
        });
      
      case 'get_cookies':
        return await forwardAgentAction({ type: 'GET_COOKIES' });
      
      case 'get_page_metrics':
        return await forwardAgentAction({ type: 'GET_PAGE_METRICS' });
      
      case 'find_by_text':
        return await forwardAgentAction({
          type: 'FIND_BY_TEXT',
          text: params.text,
          tag: params.tag || null
        });
      
      case 'browser_click_by_text':
        return await forwardAgentAction({
          type: 'CLICK_BY_TEXT',
          text: params.text,
          options: {
            tag: params.tag,
            exact: params.exact || false,
            index: params.index || 0
          }
        });
      
      case 'browser_wait_for_element':
        return await forwardAgentAction({
          type: 'WAIT_FOR_ELEMENT',
          selector: params.selector,
          options: {
            timeout: params.timeout || 10000,
            visible: params.visible !== false
          }
        });
      
      case 'browser_execute_safe':
        // Execute in content script's isolated world (CSP-safe)
        try {
          const code = params.code || params.script;
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'ISOLATED', // Content script context
            func: (codeToRun) => {
              try {
                // Using Function constructor in isolated world
                const fn = new Function(codeToRun);
                return { success: true, result: fn() };
              } catch (e) {
                return { error: e.message };
              }
            },
            args: [code]
          });
          return results[0]?.result || { error: 'No result' };
        } catch (e) {
          return { error: e.message };
        }
      
      case 'browser_execute_on_element':
        // Execute code with element reference
        try {
          const code = params.code || params.script;
          const selector = params.selector;
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN', // Page context for full DOM access
            func: (sel, codeToRun) => {
              try {
                const element = document.querySelector(sel);
                if (!element) return { error: `Element not found: ${sel}` };
                // Execute code with element in scope
                const fn = new Function('element', codeToRun);
                return { success: true, result: fn(element) };
              } catch (e) {
                return { error: e.message };
              }
            },
            args: [selector, code]
          });
          return results[0]?.result || { error: 'No result' };
        } catch (e) {
          return { error: e.message };
        }
      
      case 'get_attributes':
        return await forwardAgentAction({
          type: 'GET_ATTRIBUTES',
          selector: params.selector
        });
      
      // ===== EXTENSION MANAGEMENT TOOLS =====
      case 'list_extensions':
        return await listExtensions(params.includeDisabled);
      
      case 'reload_extension':
        return await reloadExtension(params.extensionId);
      
      case 'get_extension_info':
        return await getExtensionInfo(params.extensionId);
      
      case 'enable_extension':
        return await setExtensionEnabled(params.extensionId, true);
      
      case 'disable_extension':
        return await setExtensionEnabled(params.extensionId, false);
      
      // ===== EXTENSION POPUP INTERACTION =====
      case 'open_extension_popup':
        return await openExtensionPopup(params.extensionId, params);
      
      case 'open_extension_options':
        return await openExtensionOptionsPage(params.extensionId);
      
      case 'open_extension_devtools':
        return await openExtensionDevTools(params.extensionId);
      
      case 'open_extension_errors':
        return await openExtensionErrors(params.extensionId);
      
      case 'trigger_extension_action':
        return await triggerExtensionAction(params.extensionId);
      
      // ===== EXTENSION ERROR CAPTURE (for AI debugging) =====
      case 'capture_extension_errors':
        // Open extension page and capture all errors via CDP
        return await captureExtensionErrors(params.extensionId, params);
      
      case 'get_extension_console':
        // Get captured console logs from an extension
        return await getExtensionConsole(params.extensionId, params);
      
      case 'analyze_extension':
        // Comprehensive analysis: info + errors + console + source hints
        return await analyzeExtension(params.extensionId);
      
      case 'clear_extension_errors':
        // Clear captured errors for an extension
        extensionErrorStore.delete(params.extensionId);
        return { success: true, message: `Cleared errors for ${params.extensionId}` };
      
      // ===== FAST EXTENSION DEBUGGING TOOLS =====
      case 'quick_test_extension':
        return await quickTestExtension(params.extensionId, params.actions);
      
      case 'get_extension_storage':
        return await getExtensionStorage(params.extensionId, params.storageArea);
      
      case 'extension_health_check':
        return await extensionHealthCheck(params.onlyWithErrors);
      
      case 'watch_extension':
        return await watchExtension(params.extensionId, params.pages);
      
      case 'get_extension_manifest':
        return await getExtensionManifest(params.extensionId);
      
      case 'compare_extension_state':
        return await compareExtensionState(params.extensionId, params.action);
      
      case 'inject_debug_helper':
        return await injectDebugHelper(params.extensionId, params.tabId);
      
      case 'get_all_extension_errors':
        return getAllExtensionErrors();
      
      case 'read_extension_file':
        return await readExtensionFile(params.extensionId, params.filePath);
      
      case 'list_extension_files':
        return await listExtensionFiles(params.extensionId, params.directory);
      
      case 'search_extension_code':
        return await searchExtensionCode(params.extensionId, params.query, params.fileTypes);
      
      case 'fix_extension_error':
        return await suggestErrorFix(params.extensionId, params.errorMessage);
      
      case 'get_extension_popup_content':
        return await getExtensionPopupContent(params.extensionId, params);
      
      case 'interact_with_extension':
        return await interactWithExtensionPopup(params.extensionId, params.actions || []);
      
      case 'close_tab':
        return await closeExtensionTab(params.tabId);
      
      // ===== CDP DEVTOOLS TOOLS =====
      case 'cdp_attach':
        return await attachDebugger(tab.id);
      
      case 'cdp_detach':
        return await detachDebugger(tab.id);
      
      case 'cdp_command':
        return await sendCDPCommand(tab.id, params.method, params.params || {});
      
      case 'get_event_listeners':
        return await getEventListeners(tab.id, params.selector);
      
      case 'start_network_monitor':
        return await startNetworkMonitoring(tab.id);
      
      case 'get_network_requests':
        return await getNetworkRequests(tab.id);
      
      case 'start_cpu_profile':
        return await startCPUProfile(tab.id);
      
      case 'stop_cpu_profile':
        return await stopCPUProfile(tab.id);
      
      case 'take_heap_snapshot':
        return await takeHeapSnapshot(tab.id);
      
      case 'set_dom_breakpoint':
        return await setDOMBreakpoint(tab.id, params.selector, params.type || 'subtree-modified');
      
      case 'remove_dom_breakpoint':
        return await removeDOMBreakpoint(tab.id, params.selector, params.type || 'subtree-modified');
      
      case 'start_css_coverage':
        return await startCSSCoverage(tab.id);
      
      case 'stop_css_coverage':
        return await stopCSSCoverage(tab.id);
      
      case 'start_js_coverage':
        return await startJSCoverage(tab.id);
      
      case 'stop_js_coverage':
        return await stopJSCoverage(tab.id);
      
      case 'get_cdp_console_logs':
        return await getCDPConsoleLogs(tab.id);
      
      case 'get_performance_metrics':
        return await getPerformanceMetrics(tab.id);
      
      case 'get_accessibility_tree':
        return await getAccessibilityTree(tab.id, params.selector);
      
      case 'get_layer_tree':
        return await getLayerTree(tab.id);
      
      case 'get_animations':
        return await getAnimations(tab.id);
      
      default:
        return { error: `Unknown tool: ${tool}` };
    }
  } catch (error) {
    return { error: error.message };
  }
}

// ============ TAB OPERATIONS ============
async function navigateTab(url, tabId) {
  try {
    if (!agentPermissions.navigation && agentEnabled) {
      return { error: 'Navigation not permitted' };
    }
    
    let targetTabId;
    
    if (tabId) {
      await chrome.tabs.update(tabId, { url });
      targetTabId = tabId;
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.update(tab.id, { url });
        targetTabId = tab.id;
      } else {
        return { error: 'No active tab' };
      }
    }
    
    // Wait for page to fully load
    return new Promise(resolve => {
      let resolved = false;
      
      const listener = (updatedTabId, info) => {
        if (updatedTabId === targetTabId && info.status === 'complete' && !resolved) {
          resolved = true;
          chrome.tabs.onUpdated.removeListener(listener);
          // Small delay to ensure content script is injected
          setTimeout(() => resolve({ success: true, url }), 300);
        }
      };
      
      chrome.tabs.onUpdated.addListener(listener);
      
      // Timeout after 15 seconds
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.tabs.onUpdated.removeListener(listener);
          resolve({ success: true, url, note: 'Navigation initiated but load may be incomplete' });
        }
      }, 15000);
    });
  } catch (error) {
    return { error: error.message };
  }
}

async function takeScreenshot(options = {}) {
  try {
    if (!agentPermissions.screenshot && agentEnabled) {
      return { error: 'Screenshots not permitted' };
    }

    // Full page screenshot using CDP - captures entire scrollable page instantly
    if (options.fullPage) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return { error: 'No active tab' };

      // Ensure debugger is attached
      const attachRes = await attachDebugger(tab.id);
      if (attachRes.error && !attachRes.already) return attachRes;

      // Enable Page domain to get layout metrics
      await sendCDPCommand(tab.id, 'Page.enable');
      
      const layout = await sendCDPCommand(tab.id, 'Page.getLayoutMetrics');
      if (layout?.error) return { error: layout.error };

      const { contentSize } = layout;
      
      // Limit max dimensions to avoid memory issues (max 16384px)
      const maxDimension = 16384;
      const width = Math.min(contentSize.width, maxDimension);
      const height = Math.min(contentSize.height, maxDimension);
      
      // Capture the full content in one shot
      const result = await sendCDPCommand(tab.id, 'Page.captureScreenshot', {
        format: options.format === 'jpeg' ? 'jpeg' : 'png',
        quality: options.quality || 80,
        captureBeyondViewport: true,
        fromSurface: true,
        clip: {
          x: 0,
          y: 0,
          width: width,
          height: height,
          scale: 1
        }
      });

      if (result?.error) return { error: result.error };
      
      return { 
        success: true, 
        dataUrl: `data:image/${options.format || 'png'};base64,${result.data}`,
        dimensions: { width, height },
        fullPage: true
      };
    }
    
    // Standard viewport capture (fast for just what's visible)
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: options.format || 'png',
      quality: options.quality || 90
    });
    
    return { success: true, dataUrl };
  } catch (error) {
    return { error: error.message };
  }
}

async function executeScript(tabId, script) {
  try {
    if (!agentPermissions.scripts && agentEnabled) {
      return { error: 'Script execution not permitted' };
    }
    
    const targetTabId = tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (!targetTabId) return { error: 'No target tab' };
    
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      func: (code) => { try { return eval(code); } catch (e) { return { error: e.message }; } },
      args: [script]
    });
    
    return { success: true, result: results[0]?.result };
  } catch (error) {
    return { error: error.message };
  }
}

async function getTabInfo(tabId) {
  try {
    const targetTabId = tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (!targetTabId) return { error: 'No target tab' };
    
    const tab = await chrome.tabs.get(targetTabId);
    return { id: tab.id, url: tab.url, title: tab.title, active: tab.active, status: tab.status };
  } catch (error) {
    return { error: error.message };
  }
}

async function forwardAgentAction(action, tabId) {
  try {
    const targetTabId = tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (!targetTabId) return { error: 'No target tab' };
    
    // Check if tab exists and is accessible
    try {
      const tab = await chrome.tabs.get(targetTabId);
      // Skip chrome:// and edge:// URLs as content scripts don't run there
      if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://') || tab.url?.startsWith('about:')) {
        return { error: 'Cannot access browser internal pages. Navigate to a regular website first.' };
      }
    } catch (tabError) {
      return { error: `Tab not accessible: ${tabError.message}` };
    }
    
    // Send message with timeout (use resolve to avoid unhandled rejection)
    const result = await Promise.race([
      chrome.tabs.sendMessage(targetTabId, { type: 'AGENT_ACTION', action }).catch(e => ({ error: e.message })),
      new Promise((resolve) => setTimeout(() => resolve({ error: 'Content script timeout (10s)' }), 10000))
    ]);
    
    chrome.runtime.sendMessage({
      type: 'AGENT_ACTIVITY',
      action: { type: action.type, details: JSON.stringify(action).slice(0, 100) }
    }).catch(() => {});
    
    return result;
  } catch (error) {
    // More descriptive error for common issues
    if (error.message.includes('Receiving end does not exist') || error.message.includes('Could not establish connection')) {
      return { error: 'Content script not loaded. Try refreshing the page or navigate to a different website.' };
    }
    return { error: error.message };
  }
}

// ============ EXTENSION MANAGEMENT ============
async function listExtensions(includeDisabled = true) {
  try {
    const extensions = await chrome.management.getAll();
    const filtered = extensions.filter(ext => {
      // Exclude self
      if (ext.id === chrome.runtime.id) return false;
      // Filter by enabled state if requested
      if (!includeDisabled && !ext.enabled) return false;
      return true;
    });
    
    return filtered.map(ext => ({
      id: ext.id,
      name: ext.name,
      version: ext.version,
      enabled: ext.enabled,
      type: ext.type,
      description: ext.description?.slice(0, 100),
      hasErrors: ext.installType === 'development' // Dev extensions might have errors
    }));
  } catch (error) {
    return { error: error.message };
  }
}

async function reloadExtension(extensionId) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    // Special case: reload self
    if (extensionId === chrome.runtime.id || extensionId === 'self') {
      // Can't use management API on self, use runtime.reload
      chrome.runtime.reload();
      return { success: true, message: 'Self-reload triggered' };
    }
    
    // Get extension info first to check if it exists
    const extInfo = await chrome.management.get(extensionId);
    if (!extInfo) {
      return { error: `Extension ${extensionId} not found` };
    }
    
    // Toggle OFF then ON to force reload
    await chrome.management.setEnabled(extensionId, false);
    await new Promise(resolve => setTimeout(resolve, 100)); // Brief pause
    await chrome.management.setEnabled(extensionId, true);
    
    return { 
      success: true, 
      message: `Extension ${extInfo.name} (${extensionId}) reloaded`,
      extension: {
        id: extensionId,
        name: extInfo.name,
        enabled: true
      }
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function getExtensionInfo(extensionId) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    const ext = await chrome.management.get(extensionId);
    
    return {
      id: ext.id,
      name: ext.name,
      version: ext.version,
      description: ext.description,
      enabled: ext.enabled,
      type: ext.type,
      installType: ext.installType,
      mayDisable: ext.mayDisable,
      permissions: ext.permissions,
      hostPermissions: ext.hostPermissions,
      homepageUrl: ext.homepageUrl,
      updateUrl: ext.updateUrl,
      offlineEnabled: ext.offlineEnabled,
      icons: ext.icons
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function setExtensionEnabled(extensionId, enabled) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    await chrome.management.setEnabled(extensionId, enabled);
    const ext = await chrome.management.get(extensionId);
    
    return {
      success: true,
      message: `Extension ${ext.name} ${enabled ? 'enabled' : 'disabled'}`,
      extension: {
        id: extensionId,
        name: ext.name,
        enabled: ext.enabled
      }
    };
  } catch (error) {
    return { error: error.message };
  }
}

// ============ EXTENSION POPUP INTERACTION ============
async function openExtensionPopup(extensionId, options = {}) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    // Get extension info to find popup URL
    const ext = await chrome.management.get(extensionId);
    if (!ext) {
      return { error: `Extension ${extensionId} not found` };
    }
    
    // Construct popup URL - standard locations
    const popupUrls = [
      `chrome-extension://${extensionId}/popup.html`,
      `chrome-extension://${extensionId}/popup/popup.html`,
      `chrome-extension://${extensionId}/index.html`,
      `chrome-extension://${extensionId}/src/popup.html`,
      `chrome-extension://${extensionId}/dist/popup.html`
    ];
    
    // Use custom path if provided
    if (options.popupPath) {
      popupUrls.unshift(`chrome-extension://${extensionId}/${options.popupPath}`);
    }
    
    // Try to open the popup as a new tab
    let tab = null;
    for (const url of popupUrls) {
      try {
        tab = await chrome.tabs.create({ 
          url, 
          active: true,
          windowId: options.windowId
        });
        
        // Wait for tab to load
        await new Promise((resolve) => {
          const listener = (tabId, info) => {
            if (tabId === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          setTimeout(resolve, 5000); // Timeout after 5s
        });
        
        // Check if page loaded successfully (not error page)
        const updatedTab = await chrome.tabs.get(tab.id);
        if (!updatedTab.url?.includes('chrome-error://')) {
          return {
            success: true,
            tabId: tab.id,
            url: updatedTab.url,
            extensionName: ext.name,
            message: `Opened ${ext.name} popup in tab ${tab.id}`
          };
        }
      } catch (e) {
        // Try next URL
        continue;
      }
    }
    
    return { error: `Could not find popup for extension ${ext.name}. Try specifying popupPath.` };
  } catch (error) {
    return { error: error.message };
  }
}

async function openExtensionOptionsPage(extensionId) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    const ext = await chrome.management.get(extensionId);
    if (!ext) {
      return { error: `Extension ${extensionId} not found` };
    }
    
    if (!ext.optionsUrl) {
      return { error: `Extension ${ext.name} has no options page` };
    }
    
    const tab = await chrome.tabs.create({ url: ext.optionsUrl, active: true });
    
    // Wait for load
    await new Promise((resolve) => {
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(resolve, 5000);
    });
    
    return {
      success: true,
      tabId: tab.id,
      url: ext.optionsUrl,
      extensionName: ext.name,
      message: `Opened ${ext.name} options page in tab ${tab.id}`
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function openExtensionDevTools(extensionId) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    // Open the extension's service worker/background page in DevTools
    // This opens chrome://extensions/?id=extensionId
    const url = `chrome://extensions/?id=${extensionId}`;
    const tab = await chrome.tabs.create({ url, active: true });
    
    return {
      success: true,
      tabId: tab.id,
      url,
      message: `Opened extension management page for ${extensionId}. Click "Inspect views" to see service worker.`
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function openExtensionErrors(extensionId) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    // Open the extension errors page directly
    const url = `chrome://extensions/?id=${extensionId}&errors`;
    const tab = await chrome.tabs.create({ url, active: true });
    
    return {
      success: true,
      tabId: tab.id,
      url,
      message: `Opened extension errors page for ${extensionId}.`
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function triggerExtensionAction(extensionId) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    // Note: chrome.action.openPopup() requires user gesture in most browsers
    // We'll try it, but fallback to opening as tab
    try {
      // This only works for the current extension or with special permissions
      await chrome.action.openPopup();
      return { success: true, message: 'Popup triggered via action API' };
    } catch (e) {
      // Fallback: open as tab
      return await openExtensionPopup(extensionId);
    }
  } catch (error) {
    return { error: error.message };
  }
}

async function getExtensionPopupContent(extensionId, options = {}) {
  try {
    // First open the popup
    const result = await openExtensionPopup(extensionId, options);
    if (result.error) return result;
    
    // Give it a moment to render
    await new Promise(r => setTimeout(r, 500));
    
    // Get snapshot of the popup content
    const snapshot = await forwardAgentAction({ type: 'GET_SNAPSHOT' }, result.tabId);
    
    return {
      ...result,
      snapshot
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function interactWithExtensionPopup(extensionId, actions) {
  try {
    // Open popup first
    const openResult = await openExtensionPopup(extensionId);
    if (openResult.error) return openResult;
    
    const tabId = openResult.tabId;
    const results = [];
    
    // Wait for popup to fully load
    await new Promise(r => setTimeout(r, 500));
    
    // Execute each action in sequence
    for (const action of actions) {
      let result;
      switch (action.type) {
        case 'click':
          result = await forwardAgentAction({
            type: 'CLICK',
            selector: action.selector,
            options: action.options || {}
          }, tabId);
          break;
        case 'type':
          result = await forwardAgentAction({
            type: 'TYPE',
            selector: action.selector,
            text: action.text,
            options: action.options || {}
          }, tabId);
          break;
        case 'snapshot':
          result = await forwardAgentAction({ type: 'GET_SNAPSHOT' }, tabId);
          break;
        case 'wait':
          await new Promise(r => setTimeout(r, action.ms || 500));
          result = { success: true, waited: action.ms || 500 };
          break;
        default:
          result = { error: `Unknown action type: ${action.type}` };
      }
      
      results.push({ action: action.type, result });
      
      // Small delay between actions
      if (action.delay) {
        await new Promise(r => setTimeout(r, action.delay));
      }
    }
    
    return {
      success: true,
      extensionId,
      tabId,
      results
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function closeExtensionTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
    return { success: true, message: `Tab ${tabId} closed` };
  } catch (error) {
    return { error: error.message };
  }
}

// ============ EXTENSION ERROR CAPTURE ============
// Captures errors from extension pages via CDP for AI debugging

async function captureExtensionErrors(extensionId, options = {}) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    // Get extension info first
    const extInfo = await chrome.management.get(extensionId);
    if (!extInfo) {
      return { error: `Extension ${extensionId} not found` };
    }
    
    // Determine which page to open for error capture
    const pagePath = options.page || 'popup';
    let pageUrl;
    
    if (pagePath === 'popup') {
      // Try to find popup path from manifest
      pageUrl = `chrome-extension://${extensionId}/popup.html`;
    } else if (pagePath === 'options') {
      pageUrl = extInfo.optionsUrl || `chrome-extension://${extensionId}/options.html`;
    } else if (pagePath === 'background' || pagePath === 'service_worker') {
      // For service workers, we need to check DevTools
      pageUrl = `chrome-extension://${extensionId}/_generated_background_page.html`;
    } else {
      pageUrl = `chrome-extension://${extensionId}/${pagePath}`;
    }
    
    // Open the extension page
    const tab = await chrome.tabs.create({ url: pageUrl, active: false });
    
    // Wait for page to start loading
    await new Promise(r => setTimeout(r, 300));
    
    // Attach debugger
    const attachResult = await attachDebugger(tab.id);
    if (attachResult.error) {
      await chrome.tabs.remove(tab.id);
      return { error: `Failed to attach debugger: ${attachResult.error}` };
    }
    
    // Enable Console and Runtime domains
    await sendCDPCommand(tab.id, 'Console.enable');
    await sendCDPCommand(tab.id, 'Runtime.enable');
    
    // Initialize error store for this extension
    if (!extensionErrorStore.has(extensionId)) {
      extensionErrorStore.set(extensionId, { errors: [], console: [], tabId: tab.id });
    }
    const store = extensionErrorStore.get(extensionId);
    store.tabId = tab.id;
    
    // Set up CDP event listeners for this tab
    const errorHandler = (source, method, params) => {
      if (source.tabId !== tab.id) return;
      
      if (method === 'Runtime.exceptionThrown') {
        const error = {
          timestamp: new Date().toISOString(),
          type: 'exception',
          message: params.exceptionDetails?.text || 'Unknown error',
          description: params.exceptionDetails?.exception?.description,
          url: params.exceptionDetails?.url,
          lineNumber: params.exceptionDetails?.lineNumber,
          columnNumber: params.exceptionDetails?.columnNumber,
          stackTrace: params.exceptionDetails?.stackTrace?.callFrames?.map(f => ({
            functionName: f.functionName || '(anonymous)',
            url: f.url,
            lineNumber: f.lineNumber,
            columnNumber: f.columnNumber
          }))
        };
        store.errors.push(error);
      }
      
      if (method === 'Console.messageAdded') {
        const msg = params.message;
        store.console.push({
          timestamp: new Date().toISOString(),
          level: msg.level,
          text: msg.text,
          url: msg.url,
          line: msg.line,
          column: msg.column
        });
      }
      
      if (method === 'Runtime.consoleAPICalled') {
        store.console.push({
          timestamp: new Date().toISOString(),
          level: params.type,
          text: params.args?.map(a => a.value || a.description || String(a)).join(' '),
          stackTrace: params.stackTrace?.callFrames?.[0]
        });
      }
    };
    
    chrome.debugger.onEvent.addListener(errorHandler);
    
    // Wait for errors to be captured (allow page to fully load and run)
    const waitTime = options.waitTime || 2000;
    await new Promise(r => setTimeout(r, waitTime));
    
    // Get any additional runtime errors
    const evalResult = await sendCDPCommand(tab.id, 'Runtime.evaluate', {
      expression: `
        (function() {
          const errors = [];
          // Check for any global errors
          if (window.__lastError) errors.push(window.__lastError);
          // Check for chrome.runtime.lastError
          if (chrome.runtime?.lastError) errors.push(chrome.runtime.lastError.message);
          return errors;
        })()
      `,
      returnByValue: true
    });
    
    if (evalResult?.result?.value?.length > 0) {
      evalResult.result.value.forEach(e => {
        store.errors.push({
          timestamp: new Date().toISOString(),
          type: 'runtime',
          message: e
        });
      });
    }
    
    // Remove listener after capture
    chrome.debugger.onEvent.removeListener(errorHandler);
    
    // Close the tab if requested
    if (options.closeTab !== false) {
      await detachDebugger(tab.id);
      await chrome.tabs.remove(tab.id);
    }
    
    return {
      success: true,
      extensionId,
      extensionName: extInfo.name,
      page: pagePath,
      errors: store.errors,
      console: store.console.filter(c => c.level === 'error' || c.level === 'warning'),
      totalErrors: store.errors.length,
      totalConsoleMessages: store.console.length,
      summary: store.errors.length > 0 
        ? `Found ${store.errors.length} error(s) in ${extInfo.name}`
        : `No errors found in ${extInfo.name}`
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function getExtensionConsole(extensionId, options = {}) {
  try {
    const store = extensionErrorStore.get(extensionId);
    if (!store) {
      return { 
        error: 'No console data captured. Run capture_extension_errors first.',
        hint: 'Use capture_extension_errors to start monitoring an extension'
      };
    }
    
    const level = options.level; // 'error', 'warning', 'log', 'info', etc.
    let logs = store.console;
    
    if (level) {
      logs = logs.filter(l => l.level === level);
    }
    
    return {
      success: true,
      extensionId,
      console: logs.slice(-50), // Last 50 entries
      total: logs.length
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function analyzeExtension(extensionId) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    // Get extension info
    const extInfo = await getExtensionInfo(extensionId);
    if (extInfo.error) return extInfo;
    
    // Capture errors from popup
    const popupErrors = await captureExtensionErrors(extensionId, { 
      page: 'popup', 
      waitTime: 1500 
    });
    
    // Check for options page too if it exists
    let optionsErrors = { errors: [], console: [] };
    if (extInfo.optionsUrl) {
      optionsErrors = await captureExtensionErrors(extensionId, { 
        page: 'options', 
        waitTime: 1000 
      });
    }
    
    // Compile analysis
    const allErrors = [
      ...(popupErrors.errors || []),
      ...(optionsErrors.errors || [])
    ];
    
    const allConsole = [
      ...(popupErrors.console || []),
      ...(optionsErrors.console || [])
    ];
    
    // Generate fix suggestions based on error patterns
    const suggestions = [];
    
    allErrors.forEach(err => {
      if (err.message?.includes('undefined')) {
        suggestions.push({
          error: err.message,
          suggestion: 'Check for null/undefined variables. Add proper initialization or null checks.',
          location: err.url ? `${err.url}:${err.lineNumber}` : 'unknown'
        });
      }
      if (err.message?.includes('Cannot read property') || err.message?.includes('Cannot read properties')) {
        suggestions.push({
          error: err.message,
          suggestion: 'Object is null/undefined before property access. Use optional chaining (?.) or check existence.',
          location: err.url ? `${err.url}:${err.lineNumber}` : 'unknown'
        });
      }
      if (err.message?.includes('Content Security Policy')) {
        suggestions.push({
          error: err.message,
          suggestion: 'CSP violation. Move inline scripts to external files. Avoid eval() and new Function().',
          location: err.url ? `${err.url}:${err.lineNumber}` : 'unknown'
        });
      }
      if (err.message?.includes('net::ERR') || err.message?.includes('Failed to fetch')) {
        suggestions.push({
          error: err.message,
          suggestion: 'Network error. Check URL, CORS settings, and host_permissions in manifest.json.',
          location: err.url ? `${err.url}:${err.lineNumber}` : 'unknown'
        });
      }
    });
    
    return {
      success: true,
      extensionId,
      info: {
        name: extInfo.name,
        version: extInfo.version,
        enabled: extInfo.enabled,
        type: extInfo.type,
        installType: extInfo.installType
      },
      analysis: {
        totalErrors: allErrors.length,
        totalWarnings: allConsole.filter(c => c.level === 'warning').length,
        errors: allErrors.slice(0, 10), // First 10 errors with details
        warnings: allConsole.filter(c => c.level === 'warning').slice(0, 5),
        suggestions: suggestions.slice(0, 5)
      },
      health: allErrors.length === 0 ? 'healthy' : allErrors.length < 3 ? 'minor_issues' : 'needs_attention',
      nextSteps: allErrors.length > 0 
        ? [
            'Review the errors and their stack traces above',
            'Check the file locations mentioned in the errors',
            'Apply the suggested fixes',
            'Reload the extension and run analyze_extension again'
          ]
        : ['Extension appears healthy. No immediate action needed.']
    };
  } catch (error) {
    return { error: error.message };
  }
}

// ============ FAST EXTENSION DEBUGGING TOOLS ============

// Storage for extension state snapshots (for compare)
let extensionStateSnapshots = new Map();

// Quick test - reload, open popup, capture errors in one call
async function quickTestExtension(extensionId, actions = []) {
  try {
    if (!extensionId) return { error: 'Extension ID required' };
    
    const results = {
      extensionId,
      timestamp: new Date().toISOString(),
      steps: []
    };
    
    // Step 1: Get extension info
    const extInfo = await chrome.management.get(extensionId);
    results.extension = { name: extInfo.name, version: extInfo.version, enabled: extInfo.enabled };
    results.steps.push({ step: 'info', success: true });
    
    // Step 2: Reload extension
    try {
      await chrome.management.setEnabled(extensionId, false);
      await new Promise(r => setTimeout(r, 100));
      await chrome.management.setEnabled(extensionId, true);
      await new Promise(r => setTimeout(r, 500)); // Wait for reload
      results.steps.push({ step: 'reload', success: true });
    } catch (e) {
      results.steps.push({ step: 'reload', success: false, error: e.message });
    }
    
    // Step 3: Open popup and capture errors
    const errorCapture = await captureExtensionErrors(extensionId, { 
      page: 'popup', 
      waitTime: 1500, 
      closeTab: actions.length === 0 
    });
    results.errors = errorCapture.errors || [];
    results.console = errorCapture.console || [];
    results.steps.push({ step: 'capture_errors', success: !errorCapture.error, error: errorCapture.error });
    
    // Step 4: Run additional actions if provided
    if (actions.length > 0 && errorCapture.tabId) {
      const actionResults = [];
      for (const action of actions) {
        try {
          const result = await forwardAgentAction(action, errorCapture.tabId);
          actionResults.push({ action: action.type, success: true, result });
        } catch (e) {
          actionResults.push({ action: action.type, success: false, error: e.message });
        }
        await new Promise(r => setTimeout(r, 200));
      }
      results.actionResults = actionResults;
      
      // Close tab after actions
      try {
        await chrome.tabs.remove(errorCapture.tabId);
      } catch (e) {}
    }
    
    // Summary
    results.summary = {
      hasErrors: results.errors.length > 0,
      errorCount: results.errors.length,
      warningCount: results.console.filter(c => c.level === 'warning').length,
      health: results.errors.length === 0 ? 'healthy' : 'has_errors'
    };
    
    return results;
  } catch (error) {
    return { error: error.message };
  }
}

// Get extension's chrome.storage data
async function getExtensionStorage(extensionId, storageArea = 'all') {
  try {
    if (!extensionId) return { error: 'Extension ID required' };
    
    // Open extension popup to access its storage
    const tab = await chrome.tabs.create({ 
      url: `chrome-extension://${extensionId}/popup.html`,
      active: false 
    });
    
    await new Promise(r => setTimeout(r, 500));
    
    // Attach debugger and run code in extension context
    await attachDebugger(tab.id);
    await sendCDPCommand(tab.id, 'Runtime.enable');
    
    const result = await sendCDPCommand(tab.id, 'Runtime.evaluate', {
      expression: `
        (async () => {
          const result = {};
          if ('${storageArea}' === 'local' || '${storageArea}' === 'all') {
            result.local = await chrome.storage.local.get(null);
          }
          if ('${storageArea}' === 'sync' || '${storageArea}' === 'all') {
            try {
              result.sync = await chrome.storage.sync.get(null);
            } catch (e) {
              result.sync = { error: e.message };
            }
          }
          return result;
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    });
    
    await detachDebugger(tab.id);
    await chrome.tabs.remove(tab.id);
    
    if (result?.result?.value) {
      return {
        success: true,
        extensionId,
        storage: result.result.value
      };
    }
    
    return { error: 'Failed to get storage data' };
  } catch (error) {
    return { error: error.message };
  }
}

// Quick health check of ALL extensions
async function extensionHealthCheck(onlyWithErrors = false) {
  try {
    const extensions = await chrome.management.getAll();
    const results = [];
    
    for (const ext of extensions) {
      // Skip self and themes
      if (ext.id === chrome.runtime.id) continue;
      if (ext.type === 'theme') continue;
      
      const status = {
        id: ext.id,
        name: ext.name,
        version: ext.version,
        enabled: ext.enabled,
        type: ext.type,
        installType: ext.installType
      };
      
      // Check if we have captured errors for this extension
      const errorStore = extensionErrorStore.get(ext.id);
      if (errorStore) {
        status.errorCount = errorStore.errors?.length || 0;
        status.warningCount = errorStore.console?.filter(c => c.level === 'warning').length || 0;
        status.lastError = errorStore.errors?.[errorStore.errors.length - 1]?.message;
      } else {
        status.errorCount = 0;
        status.warningCount = 0;
        status.monitored = false;
      }
      
      status.health = status.errorCount === 0 ? 'unknown' : 'has_errors';
      
      if (!onlyWithErrors || status.errorCount > 0) {
        results.push(status);
      }
    }
    
    return {
      success: true,
      totalExtensions: extensions.length - 1, // Exclude self
      checked: results.length,
      withErrors: results.filter(r => r.errorCount > 0).length,
      extensions: results
    };
  } catch (error) {
    return { error: error.message };
  }
}

// Watch extension for errors (continuous monitoring)
let watchedExtensions = new Map();

async function watchExtension(extensionId, pages = ['popup']) {
  try {
    if (!extensionId) return { error: 'Extension ID required' };
    
    const extInfo = await chrome.management.get(extensionId);
    
    // Initialize error store if not exists
    if (!extensionErrorStore.has(extensionId)) {
      extensionErrorStore.set(extensionId, { errors: [], console: [], watching: true });
    }
    
    const store = extensionErrorStore.get(extensionId);
    store.watching = true;
    store.watchStarted = Date.now();
    store.pages = pages;
    
    // Capture initial errors from each page
    for (const page of pages) {
      await captureExtensionErrors(extensionId, { page, waitTime: 1000 });
    }
    
    return {
      success: true,
      message: `Now watching ${extInfo.name} for errors`,
      extensionId,
      extensionName: extInfo.name,
      pages,
      initialErrors: store.errors.length,
      initialWarnings: store.console.filter(c => c.level === 'warning').length
    };
  } catch (error) {
    return { error: error.message };
  }
}

// Get and validate extension manifest
async function getExtensionManifest(extensionId) {
  try {
    if (!extensionId) return { error: 'Extension ID required' };
    
    // Open a page from the extension to read its manifest
    const tab = await chrome.tabs.create({ 
      url: `chrome-extension://${extensionId}/manifest.json`,
      active: false 
    });
    
    await new Promise(r => setTimeout(r, 500));
    
    // Get page content
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.body.innerText
    });
    
    await chrome.tabs.remove(tab.id);
    
    if (!results?.[0]?.result) {
      return { error: 'Could not read manifest' };
    }
    
    const manifest = JSON.parse(results[0].result);
    
    // Validate manifest and detect issues
    const issues = [];
    const warnings = [];
    
    // Required fields
    if (!manifest.manifest_version) issues.push('Missing manifest_version');
    if (!manifest.name) issues.push('Missing name');
    if (!manifest.version) issues.push('Missing version');
    
    // MV3 specific checks
    if (manifest.manifest_version === 3) {
      if (manifest.background?.scripts) {
        issues.push('MV3 does not support background.scripts, use service_worker');
      }
      if (manifest.browser_action) {
        warnings.push('browser_action is deprecated in MV3, use action');
      }
      if (manifest.page_action) {
        warnings.push('page_action is deprecated in MV3, use action');
      }
    }
    
    // Permission checks
    if (manifest.permissions?.includes('tabs') && !manifest.host_permissions?.length) {
      warnings.push('Has tabs permission but no host_permissions - may have limited functionality');
    }
    
    // Content script checks
    if (manifest.content_scripts) {
      manifest.content_scripts.forEach((cs, i) => {
        if (cs.matches?.includes('<all_urls>') && !cs.exclude_matches) {
          warnings.push(`Content script ${i} runs on all URLs without exclusions`);
        }
      });
    }
    
    return {
      success: true,
      extensionId,
      manifest,
      validation: {
        valid: issues.length === 0,
        issues,
        warnings,
        manifestVersion: manifest.manifest_version,
        permissions: manifest.permissions || [],
        hostPermissions: manifest.host_permissions || []
      }
    };
  } catch (error) {
    return { error: error.message };
  }
}

// Compare extension state before/after
async function compareExtensionState(extensionId, action) {
  try {
    if (!extensionId) return { error: 'Extension ID required' };
    
    const currentState = {
      timestamp: Date.now(),
      errors: extensionErrorStore.get(extensionId)?.errors?.length || 0,
      console: extensionErrorStore.get(extensionId)?.console?.length || 0,
      info: await chrome.management.get(extensionId)
    };
    
    if (action === 'snapshot') {
      extensionStateSnapshots.set(extensionId, currentState);
      return {
        success: true,
        message: 'State snapshot saved',
        snapshot: currentState
      };
    }
    
    if (action === 'compare') {
      const savedState = extensionStateSnapshots.get(extensionId);
      if (!savedState) {
        return { error: 'No snapshot saved. Call with action="snapshot" first.' };
      }
      
      return {
        success: true,
        before: savedState,
        after: currentState,
        diff: {
          timeDelta: currentState.timestamp - savedState.timestamp,
          newErrors: currentState.errors - savedState.errors,
          newConsoleMessages: currentState.console - savedState.console,
          enabledChanged: savedState.info.enabled !== currentState.info.enabled
        }
      };
    }
    
    return { error: 'Invalid action. Use "snapshot" or "compare".' };
  } catch (error) {
    return { error: error.message };
  }
}

// Inject debug helpers into extension page
async function injectDebugHelper(extensionId, tabId) {
  try {
    if (!tabId) return { error: 'Tab ID required' };
    
    await attachDebugger(tabId);
    await sendCDPCommand(tabId, 'Runtime.enable');
    await sendCDPCommand(tabId, 'Console.enable');
    
    // Inject helper code
    await sendCDPCommand(tabId, 'Runtime.evaluate', {
      expression: `
        window.__apexDebug = {
          errors: [],
          logs: [],
          startTime: Date.now()
        };
        
        // Capture all errors
        window.addEventListener('error', (e) => {
          window.__apexDebug.errors.push({
            message: e.message,
            filename: e.filename,
            lineno: e.lineno,
            colno: e.colno,
            timestamp: Date.now()
          });
        });
        
        // Capture unhandled promise rejections
        window.addEventListener('unhandledrejection', (e) => {
          window.__apexDebug.errors.push({
            message: 'Unhandled Promise Rejection: ' + e.reason,
            timestamp: Date.now()
          });
        });
        
        // Wrap console methods
        ['log', 'warn', 'error', 'info', 'debug'].forEach(method => {
          const orig = console[method];
          console[method] = function(...args) {
            window.__apexDebug.logs.push({
              method,
              args: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)),
              timestamp: Date.now()
            });
            return orig.apply(console, args);
          };
        });
        
        console.log('[Apex Debug] Helpers injected');
        'Debug helpers injected successfully'
      `,
      returnByValue: true
    });
    
    return {
      success: true,
      message: 'Debug helpers injected. Errors and logs are now being captured.',
      tabId,
      note: 'Use get_cdp_console_logs to retrieve captured data'
    };
  } catch (error) {
    return { error: error.message };
  }
}

// Get ALL extension errors across all monitored extensions
function getAllExtensionErrors() {
  const allErrors = [];
  
  extensionErrorStore.forEach((store, extensionId) => {
    if (store.errors?.length > 0) {
      allErrors.push({
        extensionId,
        errorCount: store.errors.length,
        errors: store.errors.slice(-5), // Last 5 errors
        watching: store.watching || false
      });
    }
  });
  
  return {
    success: true,
    totalMonitored: extensionErrorStore.size,
    withErrors: allErrors.length,
    totalErrors: allErrors.reduce((sum, e) => sum + e.errorCount, 0),
    extensions: allErrors
  };
}

// Read extension source file
async function readExtensionFile(extensionId, filePath) {
  try {
    if (!extensionId || !filePath) return { error: 'Extension ID and file path required' };
    
    const url = `chrome-extension://${extensionId}/${filePath}`;
    
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return { error: `File not found or not accessible: ${filePath}` };
      }
      
      const content = await response.text();
      const lines = content.split('\n');
      
      return {
        success: true,
        extensionId,
        filePath,
        content,
        lines: lines.length,
        size: content.length,
        preview: lines.slice(0, 50).join('\n') + (lines.length > 50 ? '\n... (truncated)' : '')
      };
    } catch (fetchError) {
      // Try via tab if fetch fails
      const tab = await chrome.tabs.create({ url, active: false });
      await new Promise(r => setTimeout(r, 300));
      
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.body.innerText || document.documentElement.outerHTML
      });
      
      await chrome.tabs.remove(tab.id);
      
      if (results?.[0]?.result) {
        const content = results[0].result;
        return {
          success: true,
          extensionId,
          filePath,
          content,
          lines: content.split('\n').length,
          size: content.length
        };
      }
      
      return { error: fetchError.message };
    }
  } catch (error) {
    return { error: error.message };
  }
}

// List extension files (limited - can only see web_accessible_resources)
async function listExtensionFiles(extensionId, directory = '') {
  try {
    if (!extensionId) return { error: 'Extension ID required' };
    
    // Get extension info to find declared resources
    const extInfo = await chrome.management.get(extensionId);
    
    // Common extension files to check
    const commonFiles = [
      'manifest.json',
      'popup.html', 'popup.js', 'popup.css',
      'popup/popup.html', 'popup/popup.js', 'popup/popup.css',
      'background.js', 'background.html',
      'options.html', 'options.js', 'options.css',
      'content.js', 'content.css',
      'content/content.js', 'content/content.css',
      'styles.css', 'style.css',
      'index.html', 'index.js',
      'src/popup.html', 'src/popup.js',
      'src/background.js', 'src/content.js',
      'dist/popup.js', 'dist/background.js',
      'js/popup.js', 'js/background.js', 'js/content.js',
      'scripts/popup.js', 'scripts/background.js'
    ];
    
    const foundFiles = [];
    const notFound = [];
    
    for (const file of commonFiles) {
      if (directory && !file.startsWith(directory)) continue;
      
      try {
        const url = `chrome-extension://${extensionId}/${file}`;
        const response = await fetch(url, { method: 'HEAD' });
        if (response.ok) {
          foundFiles.push(file);
        } else {
          notFound.push(file);
        }
      } catch (e) {
        // File doesn't exist or not accessible
      }
    }
    
    return {
      success: true,
      extensionId,
      extensionName: extInfo.name,
      directory: directory || '/',
      files: foundFiles,
      note: 'Only web-accessible files can be listed. Some files may exist but not be accessible.'
    };
  } catch (error) {
    return { error: error.message };
  }
}

// Search extension code for text/pattern
async function searchExtensionCode(extensionId, query, fileTypes = ['js', 'html', 'css', 'json']) {
  try {
    if (!extensionId || !query) return { error: 'Extension ID and query required' };
    
    // First, list available files
    const fileList = await listExtensionFiles(extensionId);
    if (fileList.error) return fileList;
    
    const matches = [];
    
    for (const filePath of fileList.files) {
      // Check file extension
      const ext = filePath.split('.').pop();
      if (!fileTypes.includes(ext)) continue;
      
      // Read file content
      const fileContent = await readExtensionFile(extensionId, filePath);
      if (fileContent.error) continue;
      
      // Search for matches
      const lines = fileContent.content.split('\n');
      const regex = new RegExp(query, 'gi');
      
      lines.forEach((line, index) => {
        if (regex.test(line)) {
          matches.push({
            file: filePath,
            line: index + 1,
            content: line.trim().slice(0, 200),
            context: lines.slice(Math.max(0, index - 1), index + 2).join('\n')
          });
        }
        regex.lastIndex = 0; // Reset regex
      });
    }
    
    return {
      success: true,
      extensionId,
      query,
      matchCount: matches.length,
      filesSearched: fileList.files.length,
      matches: matches.slice(0, 20) // Limit results
    };
  } catch (error) {
    return { error: error.message };
  }
}

// AI-assisted error fix suggestion
async function suggestErrorFix(extensionId, errorMessage) {
  try {
    if (!extensionId || !errorMessage) return { error: 'Extension ID and error message required' };
    
    const suggestions = [];
    const errorLower = errorMessage.toLowerCase();
    
    // Common error patterns and fixes
    const errorPatterns = [
      {
        pattern: /cannot read propert(y|ies) .* of (null|undefined)/i,
        type: 'null_reference',
        suggestion: 'Add null check before accessing property. Use optional chaining (?.) or if statements.',
        example: '// Before: obj.property\n// After: obj?.property or if (obj) { obj.property }'
      },
      {
        pattern: /is not defined/i,
        type: 'undefined_variable',
        suggestion: 'Variable is not declared. Check spelling, imports, or scope.',
        example: '// Ensure variable is declared with let/const/var\n// Check if import statement is correct'
      },
      {
        pattern: /is not a function/i,
        type: 'not_function',
        suggestion: 'Trying to call something that is not a function. Check if method exists or is imported correctly.',
        example: '// Verify the function exists\n// Check import/require statement'
      },
      {
        pattern: /content security policy/i,
        type: 'csp_violation',
        suggestion: 'Move inline scripts to external files. Avoid eval() and new Function().',
        example: '// Move <script>code</script> to external .js file\n// Remove inline event handlers like onclick="..."'
      },
      {
        pattern: /cross-origin|cors/i,
        type: 'cors_error',
        suggestion: 'Add host_permissions in manifest.json for the target domain.',
        example: '"host_permissions": ["https://api.example.com/*"]'
      },
      {
        pattern: /unexpected token/i,
        type: 'syntax_error',
        suggestion: 'Check for syntax errors: missing brackets, commas, or quotes.',
        example: '// Look for: missing }, missing "," in objects/arrays, unterminated strings'
      },
      {
        pattern: /failed to fetch|net::err/i,
        type: 'network_error',
        suggestion: 'Network request failed. Check URL, add host_permissions, or handle fetch errors.',
        example: 'try { await fetch(url) } catch(e) { console.error("Network error", e) }'
      },
      {
        pattern: /extension context invalidated/i,
        type: 'context_invalidated',
        suggestion: 'Extension was reloaded while script was running. Add reconnection logic.',
        example: 'chrome.runtime.onMessage listener may need to handle disconnection'
      },
      {
        pattern: /unchecked runtime\.lasterror/i,
        type: 'unchecked_error',
        suggestion: 'Check chrome.runtime.lastError after chrome API calls.',
        example: 'chrome.tabs.query({}, (tabs) => {\n  if (chrome.runtime.lastError) {\n    console.error(chrome.runtime.lastError);\n    return;\n  }\n  // handle tabs\n});'
      }
    ];
    
    // Find matching patterns
    for (const pattern of errorPatterns) {
      if (pattern.pattern.test(errorMessage)) {
        suggestions.push({
          errorType: pattern.type,
          suggestion: pattern.suggestion,
          example: pattern.example
        });
      }
    }
    
    // Try to extract file/line info from error
    const fileMatch = errorMessage.match(/(?:at |in )(?:.*?\/)?([a-zA-Z0-9_-]+\.(js|ts|html)):?(\d+)?/i);
    let location = null;
    if (fileMatch) {
      location = {
        file: fileMatch[1],
        line: fileMatch[3] ? parseInt(fileMatch[3]) : null
      };
    }
    
    // Get captured errors for this extension
    const storedErrors = extensionErrorStore.get(extensionId);
    const relatedErrors = storedErrors?.errors?.filter(e => 
      e.message?.includes(errorMessage.slice(0, 30)) || 
      errorMessage.includes(e.message?.slice(0, 30))
    ).slice(0, 3) || [];
    
    return {
      success: true,
      extensionId,
      errorMessage,
      analysis: {
        location,
        suggestions: suggestions.length > 0 ? suggestions : [{
          errorType: 'unknown',
          suggestion: 'Review the error message and stack trace. Check browser console for more details.',
          example: 'Use analyze_extension to capture full error context'
        }],
        relatedErrors: relatedErrors.map(e => ({
          message: e.message,
          url: e.url,
          line: e.lineNumber
        }))
      },
      nextSteps: [
        location ? `1. Open ${location.file}${location.line ? ` at line ${location.line}` : ''}` : '1. Identify the source file from stack trace',
        '2. Apply the suggested fix',
        '3. Use reload_extension to reload',
        '4. Use quick_test_extension to verify the fix'
      ]
    };
  } catch (error) {
    return { error: error.message };
  }
}

// ============ CDP DEBUGGER MANAGER ============
let debuggerAttached = new Map(); // tabId -> { attached, domains }

async function attachDebugger(tabId) {
  if (debuggerAttached.get(tabId)?.attached) {
    return { success: true, already: true };
  }
  
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerAttached.set(tabId, { attached: true, domains: new Set() });
    console.log(`CDP debugger attached to tab ${tabId}`);
    return { success: true };
  } catch (error) {
    return { error: error.message };
  }
}

async function detachDebugger(tabId) {
  if (!debuggerAttached.get(tabId)?.attached) {
    return { success: true, already: true };
  }
  
  try {
    await chrome.debugger.detach({ tabId });
    debuggerAttached.delete(tabId);
    console.log(`CDP debugger detached from tab ${tabId}`);
    return { success: true };
  } catch (error) {
    return { error: error.message };
  }
}

async function sendCDPCommand(tabId, method, params = {}) {
  // Auto-attach if not attached
  if (!debuggerAttached.get(tabId)?.attached) {
    const attachResult = await attachDebugger(tabId);
    if (attachResult.error) return attachResult;
  }
  
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, method, params);
    return result;
  } catch (error) {
    return { error: error.message };
  }
}

async function enableCDPDomain(tabId, domain) {
  const tabData = debuggerAttached.get(tabId);
  if (tabData?.domains?.has(domain)) {
    return { success: true, already: true };
  }
  
  const result = await sendCDPCommand(tabId, `${domain}.enable`);
  if (!result?.error) {
    tabData?.domains?.add(domain);
  }
  return result;
}

// CDP-based Event Listeners
async function getEventListeners(tabId, selector) {
  try {
    await enableCDPDomain(tabId, 'DOM');
    await enableCDPDomain(tabId, 'DOMDebugger');
    
    // Get document
    const doc = await sendCDPCommand(tabId, 'DOM.getDocument', { depth: 0 });
    if (doc?.error) return doc;
    
    // Query for element
    const nodeResult = await sendCDPCommand(tabId, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: selector
    });
    
    if (nodeResult?.error || !nodeResult?.nodeId) {
      return { error: `Element not found: ${selector}` };
    }
    
    // Resolve to object for getEventListeners
    const objResult = await sendCDPCommand(tabId, 'DOM.resolveNode', {
      nodeId: nodeResult.nodeId
    });
    
    if (objResult?.error) return objResult;
    
    // Get event listeners
    const listeners = await sendCDPCommand(tabId, 'DOMDebugger.getEventListeners', {
      objectId: objResult.object.objectId,
      depth: 1,
      pierce: true
    });
    
    if (listeners?.error) return listeners;
    
    return {
      selector,
      listeners: listeners.listeners?.map(l => ({
        type: l.type,
        useCapture: l.useCapture,
        passive: l.passive,
        once: l.once,
        handler: l.handler?.description?.slice(0, 200),
        scriptId: l.scriptId,
        lineNumber: l.lineNumber,
        columnNumber: l.columnNumber
      })) || []
    };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP Network monitoring
let networkRequests = new Map(); // tabId -> requests[]

async function startNetworkMonitoring(tabId) {
  try {
    await enableCDPDomain(tabId, 'Network');
    networkRequests.set(tabId, []);
    return { success: true, message: 'Network monitoring started' };
  } catch (error) {
    return { error: error.message };
  }
}

async function getNetworkRequests(tabId) {
  return {
    requests: networkRequests.get(tabId) || [],
    count: (networkRequests.get(tabId) || []).length
  };
}

// CDP Performance profiling
async function startCPUProfile(tabId) {
  try {
    await enableCDPDomain(tabId, 'Profiler');
    await sendCDPCommand(tabId, 'Profiler.start');
    return { success: true, message: 'CPU profiling started' };
  } catch (error) {
    return { error: error.message };
  }
}

async function stopCPUProfile(tabId) {
  try {
    const profile = await sendCDPCommand(tabId, 'Profiler.stop');
    return { success: true, profile };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP Heap profiling
async function takeHeapSnapshot(tabId) {
  try {
    await enableCDPDomain(tabId, 'HeapProfiler');
    
    let chunks = [];
    // Note: In real implementation, we'd need to handle events
    await sendCDPCommand(tabId, 'HeapProfiler.takeHeapSnapshot', {
      reportProgress: false
    });
    
    return { success: true, message: 'Heap snapshot taken' };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP DOM breakpoints
async function setDOMBreakpoint(tabId, selector, type = 'subtree-modified') {
  try {
    await enableCDPDomain(tabId, 'DOM');
    await enableCDPDomain(tabId, 'DOMDebugger');
    
    const doc = await sendCDPCommand(tabId, 'DOM.getDocument', { depth: 0 });
    if (doc?.error) return doc;
    
    const nodeResult = await sendCDPCommand(tabId, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: selector
    });
    
    if (!nodeResult?.nodeId) {
      return { error: `Element not found: ${selector}` };
    }
    
    await sendCDPCommand(tabId, 'DOMDebugger.setDOMBreakpoint', {
      nodeId: nodeResult.nodeId,
      type: type // 'subtree-modified', 'attribute-modified', 'node-removed'
    });
    
    return { success: true, selector, type };
  } catch (error) {
    return { error: error.message };
  }
}

async function removeDOMBreakpoint(tabId, selector, type = 'subtree-modified') {
  try {
    const doc = await sendCDPCommand(tabId, 'DOM.getDocument', { depth: 0 });
    if (doc?.error) return doc;
    
    const nodeResult = await sendCDPCommand(tabId, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: selector
    });
    
    if (!nodeResult?.nodeId) {
      return { error: `Element not found: ${selector}` };
    }
    
    await sendCDPCommand(tabId, 'DOMDebugger.removeDOMBreakpoint', {
      nodeId: nodeResult.nodeId,
      type: type
    });
    
    return { success: true, selector, type };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP CSS Coverage
async function startCSSCoverage(tabId) {
  try {
    await enableCDPDomain(tabId, 'CSS');
    await sendCDPCommand(tabId, 'CSS.startRuleUsageTracking');
    return { success: true, message: 'CSS coverage tracking started' };
  } catch (error) {
    return { error: error.message };
  }
}

async function stopCSSCoverage(tabId) {
  try {
    const result = await sendCDPCommand(tabId, 'CSS.stopRuleUsageTracking');
    return { success: true, coverage: result };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP JS Coverage
async function startJSCoverage(tabId) {
  try {
    await enableCDPDomain(tabId, 'Profiler');
    await sendCDPCommand(tabId, 'Profiler.startPreciseCoverage', {
      callCount: true,
      detailed: true
    });
    return { success: true, message: 'JS coverage tracking started' };
  } catch (error) {
    return { error: error.message };
  }
}

async function stopJSCoverage(tabId) {
  try {
    const result = await sendCDPCommand(tabId, 'Profiler.takePreciseCoverage');
    await sendCDPCommand(tabId, 'Profiler.stopPreciseCoverage');
    return { success: true, coverage: result };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP Runtime - Console
async function getCDPConsoleLogs(tabId) {
  try {
    await enableCDPDomain(tabId, 'Runtime');
    // Console messages are collected via events
    // Return stored messages
    return { logs: consoleLogs.get(tabId) || [] };
  } catch (error) {
    return { error: error.message };
  }
}

let consoleLogs = new Map(); // tabId -> logs[]

// CDP Performance metrics
async function getPerformanceMetrics(tabId) {
  try {
    await enableCDPDomain(tabId, 'Performance');
    const metrics = await sendCDPCommand(tabId, 'Performance.getMetrics');
    return { metrics: metrics?.metrics || [] };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP Accessibility
async function getAccessibilityTree(tabId, selector) {
  try {
    await enableCDPDomain(tabId, 'Accessibility');
    await enableCDPDomain(tabId, 'DOM');
    
    let nodeId = null;
    if (selector) {
      const doc = await sendCDPCommand(tabId, 'DOM.getDocument', { depth: 0 });
      const nodeResult = await sendCDPCommand(tabId, 'DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector
      });
      nodeId = nodeResult?.nodeId;
    }
    
    const tree = await sendCDPCommand(tabId, 'Accessibility.getFullAXTree', {
      depth: 3,
      max_depth: 3
    });
    
    return { tree: tree?.nodes?.slice(0, 50) || [] };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP Layer info
async function getLayerTree(tabId) {
  try {
    await enableCDPDomain(tabId, 'LayerTree');
    const layers = await sendCDPCommand(tabId, 'LayerTree.getLayers');
    return { layers: layers?.layers || [] };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP Animation
async function getAnimations(tabId) {
  try {
    await enableCDPDomain(tabId, 'Animation');
    // Animations are tracked via events
    return { animations: animations.get(tabId) || [] };
  } catch (error) {
    return { error: error.message };
  }
}

let animations = new Map();

// Handle debugger events
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  
  // Network events
  if (method === 'Network.requestWillBeSent') {
    const requests = networkRequests.get(tabId) || [];
    requests.push({
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      timestamp: params.timestamp,
      type: params.type,
      initiator: params.initiator?.type
    });
    if (requests.length > 100) requests.shift();
    networkRequests.set(tabId, requests);
  }
  
  if (method === 'Network.responseReceived') {
    const requests = networkRequests.get(tabId) || [];
    const req = requests.find(r => r.requestId === params.requestId);
    if (req) {
      req.status = params.response.status;
      req.statusText = params.response.statusText;
      req.mimeType = params.response.mimeType;
      req.responseTime = params.timestamp;
    }
  }
  
  // Console events
  if (method === 'Runtime.consoleAPICalled') {
    const logs = consoleLogs.get(tabId) || [];
    logs.push({
      type: params.type,
      args: params.args?.map(a => a.value || a.description || a.type).slice(0, 5),
      timestamp: params.timestamp,
      stackTrace: params.stackTrace?.callFrames?.[0]
    });
    if (logs.length > 100) logs.shift();
    consoleLogs.set(tabId, logs);
  }
  
  // Exception events
  if (method === 'Runtime.exceptionThrown') {
    const logs = consoleLogs.get(tabId) || [];
    logs.push({
      type: 'error',
      exception: params.exceptionDetails?.text,
      description: params.exceptionDetails?.exception?.description?.slice(0, 200),
      url: params.exceptionDetails?.url,
      lineNumber: params.exceptionDetails?.lineNumber,
      timestamp: params.timestamp
    });
    consoleLogs.set(tabId, logs);
  }
  
  // Animation events
  if (method === 'Animation.animationCreated' || method === 'Animation.animationStarted') {
    const anims = animations.get(tabId) || [];
    anims.push({
      id: params.id || params.animation?.id,
      name: params.animation?.name,
      type: params.animation?.type,
      duration: params.animation?.source?.duration,
      delay: params.animation?.source?.delay
    });
    if (anims.length > 50) anims.shift();
    animations.set(tabId, anims);
  }
});

// Cleanup on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  if (debuggerAttached.has(tabId)) {
    debuggerAttached.delete(tabId);
  }
  networkRequests.delete(tabId);
  consoleLogs.delete(tabId);
  animations.delete(tabId);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  console.log(`Debugger detached from tab ${source.tabId}: ${reason}`);
  debuggerAttached.delete(source.tabId);
});

// ============ EVENT LISTENERS ============
chrome.runtime.onConnectExternal.addListener((port) => {
  port.onMessage.addListener(async (message) => {
    const result = await handleMessage(message, port.sender);
    port.postMessage(result);
  });
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId === 0) {
    chrome.storage.local.get('isRecording', ({ isRecording }) => {
      if (isRecording) {
        chrome.storage.local.get('recordLog', ({ recordLog = [] }) => {
          recordLog.push({
            type: 'NAVIGATION',
            details: `Page loaded: ${details.url}`,
            timestamp: Date.now(),
            url: details.url
          });
          chrome.storage.local.set({ recordLog });
        });
      }
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && mcpServerRunning && mcpWebSocket) {
    try {
      mcpWebSocket.send(JSON.stringify({
        type: 'page_changed',
        url: tab.url,
        title: tab.title
      }));
    } catch (e) {
      console.error('Failed to send page_changed:', e);
    }
  }
});

// Service worker keepalive - prevent idle termination
// Chrome can suspend service workers after ~30s of inactivity
chrome.alarms.create('keepalive', { periodInMinutes: 0.25 }); // Every 15 seconds
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // Check connection status and attempt reconnect if needed
    if (shouldReconnect && !mcpServerRunning && !reconnectTimer) {
      console.log('Alarm triggered reconnection attempt');
      startMCPServer(mcpPort, mcpHost);
    }
  }
});

console.log('Apex Agent started');
