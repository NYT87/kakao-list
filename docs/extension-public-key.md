# Extension Public Key

Use `EXTENSION_PUBLIC_KEY` when you want the unpacked extension to keep the same Chrome extension ID across local reinstalls.

That matters here because the Kakao extension login callback URI is derived from the extension ID:

```text
https://<extension-id>.chromiumapp.org/kakao
```

If the extension ID changes, that callback URI changes too, and Kakao rejects sign-in until the new URI is registered.

## How To Generate It

### Recommended Method: Chrome Developer Dashboard

1. Build the extension:

```bash
pnpm dev:extension
```

2. Zip the built extension directory:

```text
apps/extension/dist
```

3. Open the Chrome Developer Dashboard:

- <https://chrome.google.com/webstore/devconsole>

4. Add a new item and upload the zip without publishing it.
5. Open the item’s `Package` tab.
6. Click `View public key`.
7. Copy only the text between:

```text
-----BEGIN PUBLIC KEY-----
...
-----END PUBLIC KEY-----
```

8. Remove all line breaks so it becomes one long line.
9. Set that value in your local env file:

```dotenv
EXTENSION_PUBLIC_KEY=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...
```

10. Rebuild the extension and reload it in `chrome://extensions`.

## What Not To Paste

- Do not include `-----BEGIN PUBLIC KEY-----`.
- Do not include `-----END PUBLIC KEY-----`.
- Do not paste a private key.
- Do not invent a random string.

## Verify It Worked

1. Rebuild the extension.
2. Reload the unpacked extension in Chrome.
3. Open `chrome://extensions`.
4. Confirm the extension ID stays the same after reloads or reinstalls.
5. Register the resulting Kakao callback URI in Kakao Developers:

```text
https://<extension-id>.chromiumapp.org/kakao
```

## Alternative Method

Chrome’s docs also describe getting the key from an installed packaged extension:

1. Package or install the extension as a `.crx`.
2. Inspect the installed extension’s `manifest.json`.
3. Copy the generated `key` value.

## Local Generation

Chrome’s official docs point to the Developer Dashboard flow above. The local method below is an inference from that format: `manifest.key` is the one-line body of a PEM public key.

If you want to generate your own stable keypair locally and keep reusing it:

1. Generate a private key:

```bash
mkdir -p .secrets
openssl genrsa -out .secrets/extension-private-key.pem 2048
```

2. Derive the matching public key:

```bash
openssl rsa -in .secrets/extension-private-key.pem -pubout -out .secrets/extension-public-key.pem
```

3. Convert the public key into the single-line value expected by `EXTENSION_PUBLIC_KEY`:

```bash
awk 'NR > 1 && $0 !~ /END PUBLIC KEY/ { printf "%s", $0 }' .secrets/extension-public-key.pem
```

4. Copy that output into `.env.local`:

```dotenv
EXTENSION_PUBLIC_KEY=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...
```

5. Rebuild the extension:

```bash
pnpm bundle:extension
```

Important:

- Keep `.secrets/extension-private-key.pem` private and reuse the same file forever if you want the same extension ID.
- If you lose that private key and generate a new one, the extension ID and Kakao redirect URI will change.
- This local generation workflow is practical, but the Developer Dashboard flow remains the officially documented Chrome path.

## References

- [Chrome Extensions: Manifest `key`](https://developer.chrome.com/docs/extensions/reference/manifest/key)
- [Chrome Apps: Manifest `key`](https://developer.chrome.com/docs/apps/manifest/key/)
