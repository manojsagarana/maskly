let currentTab; let settings;
initialize();
async function initialize() {
  currentTab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" }); settings = response.settings;
  document.querySelector("#enabled").checked = settings.enabled; document.querySelector("#autoProtect").checked = settings.autoProtect;
  document.querySelector("#enabled").addEventListener("change", (event) => update({ enabled: event.target.checked }));
  document.querySelector("#autoProtect").addEventListener("change", (event) => update({ autoProtect: event.target.checked }));
  document.querySelector("#protect").addEventListener("click", () => sendToTab({ type: "PROTECT_ACTIVE_INPUT" }));
  document.querySelector("#map").addEventListener("click", () => sendToTab({ type: "GET_SESSION_MAP" }));
  document.querySelector("#clear").addEventListener("click", () => sendToTab({ type: "CLEAR_CURRENT_SESSION" })); setStatus("Ready");
}
async function update(changes) { settings = (await chrome.runtime.sendMessage({ type: "SET_SETTINGS", settings: { ...settings, ...changes } })).settings; if (currentTab?.id) chrome.tabs.sendMessage(currentTab.id, { type: "RELOAD_SETTINGS" }).catch(() => {}); setStatus("Settings saved"); }
async function sendToTab(message) { if (!currentTab?.id) return; try { const result = await chrome.tabs.sendMessage(currentTab.id, message); if (message.type === "CLEAR_CURRENT_SESSION") setStatus(result?.ok ? "Mappings cleared" : "Could not clear mappings"); else if (message.type === "GET_SESSION_MAP") showSessionMap(result); else setStatus(result?.changed ? "Protection ready" : result?.ok ? "No changes needed" : "Focus an input first"); } catch { setStatus("This page does not allow extensions"); } }
function showSessionMap(result) { if (!result?.entries?.length) { setStatus("No masked values in this conversation"); return; } window.alert(`Maskly conversation mappings\n\n${result.entries.map((entry) => `${entry.token} = ${entry.original}`).join("\n")}`); }
function setStatus(message) { document.querySelector("#status").textContent = message; }
