(function () {
  const pageSessionId = crypto.randomUUID();
  let settings = null;
  let activeElement = null;
  let toolbar = null;
  let activeConversationId = getConversationIdFromUrl();
  const localTokenMap = new Map();
  const rekeyedConversationIds = new Set();

  initialize();

  async function initialize() {
    const response = await send({ type: "GET_SETTINGS" });
    settings = response.settings;
    installToolbar();
    installListeners();
    installVisibleTextRestoration();
  }

  function installListeners() {
    document.addEventListener("focusin", (event) => {
      if (isEditable(event.target)) {
        activeElement = event.target;
        showToolbar();
      }
    }, true);

    document.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!isEditable(document.activeElement)) hideToolbar();
      }, 200);
    }, true);

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === "PROTECT_ACTIVE_INPUT") {
        prepareActiveInput().then(sendResponse);
        return true;
      }
      if (message.type === "RESTORE_ACTIVE_INPUT") {
        setStatus("The page keeps the original input visible");
        sendResponse({ ok: true });
        return false;
      }
      if (message.type === "CLEAR_CURRENT_SESSION") {
        localTokenMap.clear();
        send({ type: "CLEAR_SESSION", sessionId: resolveMappingSessionId() }).then(sendResponse);
        return true;
      }
      if (message.type === "GET_SESSION_MAP") {
        send({ type: "GET_SESSION_MAP", sessionId: resolveMappingSessionId() }).then(sendResponse);
        return true;
      }
      if (message.type === "RELOAD_SETTINGS") {
        send({ type: "GET_SETTINGS" }).then((response) => {
          settings = response.settings;
          sendResponse({ ok: true });
        });
        return true;
      }
    });

    window.addEventListener("message", async (event) => {
      if (event.source !== window || event.data?.source !== "maskly-page") return;
      const message = event.data;
      if (message.conversationId) {
        activeConversationId = message.conversationId;
        await migratePageMapping(message.conversationId);
      }
      if (message.type === "MASK_REQUEST") {
        const result = await send({ type: "MASK_TEXT", sessionId: resolveMappingSessionId(message.conversationId), text: message.text });
        cacheEntries(result);
        window.postMessage({ source: "maskly-extension", type: "MASK_RESPONSE", requestId: message.requestId, result }, "*");
      }
      if (message.type === "MASK_JSON_REQUEST") {
        const result = await send({ type: "MASK_JSON", sessionId: resolveMappingSessionId(message.conversationId), text: message.text });
        cacheEntries(result);
        window.postMessage({ source: "maskly-extension", type: "MASK_RESPONSE", requestId: message.requestId, result }, "*");
      }
      if (message.type === "RESTORE_REQUEST") {
        const currentSettings = await send({ type: "GET_SETTINGS" });
        let result = currentSettings.settings?.revealResponses ? restoreLocally(message.text) : { ok: true, text: message.text };
        if (currentSettings.settings?.revealResponses && result.text === message.text && hasPlaceholder(message.text)) {
          result = await send({ type: "RESTORE_TEXT", sessionId: resolveMappingSessionId(message.conversationId), text: message.text });
          cacheEntries(result);
        }
        window.postMessage({ source: "maskly-extension", type: "RESTORE_RESPONSE", requestId: message.requestId, result }, "*");
      }
    });
  }

  function installVisibleTextRestoration() {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") queueVisibleCandidate(record.target);
        for (const addedNode of record.addedNodes) queueVisibleCandidateTree(addedNode);
      }
      queueVisibleTextScan();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    queueVisibleCandidateTree(document.body);
    queueVisibleCandidateTree(document.head);
    queueVisibleTextScan();
  }

  let scanTimer = null;
  const visibleCandidates = new Set();

  function queueVisibleCandidate(node) {
    if (node) visibleCandidates.add(node);
  }

  function queueVisibleCandidateTree(node) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      queueVisibleCandidate(node);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.matches?.("textarea, input[type='text'], input[type='search'], input[type='email'], [contenteditable='true']")) queueVisibleCandidate(node);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let child;
    while ((child = walker.nextNode())) queueVisibleCandidate(child);
  }

  function queueVisibleTextScan() {
    if (scanTimer) return;
    scanTimer = true;
    queueMicrotask(() => {
      scanTimer = null;
      restoreVisiblePlaceholders();
    });
  }

  async function restoreVisiblePlaceholders() {
    const candidates = [...visibleCandidates];
    visibleCandidates.clear();
    const textNodes = candidates.filter((node) => node.nodeType === Node.TEXT_NODE && node.isConnected && !node.parentElement?.closest("#maskly-toolbar,script,style,noscript") && hasPlaceholder(node.nodeValue));
    const editableNodes = candidates.filter((node) => node.nodeType === Node.ELEMENT_NODE && node.isConnected && !node.closest("#maskly-toolbar") && node.matches("textarea, input[type='text'], input[type='search'], input[type='email'], [contenteditable='true']"));

    await Promise.all([
      ...textNodes.map(async (textNode) => {
        const result = await restoreTextForUi(textNode.nodeValue);
        if (result.ok && result.text !== textNode.nodeValue && textNode.isConnected) textNode.nodeValue = result.text;
      }),
      ...editableNodes.map(async (element) => {
        const current = element.isContentEditable ? element.innerText : element.value || "";
        if (!hasPlaceholder(current)) return;
        const result = await restoreTextForUi(current);
        if (!result.ok || result.text === current || !element.isConnected) return;
        if (element.isContentEditable) element.innerText = result.text;
        else element.value = result.text;
      })
    ]);
  }

  async function restoreTextForUi(input) {
    const localResult = restoreLocally(input);
    if (localResult.text !== input || !hasPlaceholder(input)) return localResult;
    const storedResult = await send({ type: "RESTORE_TEXT", sessionId: resolveMappingSessionId(), text: input });
    cacheEntries(storedResult);
    return storedResult;
  }

  function cacheEntries(result) {
    for (const entry of result?.entries || []) localTokenMap.set(entry.token, entry.original);
  }

  function restoreLocally(input) {
    let text = input;
    for (const [token, original] of [...localTokenMap.entries()].sort((a, b) => b[0].length - a[0].length)) {
      for (const variant of tokenVariants(token)) text = text.split(variant).join(original);
    }
    return { ok: true, text };
  }

  function hasPlaceholder(value) {
    return typeof value === "string" && /(?:NS_)?(?:PERSON|EMAIL|PHONE|IP_ADDRESS|CREDIT_CARD|API_KEY|CUSTOM)_\d+/.test(value);
  }
  function tokenVariants(token) {
    const inner = token.replace(/^<<|>>$/g, "").replace(/^\[\[|\]\]$/g, "");
    const legacyInner = inner.startsWith("NS_") ? inner : `NS_${inner}`;
    return [...new Set([token, `<<${inner}>>`, `[[${inner}]]`, `<${inner}>`, `&lt;&lt;${inner}&gt;&gt;`, `&lt;${inner}&gt;`, inner, `<<${legacyInner}>>`, `[[${legacyInner}]]`, `<${legacyInner}>`, `&lt;&lt;${legacyInner}&gt;&gt;`, `&lt;${legacyInner}&gt;`, legacyInner])];
  }

  function resolveMappingSessionId(conversationId) {
    if (conversationId) activeConversationId = conversationId;
    return activeConversationId ? `conversation:${activeConversationId}` : `page:${pageSessionId}`;
  }

  function migratePageMapping(conversationId) {
    if (!conversationId || rekeyedConversationIds.has(conversationId)) return Promise.resolve();
    rekeyedConversationIds.add(conversationId);
    return send({
      type: "REKEY_SESSION",
      fromSessionId: `page:${pageSessionId}`,
      toSessionId: `conversation:${conversationId}`
    });
  }

  function getConversationIdFromUrl() {
    const match = location.pathname.match(/\/c\/([^/]+)/);
    return match?.[1] || null;
  }

  function installToolbar() {
    toolbar = document.createElement("div");
    toolbar.id = "maskly-toolbar";
    toolbar.innerHTML = `<span class="ns-status">Maskly</span><button data-action="protect">Prepare</button><button data-action="map">Session map</button>`;
    toolbar.style.cssText = "display:none;position:fixed;z-index:2147483647;right:16px;bottom:16px;padding:8px;gap:6px;align-items:center;border:1px solid #334155;border-radius:10px;background:#0f172a;color:#e2e8f0;font:12px system-ui;box-shadow:0 8px 30px rgba(15,23,42,.35);";
    for (const button of toolbar.querySelectorAll("button")) button.style.cssText = "border:0;border-radius:6px;padding:6px 9px;background:#2563eb;color:white;cursor:pointer;font:inherit;";
    toolbar.querySelector('[data-action="map"]').style.background = "#475569";
    toolbar.addEventListener("click", async (event) => {
      const action = event.target.closest("button")?.dataset.action;
      if (action === "protect") await prepareActiveInput();
      if (action === "map") await showSessionMap();
    });
    document.documentElement.appendChild(toolbar);
  }

  async function prepareActiveInput() {
    const element = activeElement || document.activeElement;
    if (!element || !isEditable(element)) return { ok: false };
    const text = readValue(element);
    if (!text.trim()) return { ok: true, changed: false };
    const result = await send({ type: "MASK_TEXT", sessionId: resolveMappingSessionId(), text });
    cacheEntries(result);
    setStatus(result.changed ? `Ready: ${result.categories.join(", ")}` : "No sensitive data detected");
    return result;
  }

  async function showSessionMap() {
    const result = await send({ type: "GET_SESSION_MAP", sessionId: resolveMappingSessionId() });
    if (!result.ok || !result.entries.length) {
      setStatus("No masked values in this conversation");
      return result;
    }
    const lines = result.entries.map((entry) => `${entry.token} = ${entry.original}`).join("\n");
    window.alert(`Maskly conversation mappings\n\n${lines}`);
    return result;
  }

  function showToolbar() { if (toolbar) toolbar.style.display = "flex"; }
  function hideToolbar() { if (toolbar) toolbar.style.display = "none"; }
  function readValue(element) { return element.isContentEditable ? element.innerText : element.value || ""; }
  function setStatus(message) {
    const status = toolbar?.querySelector(".ns-status");
    if (!status) return;
    status.textContent = message;
    window.setTimeout(() => { if (status) status.textContent = "Maskly"; }, 4000);
  }
  function isEditable(element) {
    return element && (element.tagName === "TEXTAREA" || element.tagName === "INPUT" && ["text", "search", "email"].includes(element.type) || element.isContentEditable);
  }
  function send(message) { return chrome.runtime.sendMessage(message); }
})();
