use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tokio::net::UdpSocket;
use tokio::time::timeout;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind")]
pub enum Packet {
    #[serde(rename = "dm")]
    DirectMessage {
        id: String,
        sender_pubkey: String,
        sender_alias: String,
        recipient_pubkey: String,
        text: String,
        timestamp: String,
    },
    #[serde(rename = "server")]
    ServerMessage {
        id: String,
        room_id: String,
        channel: String,
        sender_alias: String,
        text: String,
        timestamp: String,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NodeIdentity {
    pub label: String,
    pub local_port: u16,
    pub target_port: u16,
    pub pubkey: String,
    pub shareable_invite: String,
    pub alias: String,
    pub target_alias: String,
    pub wan_endpoint: Option<String>,
}

pub struct SocketsState {
    pub main_socket: Arc<UdpSocket>, // port 9876
    pub peer_socket: Arc<UdpSocket>, // port 9877
    pub main_wan: Arc<tokio::sync::Mutex<Option<SocketAddr>>>,
}

// Minimal RFC 5389 STUN Binding Request header (20 bytes)
fn create_stun_request() -> [u8; 20] {
    let mut req = [0u8; 20];
    req[0] = 0x00; // Binding Request
    req[1] = 0x01;
    req[2] = 0x00; // Length: 0 attributes
    req[3] = 0x00;
    req[4..8].copy_from_slice(&0x2112A442u32.to_be_bytes()); // Magic Cookie
    for b in &mut req[8..20] {
        *b = rand::random();
    }
    req
}

fn parse_stun_response(buf: &[u8]) -> Option<SocketAddr> {
    if buf.len() < 20 || buf[0] != 0x01 || buf[1] != 0x01 {
        return None;
    }

    let magic_cookie = 0x2112A442u32;
    let mut offset = 20;

    while offset + 4 <= buf.len() {
        let attr_type = u16::from_be_bytes([buf[offset], buf[offset + 1]]);
        let attr_len = u16::from_be_bytes([buf[offset + 2], buf[offset + 3]]) as usize;
        offset += 4;

        if offset + attr_len > buf.len() {
            break;
        }

        if attr_type == 0x0020 && attr_len >= 8 {
            let family = buf[offset + 1];
            if family == 0x01 {
                let raw_port = u16::from_be_bytes([buf[offset + 2], buf[offset + 3]]);
                let port = raw_port ^ ((magic_cookie >> 16) as u16);
                let raw_ip = u32::from_be_bytes([
                    buf[offset + 4],
                    buf[offset + 5],
                    buf[offset + 6],
                    buf[offset + 7],
                ]);
                let ip = std::net::Ipv4Addr::from(raw_ip ^ magic_cookie);
                return Some(SocketAddr::new(std::net::IpAddr::V4(ip), port));
            }
        }
        offset += (attr_len + 3) & !3;
    }
    None
}

async fn resolve_stun_pool(socket: &UdpSocket, servers: &[&str]) -> Option<SocketAddr> {
    let req = create_stun_request();
    let mut buf = vec![0u8; 1024];

    for server in servers {
        if let Ok(mut addrs) = tokio::net::lookup_host(server).await {
            if let Some(target) = addrs.next() {
                if socket.send_to(&req, target).await.is_ok() {
                    if let Ok(Ok((len, _))) =
                        timeout(Duration::from_millis(800), socket.recv_from(&mut buf)).await
                    {
                        if let Some(addr) = parse_stun_response(&buf[..len]) {
                            println!("[STUN] Resolved via {}: WAN = {}", server, addr);
                            return Some(addr);
                        }
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
async fn init_node(
    window: Window,
    state: State<'_, SocketsState>,
) -> Result<NodeIdentity, String> {
    let label = window.label().to_string();
    let is_peer = label == "peer";

    let mut csprng = OsRng;
    let signing_key = SigningKey::generate(&mut csprng);
    let pubkey_bytes = signing_key.verifying_key().to_bytes();
    let pubkey_str = format!("ed25519_{}", B64.encode(pubkey_bytes));

    let (local_port, target_port, alias, target_alias) = if is_peer {
        (9877, 9876, "Beta Client", "Alpha Host")
    } else {
        (9876, 9877, "Alpha Host", "Beta Client")
    };

    let wan_lock = state.main_wan.lock().await;
    let wan_endpoint = wan_lock.map(|a| a.to_string());

    let invite_addr = wan_endpoint
        .clone()
        .unwrap_or_else(|| format!("127.0.0.1:{}", local_port));

    let invite = format!("mesh://{}@{}", pubkey_str, invite_addr);

    Ok(NodeIdentity {
        label,
        local_port,
        target_port,
        pubkey: pubkey_str,
        shareable_invite: invite,
        alias: alias.into(),
        target_alias: target_alias.into(),
        wan_endpoint,
    })
}

#[tauri::command]
async fn send_packet(
    window: Window,
    target_addr: String,
    packet: Packet,
    state: State<'_, SocketsState>,
) -> Result<Packet, String> {
    let serialized = serde_json::to_vec(&packet).map_err(|e| e.to_string())?;
    let label = window.label();

    let socket = if label == "peer" {
        state.peer_socket.clone()
    } else {
        state.main_socket.clone()
    };

    let target = if target_addr.contains(':') {
        target_addr
    } else {
        format!("{}:9876", target_addr)
    };

    socket
        .send_to(&serialized, &target)
        .await
        .map_err(|e| format!("Send failed from {}: {}", label, e))?;

    Ok(packet)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle: AppHandle = app.handle().clone();

            tauri::async_runtime::block_on(async move {
                let main_sock = Arc::new(
                    UdpSocket::bind("0.0.0.0:9876")
                        .await
                        .expect("Failed to bind port 9876"),
                );
                let peer_sock = Arc::new(
                    UdpSocket::bind("0.0.0.0:9877")
                        .await
                        .expect("Failed to bind port 9877"),
                );

                // Run STUN resolution pool on startup
                let stun_pool = [
                    "stun.cloudflare.com:3478",
                    "stun.l.google.com:19302",
                    "stun1.l.google.com:19302",
                    "stun.nextcloud.com:443",
                ];
                let resolved_wan = resolve_stun_pool(&main_sock, &stun_pool).await;

                let s1 = main_sock.clone();
                let h1 = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let mut buf = vec![0u8; 65535];
                    loop {
                        if let Ok((len, _)) = s1.recv_from(&mut buf).await {
                            if let Ok(pkt) = serde_json::from_slice::<Packet>(&buf[..len]) {
                                if let Some(w) = h1.get_webview_window("main") {
                                    let _ = w.emit("p2p_message", &pkt);
                                }
                                let _ = h1.emit("p2p_message", &pkt);
                            }
                        }
                    }
                });

                let s2 = peer_sock.clone();
                let h2 = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let mut buf = vec![0u8; 65535];
                    loop {
                        if let Ok((len, _)) = s2.recv_from(&mut buf).await {
                            if let Ok(pkt) = serde_json::from_slice::<Packet>(&buf[..len]) {
                                if let Some(w) = h2.get_webview_window("peer") {
                                    let _ = w.emit("p2p_message", &pkt);
                                }
                                let _ = h2.emit("p2p_message", &pkt);
                            }
                        }
                    }
                });

                app.manage(SocketsState {
                    main_socket: main_sock,
                    peer_socket: peer_sock,
                    main_wan: Arc::new(tokio::sync::Mutex::new(resolved_wan)),
                });
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![init_node, send_packet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
