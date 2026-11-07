use safelog::DisplayRedacted;
use arti_client::{TorClient, TorClientConfig};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tauri_plugin_notification::NotificationExt;
use tokio::net::UdpSocket;
use tokio::sync::RwLock;
use tor_rtcompat::PreferredRuntime;

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
    #[serde(rename = "friend_request")]
    FriendRequest {
        id: String,
        sender_pubkey: String,
        sender_alias: String,
        sender_addr: String,
        recipient_pubkey: String,
    },
    #[serde(rename = "friend_accept")]
    FriendAccept {
        id: String,
        sender_pubkey: String,
        sender_alias: String,
        sender_addr: String,
        recipient_pubkey: String,
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
    pub onion_address: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct NotificationFilterSettings {
    pub user_status: String,
    pub blocked_pubkeys: HashSet<String>,
    pub muted_dm_pubkeys: HashSet<String>,
    pub muted_servers: HashSet<String>,
    pub muted_channels: HashSet<String>,
}

pub struct SocketsState {
    pub main_socket: Arc<UdpSocket>,
    pub peer_socket: Arc<UdpSocket>,
    pub filters: Arc<RwLock<NotificationFilterSettings>>,
    pub tor_client: Arc<RwLock<Option<Arc<TorClient<PreferredRuntime>>>>>,
    pub onion_address: Arc<RwLock<Option<String>>>,
}

#[tauri::command]
fn generate_new_identity() -> Result<serde_json::Value, String> {
    let mut csprng = OsRng;
    let signing_key = SigningKey::generate(&mut csprng);
    let secret_bytes = signing_key.to_bytes();
    let pubkey_bytes = signing_key.verifying_key().to_bytes();

    Ok(serde_json::json!({
        "secret_key": B64.encode(secret_bytes),
        "pubkey": format!("ed25519_{}", B64.encode(pubkey_bytes))
    }))
}

#[tauri::command]
fn restore_identity_from_key(secret_b64: String) -> Result<serde_json::Value, String> {
    let secret_bytes = B64.decode(secret_b64.trim())
        .map_err(|e| format!("Invalid base64 key: {}", e))?;

    if secret_bytes.len() != 32 {
        return Err("Invalid secret key length (expected 32 bytes)".into());
    }

    let mut key_array = [0u8; 32];
    key_array.copy_from_slice(&secret_bytes);
    let signing_key = SigningKey::from_bytes(&key_array);
    let pubkey_bytes = signing_key.verifying_key().to_bytes();

    Ok(serde_json::json!({
        "secret_key": B64.encode(secret_bytes),
        "pubkey": format!("ed25519_{}", B64.encode(pubkey_bytes))
    }))
}

#[tauri::command]
async fn update_notification_filters(
    settings: NotificationFilterSettings,
    state: State<'_, SocketsState>,
) -> Result<(), String> {
    let mut lock = state.filters.write().await;
    *lock = settings;
    Ok(())
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
        (9877, 0, "Peer Node", "")
    } else {
        (9876, 0, "mvoorhies", "")
    };

    let onion_lock = state.onion_address.read().await;
    let onion_addr = onion_lock.clone();

    let invite = match &onion_addr {
        Some(onion) => format!("nullpoint://{}@{}", pubkey_str, onion),
        None => format!("nullpoint://{}@127.0.0.1:{}", pubkey_str, local_port),
    };

    Ok(NodeIdentity {
        label,
        local_port,
        target_port,
        pubkey: pubkey_str,
        shareable_invite: invite,
        alias: alias.into(),
        target_alias: target_alias.into(),
        onion_address: onion_addr,
    })
}

#[tauri::command]
async fn send_packet(
    window: Window,
    target_addr: String,
    packet: Packet,
    state: State<'_, SocketsState>,
) -> Result<Packet, String> {
    use tokio::io::AsyncWriteExt;

    let serialized = serde_json::to_vec(&packet).map_err(|e| e.to_string())?;
    let label = window.label();

    if target_addr.contains(".onion") {
        let tor_guard = state.tor_client.read().await;
        let tor_client = tor_guard
            .as_ref()
            .ok_or_else(|| "Tor client is still bootstrapping circuits. Please wait a moment.".to_string())?;

        let onion_host = target_addr
            .trim_start_matches("nullpoint://")
            .split('@')
            .last()
            .unwrap_or(&target_addr);

        // Direct Tor circuit dispatch across the distributed Tor network

        let target_dest = if onion_host.contains(':') {
            onion_host.to_string()
        } else {
            format!("{}:9876", onion_host)
        };

        eprintln!("[TOR DIAL ATTEMPT] Connecting to raw target: {}", target_dest);
        let mut stream = tor_client
            .connect(&target_dest)
            .await
            .map_err(|e| {
                eprintln!("[TOR DIAL ERROR DETAILED] {:#?}", e);
                format!("Tor circuit connection failed: {}", e)
            })?;

        stream
            .write_all(&serialized)
            .await
            .map_err(|e| format!("Failed writing packet to Tor stream: {}", e))?;
        stream
            .flush()
            .await
            .map_err(|e| format!("Failed flushing Tor stream: {}", e))?;
    } else {
        let socket = if label == "peer" {
            state.peer_socket.clone()
        } else {
            state.main_socket.clone()
        };

        let target = if target_addr.contains(':') {
            target_addr
        } else {
            let default_port = if label == "peer" { 9876 } else { 9877 };
            format!("{}:{}", target_addr, default_port)
        };

        socket
            .send_to(&serialized, &target)
            .await
            .map_err(|e| format!("Send failed from {}: {}", label, e))?;
    }

    Ok(packet)
}

async fn trigger_native_notification(
    handle: &AppHandle,
    pkt: &Packet,
    filters_lock: &Arc<RwLock<NotificationFilterSettings>>,
) {
    let filters = filters_lock.read().await;

    if filters.user_status == "dnd" {
        return;
    }

    match pkt {
        Packet::DirectMessage { sender_pubkey, sender_alias, text, .. } => {
            if filters.blocked_pubkeys.contains(sender_pubkey)
                || filters.muted_dm_pubkeys.contains(sender_pubkey)
            {
                return;
            }

            let _ = handle
                .notification()
                .builder()
                .title(format!("NullPoint: DM from {}", sender_alias))
                .body(text)
                .show();
        }
        Packet::ServerMessage { room_id, channel, sender_alias, text, .. } => {
            let ch_key = format!("{}:{}", room_id, channel);
            if filters.muted_servers.contains(room_id) || filters.muted_channels.contains(&ch_key) {
                return;
            }

            let _ = handle
                .notification()
                .builder()
                .title(format!("NullPoint: #{}: {}", channel, sender_alias))
                .body(text)
                .show();
        }
        Packet::FriendRequest { sender_alias, .. } => {
            let _ = handle
                .notification()
                .builder()
                .title("NullPoint: Incoming Request")
                .body(format!("{} sent you a chat request", sender_alias))
                .show();
        }
        Packet::FriendAccept { sender_alias, .. } => {
            let _ = handle
                .notification()
                .builder()
                .title("NullPoint: Request Accepted")
                .body(format!("{} accepted your chat request", sender_alias))
                .show();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
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

                let filters = Arc::new(RwLock::new(NotificationFilterSettings::default()));
                let tor_client_holder = Arc::new(RwLock::new(None));
                let onion_holder = Arc::new(RwLock::new(None));

                // Spawn background Tor bootstrap task
                let tor_client_clone = tor_client_holder.clone();
                let _onion_clone = onion_holder.clone();
                let h_boot = handle.clone();
                let f_boot = filters.clone();
                tauri::async_runtime::spawn(async move {
                    println!("[TOR/ARTI] Initializing Tor client configuration...");
                    let config = TorClientConfig::default();
                    match TorClient::create_bootstrapped(config).await {
                        Ok(client) => {
                            println!("[TOR/ARTI SUCCESS] Bootstrapped connection to Tor network.");
                            let client_arc = client.clone();
                            let mut write_guard = tor_client_clone.write().await;
                            *write_guard = Some(client.clone());

                            // Launch onion service on virtual port 9876
                            match client_arc.launch_onion_service(
                                tor_hsservice::config::OnionServiceConfigBuilder::default()
                                    .nickname("nullpoint-svc".parse().unwrap())
                                    .build()
                                    .unwrap()
                            ) {
                                Ok(None) => { eprintln!("[TOR/ARTI ONION] Service launched in dormant mode."); }
                                Ok(Some((service, mut rend_requests))) => {
                                    // Spawn background listener for incoming rendezvous circuits and data streams
                                    let h_stream = h_boot.clone();
                                    let f_stream = f_boot.clone();
                                    tauri::async_runtime::spawn(async move {
                                        use futures::io::AsyncReadExt;
                                        use futures::StreamExt;
                                        use tor_cell::relaycell::msg::Connected;

                                        println!("[TOR/ARTI INBOUND] Listening for incoming rendezvous requests...");
                                        while let Some(rend_req) = rend_requests.next().await {
                                            let h = h_stream.clone();
                                            let f = f_stream.clone();

                                            tauri::async_runtime::spawn(async move {
                                                match rend_req.accept().await {
                                                    Ok(mut stream_requests) => {
                                                        while let Some(stream_req) = stream_requests.next().await {
                                                            let h_inner = h.clone();
                                                            let f_inner = f.clone();

                                                            tauri::async_runtime::spawn(async move {
                                                                match stream_req.accept(Connected::new_empty()).await {
                                                                    Ok(mut data_stream) => {
                                                                        let mut buf = Vec::new();
                                                                        let mut chunk = [0u8; 4096];
                                                                        loop {
                                                                            match data_stream.read(&mut chunk).await {
                                                                                Ok(0) => break,
                                                                                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                                                                                Err(e) => {
                                                                                    eprintln!("[TOR INBOUND READ ERROR] {}", e);
                                                                                    break;
                                                                                }
                                                                            }
                                                                        }
                                                                        if let Ok(pkt) = serde_json::from_slice::<Packet>(&buf) {
                                                                            println!("[TOR INBOUND MSG] Successfully received packet over onion circuit");
                                                                            trigger_native_notification(&h_inner, &pkt, &f_inner).await;
                                                                            let _ = h_inner.emit("p2p_message", &pkt);
                                                                        }
                                                                    }
                                                                    Err(e) => eprintln!("[TOR STREAM ACCEPT ERROR] {}", e),
                                                                }
                                                            });
                                                        }
                                                    }
                                                    Err(e) => eprintln!("[TOR REND ACCEPTER ERROR] {}", e),
                                                }
                                            });
                                        }
                                    });

                                    if let Some(onion_addr) = service.onion_address() {
                                        let full_str = format!("{}", onion_addr.display_unredacted()).to_lowercase();
                                        let addr = if full_str.ends_with(".onion") {
                                            full_str
                                        } else {
                                            format!("{}.onion", full_str)
                                        };
                                        println!("[TOR/ARTI ONION] Service active at: {}", addr);
                                        {
                                            let mut on_guard = _onion_clone.write().await;
                                            *on_guard = Some(addr.clone());
                                        }

                                        let mut status_events = service.status_events();
                                        let h_status = h_boot.clone();
                                        let addr_ready = addr.clone();
                                        tauri::async_runtime::spawn(async move {
                                            use futures::StreamExt;
                                            while let Some(status) = status_events.next().await {
                                                println!("[TOR/ARTI STATUS] Onion service status: {:?}", status);
                                                let _ = h_status.emit("tor_onion_ready", addr_ready.clone());
                                                break;
                                            }
                                        });
                                    }
                                }
                                Err(e) => eprintln!("[TOR/ARTI ONION ERROR] Failed to launch onion service: {}", e),
                            }
                        }
                        Err(e) => eprintln!("[TOR/ARTI BOOT ERROR] Failed: {}", e),
                    }
                });

                app.manage(SocketsState {
                    main_socket: main_sock,
                    peer_socket: peer_sock,
                    filters,
                    tor_client: tor_client_holder,
                    onion_address: onion_holder,
                });
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            init_node,
            send_packet,
            generate_new_identity,
            restore_identity_from_key,
            update_notification_filters
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
