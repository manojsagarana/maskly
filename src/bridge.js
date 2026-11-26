(function () {
  if (window.__masklyBridgeInstalled) return;
  window.__masklyBridgeInstalled = true;

  const pending = new Map();
  let requestId = 0;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "maskly-extension") return;
    const message = event.data;
    const resolve = pending.get(message.requestId);
    if (!resolve) return;
    pending.delete(message.requestId);
    resolve(message.result);
  });

  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const request = new Request(input, init);
    if (!shouldProtect(request.url)) return originalFetch.apply(this, arguments);

    const pageConversationId = getConversationIdFromUrl();
    if (!request.body || !isTextRequest(request)) {
      const response = await originalFetch.apply(this, arguments);
      return restoreResponse(response, pageConversationId);
    }

    const originalBody = await request.clone().text();
    const conversationId = getConversationId(originalBody) || pageConversationId;
    const maskResult = await maskRequestBody(originalBody, conversationId);
    if (!maskResult?.ok) throw new Error("Maskly could not protect this request");
    if (!maskResult.changed) {
      // The request may contain no new PII while its response still contains
      // placeholders from an earlier turn or from conversation history.
      const response = await originalFetch.apply(this, arguments);
      return restoreResponse(response, conversationId);
    }

    let response;
    if (input instanceof Request) {
      response = await originalFetch.call(this, new Request(request, { body: maskResult.text }));
    } else {
      response = await originalFetch.call(this, input, { ...(init || {}), body: maskResult.text });
    }
    return restoreResponse(response, conversationId);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__masklyUrl = new URL(url, location.href).href;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (!shouldProtect(this.__masklyUrl) || typeof body !== "string") return originalSend.call(this, body);
    const conversationId = getConversationId(body) || getConversationIdFromUrl();
    maskRequestBody(body, conversationId).then((result) => {
      if (!result?.ok) { this.abort(); return; }
      originalSend.call(this, result?.changed ? result.text : body);
    }).catch(() => this.abort());
  };

  async function restoreResponse(response, conversationId) {
    const contentType = response.headers.get("content-type") || "";
    if (!/json|text|javascript|xml/.test(contentType)) return response;
    const body = await response.clone().text();
    if (!hasPlaceholder(body)) return response;
    const responseConversationId = getConversationId(body) || conversationId || getConversationIdFromUrl();
    const restoreResult = await askExtension("RESTORE_REQUEST", body, responseConversationId);
    if (!restoreResult?.text || restoreResult.text === body) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(restoreResult.text, { status: response.status, statusText: response.statusText, headers });
  }

  function askExtension(type, text, conversationId) {
    const id = `ns-${Date.now()}-${++requestId}`;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      window.postMessage({ source: "maskly-page", type, requestId: id, text, conversationId }, "*");
      window.setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        resolve({ ok: false, text, error: "Maskly bridge unavailable" });
      }, 5000);
    });
  }

  async function maskRequestBody(body, conversationId) {
    const isJson = looksLikeJson(body);
    const result = await askExtension(isJson ? "MASK_JSON_REQUEST" : "MASK_REQUEST", body, conversationId);
    if (!result?.ok || !isJson || !result.changed) return result;
    try {
      JSON.parse(result.text);
      return result;
    } catch (error) {
      console.error("Maskly stopped an invalid masked JSON request", error);
      return { ok: false, error: "Masked request was not valid JSON" };
    }
  }

  function looksLikeJson(body) {
    const trimmed = body.trim();
    if (!trimmed || !["{", "["].includes(trimmed[0])) return false;
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }

  function hasPlaceholder(value) {
    return typeof value === "string" && /(?:NS_)?(?:PERSON|EMAIL|PHONE|IP_ADDRESS|CREDIT_CARD|API_KEY|CUSTOM)_\d+/.test(value);
  }

  function isTextRequest(request) {
    const contentType = request.headers.get("content-type") || "";
    return !contentType || /json|text|x-www-form-urlencoded/.test(contentType);
  }

  function getConversationId(body) {
    if (typeof body !== "string") return null;
    const match = body.match(/"(?:conversation_id|conversationId)"\s*:\s*"([^"]+)"/);
    return match?.[1] || null;
  }

  function getConversationIdFromUrl() {
    const match = location.pathname.match(/\/c\/([^/]+)/);
    return match?.[1] || null;
  }

  function shouldProtect(url) {
    try {
      const hostname = new URL(url, location.href).hostname;
      return /(^|\.)(chatgpt\.com|openai\.com|gemini\.google\.com|claude\.ai|perplexity\.ai|poe\.com)$/.test(hostname);
    } catch {
      return false;
    }
  }
})();
