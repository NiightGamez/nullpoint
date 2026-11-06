# NullPoint

NullPoint is a decentralized, serverless peer-to-peer (P2P) communication platform built with **Tauri v2**, **Rust**, and **React**. It eliminates central servers and third-party relay brokers by routing direct, end-to-end encrypted connections over the **Tor network (v3 hidden services)**.

---

## ⚡ Key Features

* **Serverless P2P Architecture**: Direct node-to-node messaging powered by local socket listeners and background Tor routing.
* **Tor v3 Hidden Services**: Automated bootstrapping via embedded Arti (`tor-client` / `tor-hsservice`). Every instance hosts an unredacted 56-character `.onion` address for NAT traversal and metadata privacy.
* **Cryptographic Identity**: Ed25519 keypair generation on first run. Public keys serve as stable, permanent user identifiers without centralized accounts.
* **Verified Developer Badge**: Native public-key pinning (`VERIFIED_DEV_KEYS`) in the client layer grants cryptographic, unforgeable `[DEV]` badges directly next to verified author messages.
* **One-Click Shareable Invites**: Generates standard `nullpoint://<pubkey>@<onion>.onion` connection URIs with local fallback routing (`127.0.0.1:9876`).
* **Lightweight Linux Desktop Client**: Single-window, low-footprint desktop experience packaged as standalone AppImage and Debian packages.

---

## 🛠️ Roadmap & Known Issues (WIP)

### Under Active Development
- [ ] **Message Persistence**: Store local chat history and direct messages via SQLite / persistent storage across app restarts.
- [ ] **Lobby & Peer Discovery UX**: Remove hardcoded local testing mock fallbacks (`local:9877` / "Beta Client") and replace with an open room browser / neutral connection lobby.
- [ ] **Multi-User Swarms**: Extend 1-to-1 hidden service streams into multi-peer group channels.

### Completed (v0.1.0)
- [x] Tor v3 hidden service integration with unredacted `.onion` invite URIs.
- [x] Ed25519 public-key pinning & verified `[DEV]` badge rendering.
- [x] Native `sender_pubkey` packet schema contract between Rust and TypeScript.
- [x] Single-window Linux AppImage and `.deb` distribution builds.

---

## 🚀 Building & Packaging

### Prerequisites
* **Rust**: `cargo 1.75+`
* **Node.js**: `v18+` & `npm`
* **System Libraries**: `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `libssl-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`

### Development
```bash
npm install
npm run tauri dev
