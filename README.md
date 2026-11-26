# Maskly

Maskly is a local-first browser extension that masks sensitive information before it is sent from supported browser-based AI conversations. The AI receives safe placeholders, while the original values remain visible in the page and can be restored in the response.

No Maskly server is required for the browser MVP. Original values and encrypted mappings stay in the browser's extension storage.

## What Maskly protects

The MVP can detect:

- Names in phrases such as `My name is Manoj`
- Email addresses
- Phone numbers
- IP addresses
- Credit-card numbers
- Common API keys
- Custom values that you add in settings

Supported browser AI sites currently include ChatGPT, OpenAI, Gemini, Claude, Perplexity, and Poe. Site behavior can change, so support should be tested after major website updates.

## Requirements

- A desktop Chromium-based browser: Google Chrome or Microsoft Edge
- Access to the Maskly repository
- Developer mode enabled for local installation

GitHub installation is intended for testing and early users. It requires Developer mode. A normal one-click installation will be available after Maskly is published in a browser extension store.

## Install Maskly from GitHub

### Option 1: Download ZIP

1. Open the [Maskly GitHub repository](https://github.com/manojsagarana/maskly).
2. Select **Code**.
3. Select **Download ZIP**.
4. Extract the ZIP to a permanent folder. Do not load the ZIP file itself.
5. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
6. Enable **Developer mode**.
7. Select **Load unpacked**.
8. Select the extracted Maskly folder—the folder must contain `manifest.json` directly.
9. Pin **Maskly** to the browser toolbar from the Extensions menu.

### Option 2: Clone with Git

Users who have Git installed can run:

```bash
git clone https://github.com/manojsagarana/maskly.git
```

Then open the extensions page, choose **Load unpacked**, and select the cloned folder.

There is currently no build step and no package installation required.

## First-time setup

1. Open the Maskly extension popup.
2. Confirm that **Protection enabled** is on.
3. Keep **Auto-protect AI sites** enabled for automatic masking.
4. Open **PII types and custom rules**.
5. Enable the categories you want to protect.
6. Add private values that automatic detection may not recognize, such as:

   ```text
   Project Falcon
   Internal customer name
   Company account identifier
   ```

7. Keep **Restore placeholders in AI responses** enabled if you want the original values displayed in the AI page.
8. Save the settings.

## Use Maskly

1. Open a supported AI website.
2. Type a prompt containing test data, for example:

   ```text
   My name is Manoj and my phone number is +91 9876543210.
   ```

3. Submit the prompt normally.
4. The page should continue to show the original text.
5. The request sent to the AI should contain placeholders such as:

   ```text
   My name is [[PERSON_001]] and my phone number is [[PHONE_002]].
   ```

6. The AI response should be restored in the page when response restoration is enabled.
7. Use **View masked values** in the Maskly popup to inspect the current conversation mapping.

## Verify that masking works

1. Open browser Developer Tools with `F12`.
2. Open the **Network** tab.
3. Send a test prompt containing an email, phone number, or custom value.
4. Select the latest `conversation` request.
5. In **Payload**, search for a placeholder such as `[[PERSON_001]]`.
6. Confirm that the request contains placeholders, not the original value.
7. Open **EventStream**, **Response**, or **Preview** for the same request.
8. The streamed AI response may also contain placeholders. This is expected and is the privacy-safe network view.
9. Confirm that the visible AI page displays the original value after Maskly restores it.

The browser Network panel is expected to show masked data. Maskly restores values for the webpage, not inside Developer Tools.

## Storage and privacy

- Original values are processed locally by the extension.
- Mappings are encrypted with AES-GCM.
- Mappings are stored in browser extension storage for up to 30 days.
- Mappings are associated with the AI conversation when a conversation ID is available.
- No prompt content is sent to a Maskly server in this MVP.
- Closing and reopening the browser normally preserves mappings.
- Clearing extension data, removing the extension, deleting the browser profile, or using a temporary/private profile can remove mappings.
- Temporary AI chats may not be retained by the AI provider itself.

Read the complete [privacy notice](PRIVACY.md) before distributing Maskly.

## Updating Maskly from GitHub

### ZIP installation

1. Download the latest ZIP from GitHub.
2. Extract it to a new folder.
3. Open `chrome://extensions` or `edge://extensions`.
4. Select **Reload** on Maskly, or remove the old unpacked installation and load the new folder.
5. Refresh open AI tabs.

Keep the existing extension installation when possible so its local encrypted storage remains associated with the extension. Export and import backup support should be added before users regularly replace installations or browser profiles.

### Git installation

From the cloned repository folder:

```bash
git pull
```

Then select **Reload** on the extensions page and refresh the AI tab.

## Troubleshooting

### Maskly does not appear in the browser

Make sure Developer mode is enabled and that the selected folder contains `manifest.json` directly.

### The page still shows placeholders

1. Open the extensions page.
2. Select **Reload** for Maskly.
3. Refresh the AI website.
4. Check that **Restore placeholders in AI responses** is enabled.
5. Use **View masked values** to confirm that the conversation mapping exists.

### The request is blocked

Check the browser console for a Maskly error. Do not disable protection for real sensitive data while troubleshooting; first test with dummy values and reload the extension and page.

### A reopened chat cannot restore values

The mapping may have expired, been cleared, or been created by an older build whose temporary session data no longer exists. Send a new protected message after installing the latest version and verify the mapping before closing the browser.

### ChatGPT or another AI site changes its network format

Maskly is a browser-side adapter and depends on the site's request and response format. A site update may require a new adapter implementation.

## Remove Maskly

1. Open `chrome://extensions` or `edge://extensions`.
2. Find Maskly.
3. Select **Remove**.
4. Confirm removal.

Removing the extension can delete its local encrypted mappings. Save any information you need before removing it.