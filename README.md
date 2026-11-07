# NullPoint

NullPoint is a zero-trust, metadata-resistant communication platform and sovereign cyberdeck terminal built with **Tauri v2**, **Rust**, and **React**. It eliminates central servers and third-party relay brokers by routing direct, end-to-end encrypted connections over the **Tor network (v3 hidden services)** with support for optional self-hosted community nodes ("Decks").

---

## 🤖 AI-Assisted Architecture & "Vibe Coding" Transparency

NullPoint was designed, scaffolded, and implemented using **AI pair-programming and vibe coding workflows** (collaborating with large language models to architect systems, debug compiler errors, and navigate bleeding-edge Rust crates). 

While AI generated substantial portions of the boilerplate, integration logic, and interface scaffolding, every component—from Arti's nested circuit streams to cryptographic Ed25519 identity schemes and SQLite transaction layers—is actively reviewed, tested, hardened, and maintained by human engineering. This repository stands as a transparent showcase of what modern human-in-the-loop AI software engineering can achieve when pushing unstable, cutting-edge protocol stacks.

---

## 🤝 Community & Contributions

Contributions, bug reports, and discussions from other developers and tinkerers are welcome! 

Whether you want to optimize Tor circuit stream handling, refine the SQLite persistence layer, or enhance the React cyberdeck frontend, pull requests and issues are encouraged. Note that all proposed contributions, architectural changes, and feature merges will be reviewed and approved at my discretion to maintain the project's core vision, security model, and sovereign UX aesthetic.

---

## 🏗️ Architecture & Topology

NullPoint balances direct, sovereign peer-to-peer circuits with personal self-hosted nodes to support asynchronous offline messaging and group rooms without centralized infrastructure:

```text
                  ┌────────────────────────┐
                  │    NullPoint Client    │
                  │  (Obsidian Cyberdeck)  │
                  └───────────┬────────────┘
                              │ Tauri IPC
                  ┌───────────▼────────────┐
                  │      Rust Backend      │
                  │   (Arti + HS + SQLite) │
                  └─────┬────────────┬─────┘
       Direct 1:1 Dial  │            │  Relay / Channel Subscription
                        ▼            ▼
         [ Peer Client Node ]       [ Self-Hosted "Deck" Node ]
          (Live Ephemeral DM)        (24/7 Headless Room & Mailbox)
```

---

## ⚡ Key Features

* **Serverless P2P Architecture:** Direct node-to-node messaging powered by embedded background Tor routing.
* **Native Embedded Tor v3 Services:** Automated bootstrapping via embedded Arti (`arti-client` / `tor-hsservice` v0.47). Every instance runs an unredacted 56-character `.onion` hidden service for NAT traversal and metadata privacy.
* **Cryptographic Identity Layer:** Ed25519 keypair generation and verification. Public keys serve as permanent, cryptographic user identifiers.
* **Deterministic Addressing:** One-click shareable connection URIs formatted as `nullpoint://<ed25519_pubkey>@<hsid>.onion`.
* **Two-Tier Rendezvous Acceptor:** Custom nested inbound listener handling `RendezvousRequest` down to `StreamRequest` with `Connected` relay cells.
* **Obsidian Cyberdeck Interface:** Monospace desktop layout with tactile circuit telemetry, real-time event monitoring (`tor_onion_ready`), and single-instance window layout.

---

## 🛠️ Tech Stack

* **Desktop Framework:** Tauri v2
* **Backend Runtime:** Rust, Tokio (async runtime), `arti-client` (v0.47), `tor-hsservice` (v0.47), `tor-cell` (v0.47)
* **Cryptography & Data:** `ed25519-dalek`, `rusqlite` (bundled SQLite persistence)
* **Frontend:** React, TypeScript, Tailwind CSS

---

## 🗺️ Milestone Status & Roadmap

### Completed Milestones
- [x] **Standalone Embedded Tor Engine:** Native Rust Arti integration running directly in-process without external Tor daemon/SOCKS proxies.
- [x] **Cryptographic Identity Schema:** Ed25519 keypair generation and packet signing contract between Rust and TypeScript.
- [x] **Two-Tier Inbound Rendezvous Listener:** Nested stream negotiation yielding bidirectional DataStream sockets.
- [x] **Obsidian Cyberdeck UI:** Single-window desktop layout, live circuit telemetry indicators, and status event feeds.

### 📋 Active Backlog & Future Tasks

#### Phase 1: Transport Hardening & End-to-End Verification
- [ ] **Stream Framing & EOF Handling:** Implement explicit write stream closures (AsyncWriteExt::close) and length-prefixed packet framing to prevent reader hangs.
- [ ] **Dual-Node Live Rendezvous Verification:** Validate live message passing across two isolated physical/VM clients over public Tor circuits.
- [ ] **Storage & Keystore Sandboxing:** Isolate SQLite databases and Arti keystores per client profile using app_data_dir().

#### Phase 2: Self-Hosted Community Nodes ("Decks")
- [ ] **Headless Daemon Target (--headless):** Run the Rust backend as a lightweight CLI binary on 24/7 low-resource environments (Raspberry Pi, VPS).
- [ ] **Ephemeral Channel Ring Buffers:** Bounded SQLite retention (FIFO cap of 500–1,000 messages, 7-day TTL auto-purge, zero server-side file retention).
- [ ] **Store-and-Forward Mailbox Queue:** Encrypted message drops held temporarily by community nodes until offline peers reconnect.

#### Phase 3: Real-Time Media & Mobile Companion Support
- [ ] **Tor-Signaled WebRTC Voice/Video:** Route SDP offers and ICE candidates through Tor circuits to negotiate direct end-to-end encrypted UDP media streams.
- [ ] **Mobile Companion Protocol:** Client-only mobile pairing model using blind-token push gateways to bypass mobile background Tor restrictions.

---

## 🚀 Getting Started

### System Prerequisites

Install standard WebKitGTK and build tools:

**Debian / Ubuntu:**
```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```

**Arch Linux:**
```bash
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget openssl gtk3
```

### Development
```bash
npm install
npm run tauri dev
```

### Production Build
```bash
npm run build
npm run tauri build
```

---

## 📜 License & Terms of Use

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**:

* **Source Code & Network Engine:** All code, network transport mechanisms, and build logic are free software licensed under **AGPLv3**. Anyone modifying, self-hosting, or interacting with the network software must keep all derivative works open-source under the exact same AGPL terms.
* **Brand Identity & Creative Design (All Rights Reserved):** The "NullPoint" brand name, custom logos, visual design identity, and distinct UI styling are **© 2026 Michael Voorhies. All Rights Reserved.** The AGPL license grants rights to the software codebase, but does not grant permission to use the brand name or proprietary visual assets for separate distributions without authorization.
