const DEFAULT_SETTINGS = {
  enabled: true,
  autoProtect: true,
  revealResponses: true,
  enabledTypes: ["EMAIL", "PHONE", "PERSON", "IP_ADDRESS", "CREDIT_CARD", "API_KEY", "CUSTOM"],
  customTerms: []
};
const MAPPING_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const mappingCache = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get("settings");
  if (!current.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  await cleanupExpiredMappings();
});
chrome.runtime.onStartup.addListener(cleanupExpiredMappings);

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "protect-selection") return;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { type: "PROTECT_ACTIVE_INPUT" });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case "GET_SETTINGS": return { ok: true, settings: await getSettings() };
    case "SET_SETTINGS":
      await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...message.settings } });
      return { ok: true, settings: await getSettings() };
    case "MASK_TEXT": return { ok: true, ...(await maskText(message.sessionId, message.text)) };
    case "MASK_JSON": return { ok: true, ...(await maskJson(message.sessionId, message.text)) };
    case "REKEY_SESSION":
      await rekeyMapping(message.fromSessionId, message.toSessionId);
      return { ok: true };
    case "RESTORE_TEXT": {
      const sessionId = message.sessionId;
      let mapping = await loadMapping(sessionId);
      let text = restoreWithMapping(mapping, message.text);
      if (text === message.text && hasPlaceholder(message.text)) {
        const recovered = await findUnambiguousMapping(message.text, sessionId);
        if (recovered) {
          mapping = recovered;
          text = restoreWithMapping(mapping, message.text);
        }
      }
      return { ok: true, text, entries: getEntries(mapping) };
    }
    case "GET_SESSION_MAP": return { ok: true, entries: await getSessionMap(message.sessionId) };
    case "CLEAR_SESSION": await clearMapping(message.sessionId); return { ok: true };
    default: return { ok: false, error: "Unknown message type" };
  }
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function maskText(sessionId, input, persist = true) {
  if (!sessionId || typeof input !== "string") throw new Error("A session ID and text are required");
  const settings = await getSettings();
  if (!settings.enabled) return { text: input, changed: false, count: 0, categories: [] };
  const enabledTypes = settings.enabledTypes || DEFAULT_SETTINGS.enabledTypes;
  const mapping = await loadMapping(sessionId);
  let text = input;
  for (const [key, token] of Object.entries(mapping.byValue).sort((a, b) => b[0].length - a[0].length)) {
    const separator = key.indexOf(":");
    const original = separator === -1 ? key : key.slice(separator + 1);
    text = text.split(original).join(token);
  }

  const rules = [
    { type: "EMAIL", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
    { type: "API_KEY", regex: /\b(?:sk|pk|ghp|github_pat|xoxb|xoxp)-[A-Za-z0-9_-]{10,}\b/g },
    { type: "IP_ADDRESS", regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, validate: isValidIp },
    { type: "CREDIT_CARD", regex: /\b(?:\d[ -]?){13,19}\b/g, validate: (value) => luhn(value.replace(/[ -]/g, "")) },
    { type: "PHONE", regex: /(?:^|[^\w])((?:\+\d{1,3}[ -]?\d{6,14}|\(?\d{3}\)?[ -]\d{3}[ -]\d{4}))(?!\w)/g, capture: 1 },
    { type: "PERSON", regex: /\b((?:my name is|i am|i'm|name is|name\s*[:=])\s+[A-Za-z][A-Za-z'-]*(?:\s+(?!(?:and|from|in|at|on|with|is|live|work)\b)[A-Za-z][A-Za-z'-]*){0,2})\b/gi, capture: 1, personValue: true }
  ];
  for (const rule of rules) {
    if (!enabledTypes.includes(rule.type)) continue;
    text = text.replace(rule.regex, (...args) => {
      const groups = args.slice(0, -2);
      const fullMatch = groups[0];
      const captured = rule.capture ? groups[rule.capture] : fullMatch;
      const value = rule.personValue ? captured.replace(/^(?:my name is|i am|i'm|name is|name\s*[:=])\s*/i, "") : captured;
      if (!value || rule.validate && !rule.validate(value)) return fullMatch;
      const token = getOrCreateToken(mapping, rule.type, value);
      return rule.personValue ? fullMatch.replace(value, token) : rule.capture ? fullMatch.replace(value, token) : token;
    });
  }
  for (const term of enabledTypes.includes("CUSTOM") ? settings.customTerms || [] : []) {
    if (!term || term.length < 2) continue;
    text = text.replace(new RegExp(escapeRegExp(term), "gi"), (value) => getOrCreateToken(mapping, "CUSTOM", value));
  }
  if (persist) await saveMapping(sessionId, mapping);
  return { text, changed: text !== input, count: Object.keys(mapping.byToken).length, categories: [...new Set(Object.values(mapping.byToken).map((entry) => entry.type))], entries: getEntries(mapping) };
}

async function maskJson(sessionId, input) {
  let document;
  try {
    document = JSON.parse(input);
  } catch {
    throw new Error("Request body is not valid JSON");
  }

  let changed = false;
  async function visit(value) {
    if (typeof value === "string") {
      const result = await maskText(sessionId, value, false);
      changed = changed || result.changed;
      return result.text;
    }
    if (Array.isArray(value)) {
      const output = [];
      for (const item of value) output.push(await visit(item));
      return output;
    }
    if (value && typeof value === "object") {
      const output = {};
      for (const [key, item] of Object.entries(value)) output[key] = await visit(item);
      return output;
    }
    return value;
  }

  const masked = await visit(document);
  const mapping = await loadMapping(sessionId);
  await saveMapping(sessionId, mapping);
  return {
    text: JSON.stringify(masked),
    changed,
    count: Object.keys(mapping.byToken).length,
    categories: [...new Set(Object.values(mapping.byToken).map((entry) => entry.type))],
    entries: getEntries(mapping)
  };
}

async function restoreText(sessionId, input) {
  const mapping = await loadMapping(sessionId);
  return restoreWithMapping(mapping, input);
}

function restoreWithMapping(mapping, input) {
  let text = input;
  for (const [token, entry] of Object.entries(mapping.byToken).sort((a, b) => b[0].length - a[0].length)) {
    for (const variant of tokenVariants(token)) text = text.split(variant).join(entry.original);
  }
  return text;
}

function hasPlaceholder(value) {
  return typeof value === "string" && /(?:NS_)?(?:PERSON|EMAIL|PHONE|IP_ADDRESS|CREDIT_CARD|API_KEY|CUSTOM)_\d+/.test(value);
}

async function findUnambiguousMapping(input, currentSessionId) {
  const fragments = [...new Set(input.match(/(?:NS_)?(?:PERSON|EMAIL|PHONE|IP_ADDRESS|CREDIT_CARD|API_KEY|CUSTOM)_\d+/g) || [])];
  if (!fragments.length) return null;
  const all = await chrome.storage.local.get(null);
  const candidates = [];

  for (const [key, record] of Object.entries(all)) {
    if (!key.startsWith("mapping:") || key === `mapping:${currentSessionId}` || !record?.ciphertext) continue;
    if (record.updatedAt && Date.now() - record.updatedAt > MAPPING_TTL_MS) continue;
    try {
      const mapping = await decryptJson(record);
      const mappedFragments = new Set();
      for (const token of Object.keys(mapping.byToken)) {
        const inner = token.replace(/^<<|>>$/g, "").replace(/^\[\[|\]\]$/g, "");
        if (tokenVariants(token).some((variant) => input.includes(variant))) mappedFragments.add(inner);
      }
      if (!fragments.every((fragment) => mappedFragments.has(fragment))) continue;
      candidates.push({ mapping, restored: restoreWithMapping(mapping, input) });
    } catch {
      // Ignore records that cannot be decrypted with the current extension key.
    }
  }

  if (candidates.length === 1) return candidates[0].mapping;
  const uniqueResults = [...new Map(candidates.map((candidate) => [candidate.restored, candidate.mapping])).values()];
  return uniqueResults.length === 1 ? uniqueResults[0] : null;
}

async function getSessionMap(sessionId) {
  const mapping = await loadMapping(sessionId);
  return getEntries(mapping);
}

function getEntries(mapping) {
  return Object.entries(mapping.byToken).map(([token, entry]) => ({ token, type: entry.type, original: entry.original }));
}

function tokenVariants(token) {
  const inner = token.replace(/^<<|>>$/g, "").replace(/^\[\[|\]\]$/g, "");
  const legacyInner = inner.startsWith("NS_") ? inner : `NS_${inner}`;
  return [...new Set([token, `<<${inner}>>`, `[[${inner}]]`, `<${inner}>`, `&lt;&lt;${inner}&gt;&gt;`, `&lt;${inner}&gt;`, inner, `<<${legacyInner}>>`, `[[${legacyInner}]]`, `<${legacyInner}>`, `&lt;&lt;${legacyInner}&gt;&gt;`, `&lt;${legacyInner}&gt;`, legacyInner])];
}

function getOrCreateToken(mapping, type, original) {
  const key = `${type}:${original}`;
  if (mapping.byValue[key]) {
    const existingToken = mapping.byValue[key];
    if (existingToken.startsWith("[[NS_") && existingToken.endsWith("]]")) {
      const modernToken = `[[${existingToken.slice(5, -2)}]]`;
      if (!mapping.byToken[modernToken] || mapping.byToken[modernToken].original === original) {
        delete mapping.byToken[existingToken];
        mapping.byToken[modernToken] = { type, original };
        mapping.byValue[key] = modernToken;
        return modernToken;
      }
    }
    return existingToken;
  }
  const token = `[[${type}_${String(mapping.nextId++).padStart(3, "0")}]]`;
  mapping.byValue[key] = token;
  mapping.byToken[token] = { type, original };
  return token;
}
function emptyMapping() { return { nextId: 1, byValue: {}, byToken: {} }; }

async function loadMapping(sessionId) {
  if (mappingCache.has(sessionId)) return mappingCache.get(sessionId);
  const key = `mapping:${sessionId}`;
  const stored = await chrome.storage.local.get(key);
  if (!stored[key]) { const mapping = emptyMapping(); mappingCache.set(sessionId, mapping); return mapping; }
  try {
    const mapping = await decryptJson(stored[key]);
    normalizeMappingTokens(mapping);
    mappingCache.set(sessionId, mapping);
    return mapping;
  } catch {
    const mapping = emptyMapping(); mappingCache.set(sessionId, mapping); return mapping;
  }
}

function normalizeMappingTokens(mapping) {
  for (const [token, entry] of Object.entries(mapping.byToken)) {
    if (!token.startsWith("[[NS_") || !token.endsWith("]]")) continue;
    const modernToken = `[[${token.slice(5, -2)}]]`;
    if (mapping.byToken[modernToken] && mapping.byToken[modernToken].original !== entry.original) continue;
    delete mapping.byToken[token];
    mapping.byToken[modernToken] = entry;
    for (const [key, value] of Object.entries(mapping.byValue)) {
      if (value === token) mapping.byValue[key] = modernToken;
    }
  }
}
async function saveMapping(sessionId, mapping) {
  mappingCache.set(sessionId, mapping);
  await chrome.storage.local.set({ [`mapping:${sessionId}`]: { ...(await encryptJson(mapping)), updatedAt: Date.now() } });
}
async function clearMapping(sessionId) { mappingCache.delete(sessionId); await chrome.storage.local.remove(`mapping:${sessionId}`); }

async function rekeyMapping(fromSessionId, toSessionId) {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return;
  const source = await loadMapping(fromSessionId);
  if (!Object.keys(source.byToken).length) return;
  const target = await loadMapping(toSessionId);

  for (const entry of Object.values(source.byToken)) {
    const key = `${entry.type}:${entry.original}`;
    const existingToken = target.byValue[key];
    if (existingToken) {
      // Keep the old token as an alias for messages already received.
      target.byToken[entry.token] = { type: entry.type, original: entry.original };
      continue;
    }
    let token = entry.token;
    if (target.byToken[token] && target.byToken[token].original !== entry.original) {
      token = getOrCreateToken(target, entry.type, entry.original);
    } else {
      target.byValue[key] = token;
      target.byToken[token] = { type: entry.type, original: entry.original };
    }
  }
  target.nextId = Math.max(target.nextId, source.nextId);
  await saveMapping(toSessionId, target);
}

async function cleanupExpiredMappings() {
  const all = await chrome.storage.local.get(null);
  const expired = Object.entries(all).filter(([key, value]) => key.startsWith("mapping:") && Date.now() - (value.updatedAt || 0) > MAPPING_TTL_MS).map(([key]) => key);
  if (expired.length) await chrome.storage.local.remove(expired);
}

async function getEncryptionKey() {
  const currentKeyName = "masklyEncryptionKey";
  const stored = await chrome.storage.local.get(currentKeyName);
  if (stored[currentKeyName]) return crypto.subtle.importKey("raw", fromBase64(stored[currentKeyName]), "AES-GCM", false, ["encrypt", "decrypt"]);

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  await chrome.storage.local.set({ [currentKeyName]: toBase64(await crypto.subtle.exportKey("raw", key)) });
  return key;
}
async function encryptJson(value) {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}
async function decryptJson(record) {
  const key = await getEncryptionKey();
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(record.iv) }, key, fromBase64(record.ciphertext));
  return JSON.parse(new TextDecoder().decode(bytes));
}
function toBase64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
function fromBase64(value) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function isValidIp(value) { return value.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255); }
function luhn(value) {
  if (!/^\d{13,19}$/.test(value)) return false;
  let sum = 0; let doubleDigit = false;
  for (let index = value.length - 1; index >= 0; index--) {
    let digit = Number(value[index]);
    if (doubleDigit) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit; doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
