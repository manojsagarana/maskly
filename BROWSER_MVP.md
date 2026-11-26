# Maskly browser MVP

This repository now includes a local-first Manifest V3 browser extension for protecting browser-based AI conversations.

## Install locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this repository folder.
5. Pin Maskly to the browser toolbar.

There is no build step and no external server dependency.

## Use it

- Focus a text box and click the floating **Prepare** button, or just submit on a supported AI site with automatic protection enabled.
- Or open the extension popup and choose **Protect current input**.
- Automatic protection runs before Send/Submit/Generate actions on common AI sites when enabled.
- The original text remains visible in the AI website input. The request body is masked in the page network layer, and supported text/JSON responses are restored before the page renders them.
- Use **View masked values** to inspect the current conversation's token mapping.
- Add organization names, internal project names, enable/disable PII categories, or other exact values in the settings page.

The MVP detects emails, names in phrases such as “my name is Manoj”, phone numbers, IP addresses, credit-card numbers, common API-key formats, and custom exact values. Mappings are keyed to the AI conversation when a conversation ID is available, encrypted with AES-GCM, and stored in browser extension storage for up to 30 days. If a new conversation begins before the AI assigns its permanent ID, the temporary page mapping is migrated when the streamed response provides that ID. This allows a conversation and its title to be restored after closing and reopening the browser. Original values are not sent to a Maskly server.

This MVP protects browser pages only. It does not intercept native desktop applications, command-line tools, local models, or restricted browser pages such as `chrome://` pages. Fetch interception and response restoration are supported first; some sites using other transport mechanisms may need a dedicated adapter.

## Publish it

For Chrome or Edge, create a ZIP containing `manifest.json` and the extension files, excluding `.git`, then upload it through the browser store's developer dashboard. Chrome's current publishing flow is to register a developer account, choose **Add new item**, and upload the ZIP; the store then provides the listing and privacy-practices forms. See the [Chrome Web Store publishing guide](https://developer.chrome.com/docs/webstore/publish).

Before submitting, host `PRIVACY.md` at a public HTTPS URL, add extension icons and screenshots, explain the broad site-access permission, and test the extension on clean browser profiles. Chrome requires an accurate privacy policy for extensions that handle user data. For Firefox, submit the ZIP/XPI through [addons.mozilla.org](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/).
