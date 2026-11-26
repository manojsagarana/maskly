const types = ["PERSON", "EMAIL", "PHONE", "CREDIT_CARD", "API_KEY", "IP_ADDRESS"];

async function initialize() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  const settings = response.settings;
  for (const type of types) document.querySelector(`[data-type="${type}"]`).checked = (settings.enabledTypes || []).includes(type);
  document.querySelector("#revealResponses").checked = settings.revealResponses !== false;
  document.querySelector("#customTerms").value = (settings.customTerms || []).join("\n");
}

document.querySelector("#save").addEventListener("click", async () => {
  const enabledTypes = types.filter((type) => document.querySelector(`[data-type="${type}"]`).checked).concat("CUSTOM");
  const customTerms = document.querySelector("#customTerms").value.split("\n").map((term) => term.trim()).filter(Boolean);
  await chrome.runtime.sendMessage({ type: "SET_SETTINGS", settings: { enabledTypes, revealResponses: document.querySelector("#revealResponses").checked, customTerms } });
  document.querySelector("#status").textContent = "Saved locally.";
});

initialize();
