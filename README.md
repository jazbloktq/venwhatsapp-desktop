# Venwhatsapp Desktop

Venwhatsapp Desktop is an unofficial Windows client for WhatsApp Web. It uses the Tauri desktop shell and adds a system tray, automatic startup, native Windows notifications, and a local history for message edits and deletions.

It is intended for testing and personal use. It loads WhatsApp Web in a WebView2 window and does not connect to WhatsApp's servers independently.

## Features

- Open WhatsApp Web in a normal desktop window or from the system tray.
- Start at Windows sign-in in the tray by default. Launching Venwhatsapp from Start opens the window.
- Keep edited and deleted message history in the app, with the same chat history and drawer experience as the Venwhatsapp browser extension.
- Show Windows notifications for edits and deletions observed live after Venwhatsapp starts. Deletions found only in startup or reconnection history are left out of the drawer and do not trigger notifications.
- Keep WhatsApp's existing login and local message history in the Venwhatsapp WebView2 profile.
- Check GitHub Releases for updates and verify each installer against the release's `SHA256SUMS` before running it.
- Use an English-only interface.

## Install

Download the current Windows installer from the [GitHub Releases page](https://github.com/jazbloktq/venwhatsapp-desktop/releases/latest). The installer adds a Start Menu shortcut and a per-user startup entry. You can turn automatic startup off in Settings → Startup. Closing the window minimizes Venwhatsapp to the tray; use the tray menu to show the window or quit. If the older Venwhatsapp WebView2 wrapper is still open, quit it before the first launch so it releases the shared WhatsApp profile.

The installer uses Microsoft's WebView2 bootstrapper if the runtime is missing. Windows 10 (version 1803 or later) and Windows 11 normally include WebView2. Venwhatsapp Desktop is built with Rust and does not require the .NET runtime.

## Build from source

Build on Windows with Rust and the Microsoft C++ Build Tools. Install the Tauri CLI, then build the NSIS and MSI packages:

```powershell
cargo install tauri-cli --version "^2.0.0" --locked
cargo tauri build --bundles nsis,msi
```

Installers are written under `src-tauri/target/release/bundle/`. The NSIS installer is the recommended download for most users; the MSI package is provided for managed deployment.

## Local data and notifications

WhatsApp session data, including cookies and IndexedDB, is stored locally in the Venwhatsapp WebView2 profile under `%LOCALAPPDATA%\Venwhatsapp Desktop\WebView2`. The app does not upload that profile or its message history to a Venwhatsapp server.

The message logger starts only after WhatsApp Web has finished loading the signed-in chat interface. It uses the bundled WA-JS message events and the same logger used by Venwhatsapp's browser extension. Startup and reconnect history scans do not add missed edits or deletions to the drawer or trigger notifications for changes that happened before the logger was active.

Windows notifications must be enabled in both Venwhatsapp Settings and Windows notification settings. Notification clicks open Venwhatsapp; the message history remains available in the chat drawer. Diagnostic logs are stored at `%LOCALAPPDATA%\Venwhatsapp\logs\venwhatsapp.log`.

## Attribution and licenses

The desktop shell is derived from [whatRust](https://github.com/karem505/whatRust), an MIT-licensed Tauri application. The original MIT license and copyright notice are preserved in [`LICENSE`](LICENSE). The message logger uses WA-JS; its license is included alongside the bundled source in [`src-tauri/resources/venwhatsapp`](src-tauri/resources/venwhatsapp). The `LICENSE-WA-JS.txt` file is also included at the repository root.

Venwhatsapp Desktop is an independent project and is not affiliated with or endorsed by WhatsApp or Meta. WhatsApp is a trademark of Meta Platforms, Inc.
