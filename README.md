# NullPoint

> Zero-server, zero-uptime-cost, client-to-client (P2P) decentralized chat with cryptographic identity.

NullPoint is a Linux-native messaging client inspired by modern chat platforms. It eliminates central server relays, account databases, and third-party infrastructure. All routing is performed directly between peer instances over UDP using cryptographic public keys and automated STUN NAT traversal.

---

## Architecture & Core Features

- **Decentralized Direct Messaging:** Direct 1:1 packet routing between peer endpoints.
- **Swarm Mesh Servers:** Multi-user group chat rooms utilizing client-relayed server instances.
- **Cryptographic Identities:** Local Ed25519 keypair generation with shareable mesh:// URI invites.
- **Automated STUN NAT Traversal:** Built-in sequential STUN failover pool (Cloudflare, Google, Nextcloud) to automatically discover public WAN endpoints without manual port forwarding.
- **Desktop Interface:** Discord-inspired dark UI with custom context menus, channel management, and unread badges.

---

## Tech Stack

- **Desktop Framework:** Tauri v2
- **Backend / Networking:** Rust, Tokio (UDP async runtime), ed25519-dalek
- **Frontend:** React, TypeScript, Tailwind CSS

---

## Getting Started

### System Prerequisites

Install standard WebKitGTK and build tools:

- **Debian / Ubuntu:** sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
- **Arch Linux:** sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget openssl gtk3

### Local Development

1. Install dependencies: npm install
2. Start Vite and dual loopback nodes: npm run tauri dev

---

## License

This project is open-source and available under the [GNU Affero General Public License v3 (AGPLv3)](LICENSE).

### Copyleft & Distribution Terms
- **Source Disclosure:** Any party modifying this software or offering it over a network must provide their complete source code under the identical AGPLv3 license.
- **Brand Protection:** The "NullPoint" name, logos, and UI assets are proprietary. Independent forks or redistributions must be rebranded and cannot use the official project identity.
