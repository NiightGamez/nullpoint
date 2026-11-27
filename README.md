# NullPoint

> Zero-server, zero-uptime-cost, client-to-client (P2P) decentralized chat and voice/video platform with local cryptographic accounts.

NullPoint is a Linux-native decentralized communication client inspired by Discord and TeamSpeak. It eliminates central account databases, mandatory dedicated servers, and third-party relays—combining an **Argon2id + ChaCha20-Poly1305 encrypted local identity vault** with embedded **Tor v3 (`arti`)** for private 1:1 Direct Messages and **QUIC P2P (`iroh`)** for low-latency community Servers, voice, video, and screen sharing.

---

## Architecture & Core Features

- **Zero-Server Encrypted Account Vault (`vault.db`):**
  - Accounts are backed locally by an Ed25519 master keypair encrypted at rest via **Argon2id** key derivation and **ChaCha20-Poly1305** authenticated encryption (`rusqlite` bundled SQLite).
  - **Hard to Lose, Hard to Hack:** Includes a 3-tier backup system—encrypted portable `.npkey` recovery files (safe for cloud/USB storage), **1-click Password Manager save/export** (direct 1Password CLI `op` creation or universal Bitwarden/1Password/KeePassXC `.csv` import), and an offline 12-word BIP39 recovery phrase—plus optional opt-in OS Keyring auto-unlock (`keyring`).
- **Embedded Tor v3 Engine (`arti-client`):** Native Rust Tor runtime bootstrapping in-process with zero external daemons for IP-private 1:1 Direct Messages over `.onion` rendezvous circuits.
- **Obsidian Cyberdeck UI:** Single-window Tauri v2 + React + TypeScript interface with live circuit telemetry, custom context menus, and verified Ed25519 `[DEV]` badge pinning.

---

## Tech Stack

- **Desktop Framework:** Tauri v2
- **Backend & Cryptography:** Rust, Tokio, `arti-client` (Tor v3), `ed25519-dalek`, `argon2`, `chacha20poly1305`, `bip39`, `rusqlite` (bundled), `keyring`
- **Frontend:** React, TypeScript, Tailwind CSS

---

## Milestone Status & Roadmap (v0.2.0)

### Completed
- [x] **Encrypted Local Account Vault:** Argon2id + ChaCha20-Poly1305 SQLite vault (`vault.db`) with password-manager-friendly signup, unlock, and recovery.
- [x] **3-Tier Account Recovery & 1-Click Password Manager Export:** Portable `.npkey` encrypted backups, 1Password CLI / universal CSV password manager export, 12-word BIP39 recovery phrase, and opt-in OS Keyring auto-unlock.
- [x] **Standalone Embedded Tor Engine:** Native Rust Arti v0.47 integration bootstrapping in RAM and publishing unredacted 56-character `.onion` hidden service addresses.
- [x] **Two-Tier Inbound Rendezvous Listener:** Nested stream negotiation yielding bidirectional `DataStream` sockets.
- [x] **Obsidian Cyberdeck UI:** Single-window desktop layout, live circuit telemetry indicators, and verified `[DEV]` badge pinning.

### Active Backlog (Next Sprints)
- [ ] **SQLite Message & Contact Persistence:** Wire DMs, contacts, and an offline outbox queue into `vault.db` so chat history persists across restarts.
- [ ] **Transport Framing & Live 2-Node Tor DM Verification:** Add length-prefixed framing (`u32` + JSON) over Arti streams and verify live 1:1 DMs across two nodes.
- [ ] **Self-Hosted / Client-Hosted Servers (`iroh` QUIC P2P):** Multi-channel Discord/TeamSpeak-style rooms with client host toggle, `--headless` daemon mode, and capped SQLite ring buffers.
- [ ] **E2EE Voice, Video & Screen Sharing:** Low-latency peer-to-peer audio, video, and screen streaming over authenticated QUIC channels.

---

## Getting Started

### System Prerequisites
- **Debian / Ubuntu:** `sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`
- **Arch Linux:** `sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget openssl gtk3`

### Local Development & Production Build
1. Install dependencies: `npm install`
2. Start dev environment: `npm run tauri dev`
3. Build release binaries (`.AppImage` & `.deb`): `npm run build && npm run tauri build`

---

## License
This project is licensed under the **GNU Affero General Public License v3 (AGPLv3)** — see [LICENSE](LICENSE) for details.

### Copyleft & Distribution Terms
- **Source Disclosure:** Any party modifying this software or offering it over a network must provide their complete source code under the identical AGPLv3 license.
- **Brand Protection:** The "NullPoint" name, logos, and UI assets are proprietary. Independent forks or redistributions must be rebranded and cannot use the official project identity.
