# Privacy Policy — YouTube Subscriptions Filter

**Last updated:** May 17, 2026

## 1. Overview
**YouTube Subscriptions Filter** is designed to filter the YouTube subscriptions feed (`/feed/subscriptions`) by content type (`All`, `Published videos`, `Live`).

## 2. Data We Collect
This extension **does not collect personal data**.

The extension does not collect, store, or transmit:
- name, email, phone number, or address;
- credentials, passwords, or authentication tokens;
- browsing history outside the described functionality;
- message content, form inputs, or uploads.

## 3. Data Stored Locally
The extension only uses the `storage` permission to locally save the user's selected filter preference.

Example of stored data:
- filter mode (`all`, `videos`, or `lives`).

This data remains in the browser's extension storage and is not sold, shared, or sent to our own servers.

## 4. Permissions and Host Access
- `storage`: saves the selected filter preference.
- `https://www.youtube.com/*` (content script): required to apply filters within the YouTube interface.

The extension operates in the YouTube context and is intended to work on the subscriptions page.

## 5. Network Communication
When needed for filtering behavior, the extension may call YouTube endpoints to classify whether an item is live/stream content.

The extension **does not use remote code** (externally hosted JavaScript or Wasm executed by the extension).

## 6. Data Sharing
We do not sell, rent, or share personal data with third parties.

## 7. Data Retention and Deletion
Because the extension stores only local filter preferences, users can remove this data by:
- clearing extension data in the browser; or
- uninstalling the extension.

## 8. Changes to This Policy
This policy may be updated to reflect functional or legal changes. The latest version will always be available in this file.

## 9. Contact
For privacy questions, use the extension support channel on the Chrome Web Store or the project's official repository.
