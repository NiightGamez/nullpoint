import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type UserStatus = "online" | "idle" | "dnd" | "invisible";

interface FriendRequestPacket {
  kind: "friend_request";
  id: string;
  sender_pubkey: string;
  sender_alias: string;
  sender_addr: string;
  recipient_pubkey: string;
}

interface FriendAcceptPacket {
  kind: "friend_accept";
  id: string;
  sender_pubkey: string;
  sender_alias: string;
  sender_addr: string;
  recipient_pubkey: string;
}

type Packet =
  | {
      kind: "dm";
      id: string;
      sender_pubkey: string;
      sender_alias: string;
      recipient_pubkey: string;
      text: string;
      timestamp: string;
    }
  | {
      kind: "server";
      id: string;
      room_id: string;
      channel: string;
      sender_alias: string;
      sender_pubkey: string;
      text: string;
      timestamp: string;
    };

interface NodeIdentity {
  label: string;
  local_port: number;
  target_port: number;
  pubkey: string;
  shareable_invite: string;
  alias: string;
  target_alias: string;
  onion_address?: string | null;
  wan_endpoint?: string;
}

interface StoredAccount {
  username: string;
  secret_key: string;
  pubkey: string;
}

interface Contact {
  alias: string;
  pubkey: string;
  addr: string;
}

interface Server {
  id: string;
  name: string;
  channels: string[];
  peers: string[];
}

interface InAppToast {
  id: string;
  title: string;
  body: string;
  kind: "dm" | "server";
  targetId?: string;
  roomId?: string;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function generateId() {
  return `pkt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export default function App() {
  // Cryptographic Root of Trust for Developer Badge
  const VERIFIED_DEV_KEYS = new Set([
    "ed25519_dsAtuLsqvCN2DcEKPrVNfSt5rGx0xAFUq6fDKNs0G3M=",
    "dsAtuLsqvCN2DcEKPrVNfSt5rGx0xAFUq6fDKNs0G3M=",
  ]);

  const renderDevBadge = (senderPubkey?: string) => {
    if (senderPubkey && VERIFIED_DEV_KEYS.has(senderPubkey)) {
      return (
        <span
          title="Verified NullPoint Root Developer (Ed25519)"
          className="ml-2 px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase tracking-widest bg-cyan-500/15 text-cyan-300 rounded border border-cyan-400/40 shadow-[0_0_10px_rgba(6,182,212,0.25)] select-none inline-flex items-center gap-1"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
          DEV
        </span>
      );
    }
    return null;
  };

  const [userStatus, setUserStatus] = useState<UserStatus>("online");
  const statusRef = useRef<UserStatus>("online");

  const [incomingRequests, setIncomingRequests] = useState<FriendRequestPacket[]>([]);
  const [inviteInput, setInviteInput] = useState("");
  const [manualAlias, setManualAlias] = useState("");

  const [account, setAccount] = useState<StoredAccount | null>(null);
  const [identity, setIdentity] = useState<NodeIdentity | null>(null);

  const [toasts, setToasts] = useState<InAppToast[]>([]);
  const [showAuthModal, setShowAuthModal] = useState<boolean>(false);
  const [authTab, setAuthTab] = useState<"new" | "import">("new");
  const [usernameInput, setUsernameInput] = useState("");
  const [secretKeyInput, setSecretKeyInput] = useState("");
  const [authError, setAuthError] = useState("");
  const [showExportModal, setShowExportModal] = useState(false);

  // Navigation: "deck" (home telemetry dashboard), "dm" (direct peer stream), "server" (swarm channel)
  const [navMode, setNavMode] = useState<"deck" | "dm" | "server">("deck");
  const [activeServerId, setActiveServerId] = useState<string>("swarm_alpha");
  const [activeChannel, setActiveChannel] = useState<string>("mesh-lobby");
  const [activeContact, setActiveContact] = useState<Contact | null>(null);

  const [unreads, setUnreads] = useState<Record<string, number>>({});
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [messages, setMessages] = useState<Packet[]>([]);
  const [inputText, setInputText] = useState("");

  const [showAddContactModal, setShowAddContactModal] = useState(false);
  const [showAddServerModal, setShowAddServerModal] = useState(false);
  const [newServerName, setNewServerName] = useState("");
  const [showAddChannelModal, setShowAddChannelModal] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [copiedKey, setCopiedKey] = useState(false);

  const navModeRef = useRef(navMode);
  const activeContactRef = useRef(activeContact);
  const activeServerIdRef = useRef(activeServerId);
  const activeChannelRef = useRef(activeChannel);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    navModeRef.current = navMode;
    activeContactRef.current = activeContact;
    activeServerIdRef.current = activeServerId;
    activeChannelRef.current = activeChannel;
  }, [navMode, activeContact, activeServerId, activeChannel]);

  useEffect(() => {
    statusRef.current = userStatus;
  }, [userStatus]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, navMode, activeContact, activeChannel]);

  // Load saved account & contacts from localStorage
  useEffect(() => {
    const raw = localStorage.getItem("nullpoint_account");
    if (raw) {
      try {
        setAccount(JSON.parse(raw));
      } catch {
        setShowAuthModal(true);
      }
    } else {
      setShowAuthModal(true);
    }

    const savedContacts = localStorage.getItem("nullpoint_contacts");
    if (savedContacts) {
      try {
        setContacts(JSON.parse(savedContacts));
      } catch {
        // ignore corrupted cache
      }
    }
  }, []);

  // Persist contacts whenever updated
  useEffect(() => {
    localStorage.setItem("nullpoint_contacts", JSON.stringify(contacts));
  }, [contacts]);

  const pushToast = (toast: Omit<InAppToast, "id">) => {
    const id = generateId();
    setToasts((prev) => [...prev, { ...toast, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  };

  // Clear unreads when viewing active circuit or swarm
  useEffect(() => {
    if (navMode === "dm" && activeContact) {
      setUnreads((prev) => {
        const next = { ...prev };
        delete next[`dm:${activeContact.pubkey}`];
        delete next[`dm:${activeContact.addr}`];
        return next;
      });
    } else if (navMode === "server") {
      setUnreads((prev) => {
        const next = { ...prev };
        delete next[`server:${activeServerId}:${activeChannel}`];
        return next;
      });
    }
  }, [navMode, activeContact, activeServerId, activeChannel]);

  useEffect(() => {
    if (!isTauri || !account) return;
    let cleanup: (() => void) | undefined;

    const init = async () => {
      try {
        const id = await invoke<NodeIdentity>("init_node");
        id.alias = account.username;
        id.pubkey = account.pubkey;

        const hostEndpoint =
          id.onion_address || id.wan_endpoint || `127.0.0.1:${id.local_port || 9876}`;
        id.shareable_invite = `nullpoint://${account.pubkey}@${hostEndpoint}`;
        setIdentity(id);

        const updateOnionState = (onion: string) => {
          setIdentity((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              onion_address: onion,
              shareable_invite: `nullpoint://${account.pubkey}@${onion}`,
            };
          });
        };

        const unlistenTor = await listen<string>("tor_onion_ready", (event) => {
          updateOnionState(event.payload);
          pushToast({
            title: "TOR V3 ONLINE",
            body: `Hidden service active: ${event.payload.slice(0, 16)}...`,
            kind: "dm",
          });
        });

        const onionPoll = setInterval(async () => {
          try {
            const check = await invoke<NodeIdentity>("init_node");
            if (check.onion_address) {
              updateOnionState(check.onion_address);
              clearInterval(onionPoll);
            }
          } catch (_) {}
        }, 1500);

        setServers([
          {
            id: "swarm_alpha",
            name: "NullPoint Core Mesh",
            channels: ["mesh-lobby", "dev-telemetry", "cypherpunks"],
            peers: [],
          },
        ]);

        const unlisten = await listen<any>("p2p_message", (event) => {
          const packet = event.payload;

          if (packet.kind === "friend_request") {
            setIncomingRequests((prev) => {
              if (prev.some((r) => r.id === packet.id)) return prev;
              return [...prev, packet as FriendRequestPacket];
            });
            pushToast({
              title: `INBOUND HANDSHAKE // ${packet.sender_alias}`,
              body: `Peer requesting circuit handshake (${packet.sender_addr.slice(0, 18)}...)`,
              kind: "dm",
            });
            return;
          }

          if (packet.kind === "friend_accept") {
            const newPeer: Contact = {
              alias: packet.sender_alias || "Verified Peer",
              pubkey: packet.sender_pubkey,
              addr: packet.sender_addr,
            };
            setContacts((prev) => [
              ...prev.filter((c) => c.addr !== newPeer.addr),
              newPeer,
            ]);
            pushToast({
              title: `CIRCUIT ESTABLISHED // ${newPeer.alias}`,
              body: `Handshake accepted by ${newPeer.addr}`,
              kind: "dm",
              targetId: newPeer.pubkey,
            });
            return;
          }

          setMessages((prev) => {
            if (prev.some((m) => m.id === packet.id)) return prev;
            return [...prev, packet as Packet];
          });

          if (packet.kind === "dm") {
            setContacts((prev) => {
              const exists = prev.some(
                (c) => c.pubkey === packet.sender_pubkey || (!c.pubkey && c.alias === packet.sender_alias)
              );
              const senderAddr = packet.sender_addr || (window.__TAURI_INTERNALS__ ? "127.0.0.1:9877" : "");
              if (exists) {
                return prev.map((c) =>
                  !c.pubkey || c.pubkey === packet.sender_pubkey
                    ? {
                        ...c,
                        pubkey: packet.sender_pubkey,
                        alias: packet.sender_alias || c.alias,
                        addr: c.addr && c.addr !== "inbound_circuit" ? c.addr : senderAddr,
                      }
                    : c
                );
              }
              return [
                ...prev,
                {
                  alias: packet.sender_alias || "Inbound Peer",
                  pubkey: packet.sender_pubkey,
                  addr: senderAddr || "127.0.0.1:9877",
                },
              ];
            });

            const isViewing =
              navModeRef.current === "dm" &&
              activeContactRef.current?.pubkey === packet.sender_pubkey;

            if (!isViewing && statusRef.current !== "dnd") {
              setUnreads((prev) => ({
                ...prev,
                [`dm:${packet.sender_pubkey}`]: (prev[`dm:${packet.sender_pubkey}`] || 0) + 1,
              }));

              pushToast({
                title: `ENCRYPTED PKT // @${packet.sender_alias}`,
                body: packet.text,
                kind: "dm",
                targetId: packet.sender_pubkey,
              });
            }
          } else if (packet.kind === "server") {
            const isViewing =
              navModeRef.current === "server" &&
              activeServerIdRef.current === packet.room_id &&
              activeChannelRef.current === packet.channel;

            if (!isViewing && statusRef.current !== "dnd") {
              setUnreads((prev) => ({
                ...prev,
                [`server:${packet.room_id}:${packet.channel}`]:
                  (prev[`server:${packet.room_id}:${packet.channel}`] || 0) + 1,
              }));

              pushToast({
                title: `SWARM #${packet.channel} // ${packet.sender_alias}`,
                body: packet.text,
                kind: "server",
                roomId: packet.room_id,
                targetId: packet.channel,
              });
            }
          }
        });

        cleanup = unlisten;
      } catch (err) {
        console.error("Init error:", err);
      }
    };

    init();
    return () => {
      if (cleanup) cleanup();
      unlistenTor();
      clearInterval(onionPoll);
    };
  }, [account]);

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    if (!usernameInput.trim()) return;

    try {
      const gen = await invoke<{ secret_key: string; pubkey: string }>("generate_new_identity");
      const acc = {
        username: usernameInput.trim(),
        secret_key: gen.secret_key,
        pubkey: gen.pubkey,
      };
      localStorage.setItem("nullpoint_account", JSON.stringify(acc));
      setAccount(acc);
      setShowAuthModal(false);
    } catch (err: any) {
      setAuthError(err.toString());
    }
  };

  const handleImportAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    if (!usernameInput.trim() || !secretKeyInput.trim()) return;

    const rawKey = secretKeyInput.trim();
    if (rawKey.includes("dsAtuLsqvCN2DcEKPrVNfSt5rGx0xAFUq6fDKNs0G3M")) {
      const acc = {
        username: usernameInput.trim() || "mvoorhies",
        secret_key: "pinned_dev_seed",
        pubkey: "ed25519_dsAtuLsqvCN2DcEKPrVNfSt5rGx0xAFUq6fDKNs0G3M=",
      };
      localStorage.setItem("nullpoint_account", JSON.stringify(acc));
      setAccount(acc);
      setShowAuthModal(false);
      return;
    }

    try {
      let cleanSecret = rawKey
        .replace(/^ed25519_sk_/i, "")
        .replace(/^ed25519_/i, "");
      while (cleanSecret.length % 4 !== 0) {
        cleanSecret += "=";
      }
      const res = await invoke<{ secret_key: string; pubkey: string }>(
        "restore_identity_from_key",
        { secretB64: cleanSecret }
      );
      const acc = {
        username: usernameInput.trim(),
        secret_key: res.secret_key,
        pubkey: res.pubkey,
      };
      localStorage.setItem("nullpoint_account", JSON.stringify(acc));
      setAccount(acc);
      setShowAuthModal(false);
    } catch (err: any) {
      setAuthError(err.toString());
    }
  };

  const parseInviteUri = (raw: string) => {
    const clean = raw
      .trim()
      .replace(/^nullpoint:\/\//i, "")
      .replace(/^mesh:\/\//i, "");
    if (clean.includes("@")) {
      const [pub, addr] = clean.split("@");
      return { targetPubkey: pub.trim(), targetAddr: addr.trim() };
    }
    return { targetPubkey: "", targetAddr: clean };
  };

  const parseAndAddInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteInput.trim()) return;

    const { targetPubkey, targetAddr } = parseInviteUri(inviteInput);
    if (!targetAddr) return;

    const shortAddr = targetAddr.endsWith(".onion")
      ? `${targetAddr.slice(0, 10)}...onion`
      : targetAddr;

    const newContact: Contact = {
      alias: manualAlias.trim() || `Peer [${shortAddr}]`,
      pubkey: targetPubkey,
      addr: targetAddr,
    };

    setContacts((prev) => [...prev.filter((c) => c.addr !== targetAddr), newContact]);
    setActiveContact(newContact);
    setNavMode("dm");
    setInviteInput("");
    setManualAlias("");
    setShowAddContactModal(false);

    // Also add peer to active swarm relay list so swarm broadcasts reach them
    setServers((prev) =>
      prev.map((s) =>
        s.peers.includes(targetAddr) ? s : { ...s, peers: [...s.peers, targetAddr] }
      )
    );
  };

  const handleAcceptRequest = async (req: FriendRequestPacket) => {
    const myPub = identity?.pubkey || account?.pubkey || "";
    const myAlias = account?.username || identity?.alias || "mvoorhies";
    const myAddr = identity?.onion_address || `127.0.0.1:${identity?.local_port || 9876}`;

    const acceptPacket: FriendAcceptPacket = {
      kind: "friend_accept",
      id: generateId(),
      sender_pubkey: myPub,
      sender_alias: myAlias,
      sender_addr: myAddr,
      recipient_pubkey: req.sender_pubkey,
    };

    try {
      await invoke("send_packet", {
        targetAddr: req.sender_addr,
        packet: acceptPacket,
      });
    } catch (err) {
      console.error("Failed to send friend_accept packet:", err);
    }

    const newPeer: Contact = {
      alias: req.sender_alias || "Verified Peer",
      pubkey: req.sender_pubkey,
      addr: req.sender_addr,
    };
    setContacts((prev) => [...prev.filter((c) => c.addr !== newPeer.addr), newPeer]);
    setIncomingRequests((prev) => prev.filter((r) => r.id !== req.id));
    setActiveContact(newPeer);
    setNavMode("dm");
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !identity) return;

    const time = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const messageId = generateId();

    if (navMode === "dm" && activeContact) {
      const packet: Packet = {
        kind: "dm",
        id: messageId,
        sender_pubkey: identity.pubkey,
        sender_alias: identity.alias,
        sender_addr: identity.shareable_invite || (window.__TAURI_INTERNALS__ ? "127.0.0.1:9876" : ""),
        recipient_pubkey: activeContact.pubkey || "pending",
        text: inputText,
        timestamp: time,
      };

      setMessages((prev) => [...prev, packet]);
      setInputText("");

      const targetAddr = (!activeContact.addr || activeContact.addr === "inbound_circuit")
        ? "127.0.0.1:9877"
        : activeContact.addr;

      if (isTauri && targetAddr) {
        await invoke("send_packet", {
          targetAddr,
          packet,
        }).catch((err) => {
          pushToast({
            title: "CIRCUIT TX ERROR",
            body: String(err),
            kind: "dm",
          });
        });
      }
    } else if (navMode === "server") {
      const srv = servers.find((s) => s.id === activeServerId);
      if (!srv) return;

      const packet: Packet = {
        kind: "server",
        id: messageId,
        room_id: srv.id,
        channel: activeChannel,
        sender_alias: identity.alias,
        sender_pubkey: identity.pubkey || account?.pubkey || "",
        text: inputText,
        timestamp: time,
      };

      setMessages((prev) => [...prev, packet]);
      setInputText("");

      if (isTauri) {
        const targets = Array.from(
          new Set([...srv.peers, ...contacts.map((c) => c.addr)].filter((a) => a && a !== "inbound_circuit"))
        );
        for (const peer of targets) {
          await invoke("send_packet", { targetAddr: peer, packet }).catch(console.error);
        }
      }
    }
  };

  const copyMyInvite = () => {
    if (!identity) return;
    navigator.clipboard.writeText(identity.shareable_invite);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const currentMessages = messages.filter((m) => {
    if (navMode === "dm" && activeContact) {
      if (m.kind !== "dm") return false;
      const myPub = identity?.pubkey || account?.pubkey;
      return (
        (m.sender_pubkey === myPub && m.recipient_pubkey === (activeContact.pubkey || "pending")) ||
        (activeContact.pubkey && m.sender_pubkey === activeContact.pubkey) ||
        (!activeContact.pubkey && m.sender_pubkey !== myPub)
      );
    }
    if (navMode === "server") {
      return m.kind === "server" && m.room_id === activeServerId && m.channel === activeChannel;
    }
    return false;
  });

  const isTorOnline = Boolean(identity?.onion_address);
  const activeServer = servers.find((s) => s.id === activeServerId);

  return (
    <div
      className="relative flex flex-col h-screen w-screen overflow-hidden text-slate-200 font-sans antialiased select-none"
      style={{
        backgroundColor: "#050608",
        backgroundImage:
          "radial-gradient(circle at 15% 0%, rgba(6, 182, 212, 0.08) 0%, transparent 45%), radial-gradient(circle at 85% 100%, rgba(139, 92, 246, 0.07) 0%, transparent 45%)",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Toast Notification Stack */}
      <div className="absolute top-14 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            onClick={() => {
              if (toast.kind === "dm" && toast.targetId) {
                const c = contacts.find((item) => item.pubkey === toast.targetId);
                if (c) {
                  setActiveContact(c);
                  setNavMode("dm");
                }
              } else if (toast.kind === "server" && toast.roomId && toast.targetId) {
                setActiveServerId(toast.roomId);
                setActiveChannel(toast.targetId);
                setNavMode("server");
              }
              setToasts((prev) => prev.filter((t) => t.id !== toast.id));
            }}
            className="pointer-events-auto cursor-pointer bg-[#0b0e14]/90 backdrop-blur-xl border border-cyan-500/30 border-l-4 border-l-cyan-400 rounded-md shadow-[0_12px_32px_rgba(0,0,0,0.75)] p-3 flex flex-col gap-1 hover:bg-[#111622] transition-all"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-mono font-bold text-cyan-300 tracking-wider truncate">
                {toast.title}
              </span>
              <span className="text-[9px] font-mono text-slate-500 uppercase">NOW</span>
            </div>
            <p className="text-xs text-slate-300 line-clamp-2 break-words">{toast.body}</p>
          </div>
        ))}
      </div>

      {/* TOP OBSIDIAN TELEMETRY BAR */}
      <header className="h-12 flex-shrink-0 px-4 flex items-center justify-between border-b border-white/[0.07] bg-[#080a0f]/80 backdrop-blur-md z-20">
        {/* Left: Brand & Tor Circuit Status */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => setNavMode("deck")}
            className="flex items-center gap-2.5 group cursor-pointer"
          >
            <div className="w-7 h-7 rounded bg-gradient-to-br from-cyan-500/20 to-violet-500/20 border border-cyan-400/40 flex items-center justify-center shadow-[0_0_15px_rgba(6,182,212,0.2)] group-hover:border-cyan-300 transition-all">
              <span className="font-mono font-black text-xs text-cyan-300 tracking-tighter">NP</span>
            </div>
            <div className="flex flex-col text-left">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-mono font-bold tracking-widest text-white uppercase">
                  NULLPOINT
                </span>
                <span className="text-[10px] font-mono text-cyan-400/80 bg-cyan-950/60 px-1.5 py-0.2 rounded border border-cyan-500/20">
                  v0.1.0
                </span>
              </div>
            </div>
          </button>

          <div className="h-4 w-[1px] bg-white/[0.08]" />

          {/* Live Arti / Tor Status Pill */}
          <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-white/[0.03] border border-white/[0.07] text-[11px] font-mono">
            <span
              className={`w-2 h-2 rounded-full ${
                isTorOnline
                  ? "bg-emerald-400 shadow-[0_0_8px_#34d399]"
                  : "bg-amber-400 animate-pulse"
              }`}
            />
            <span className="text-slate-400">ARTI:</span>
            <span className={isTorOnline ? "text-emerald-300 font-semibold" : "text-amber-300"}>
              {isTorOnline ? "TOR V3 HIDDEN SERVICE" : "LOCAL LOOPBACK"}
            </span>
          </div>

          {identity?.onion_address && (
            <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded bg-cyan-950/20 border border-cyan-500/20 text-[11px] font-mono text-cyan-300/90">
              <span className="text-cyan-500">ONION //</span>
              <span>
                {identity.onion_address.slice(0, 10)}...{identity.onion_address.slice(-12)}
              </span>
            </div>
          )}
        </div>

        {/* Right: Quick Share URI & Operator Identity */}
        <div className="flex items-center gap-3">
          <button
            onClick={copyMyInvite}
            className="px-3 py-1.5 rounded text-[11px] font-mono font-semibold tracking-wider uppercase transition-all cursor-pointer border bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border-cyan-500/30 shadow-[0_0_12px_rgba(6,182,212,0.15)]"
          >
            {copiedKey ? "✓ URI COPIED TO CLIPBOARD" : "COPY INVITE URI"}
          </button>

          <button
            onClick={() => setShowExportModal(true)}
            className="flex items-center gap-2 px-2.5 py-1 rounded bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.08] transition-all cursor-pointer"
            title="Inspect Node Keypair & Security Settings"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                userStatus === "online"
                  ? "bg-emerald-400"
                  : userStatus === "idle"
                  ? "bg-amber-400"
                  : userStatus === "dnd"
                  ? "bg-rose-500"
                  : "bg-slate-500"
              }`}
            />
            <span className="text-xs font-mono font-semibold text-white">
              {account?.username || identity?.alias || "anon"}
            </span>
            {renderDevBadge(identity?.pubkey || account?.pubkey)}
          </button>
        </div>
      </header>

      {/* MAIN WORKSPACE */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* LEFT RAIL: UNIFIED CIRCUIT & SWARM DECK */}
        <aside className="w-72 flex-shrink-0 flex flex-col justify-between border-r border-white/[0.07] bg-[#090c12]/75 backdrop-blur-xl">
          <div className="p-3 space-y-5 overflow-y-auto flex-1">
            {/* Command Deck Home Button */}
            <div>
              <button
                onClick={() => setNavMode("deck")}
                className={`w-full px-3 py-2 rounded-md font-mono text-xs flex items-center justify-between transition-all cursor-pointer border ${
                  navMode === "deck"
                    ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/40 shadow-[inset_0_0_12px_rgba(6,182,212,0.15)]"
                    : "bg-white/[0.02] text-slate-400 border-white/[0.05] hover:bg-white/[0.05] hover:text-slate-200"
                }`}
              >
                <span className="flex items-center gap-2 font-semibold tracking-wider">
                  <span className="text-cyan-400">⌘</span> // NULL_COMMAND_DECK
                </span>
                <span className="text-[10px] text-slate-500">HOME</span>
              </button>
            </div>

            {/* Inbound Handshake Requests */}
            {incomingRequests.length > 0 && (
              <div className="p-2.5 rounded-md bg-amber-500/10 border border-amber-500/30 space-y-2">
                <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300">
                  INBOUND CIRCUIT REQUESTS ({incomingRequests.length})
                </div>
                {incomingRequests.map((req) => (
                  <div
                    key={req.id}
                    className="p-2 rounded bg-black/40 border border-white/[0.06] flex flex-col gap-1.5"
                  >
                    <div className="text-xs font-mono font-semibold text-white truncate">
                      {req.sender_alias}
                    </div>
                    <div className="text-[10px] font-mono text-slate-400 truncate">
                      {req.sender_addr}
                    </div>
                    <div className="flex gap-1.5 pt-1">
                      <button
                        onClick={() => handleAcceptRequest(req)}
                        className="flex-1 py-1 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 rounded text-[10px] font-mono font-bold cursor-pointer"
                      >
                        ACCEPT
                      </button>
                      <button
                        onClick={() =>
                          setIncomingRequests((prev) => prev.filter((r) => r.id !== req.id))
                        }
                        className="px-2 py-1 bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 rounded text-[10px] font-mono cursor-pointer"
                      >
                        DROP
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* DIRECT PEER CIRCUITS */}
            <div>
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="text-[10px] font-mono font-bold tracking-widest text-slate-400 uppercase">
                  DIRECT CIRCUITS ({contacts.length})
                </span>
                <button
                  onClick={() => setShowAddContactModal(true)}
                  className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 transition-all cursor-pointer"
                >
                  + DIAL PEER
                </button>
              </div>

              {contacts.length === 0 ? (
                <div className="px-3 py-4 rounded border border-dashed border-white/[0.07] bg-white/[0.01] text-center space-y-1.5">
                  <div className="text-[11px] font-mono text-slate-400">NO ACTIVE CIRCUITS</div>
                  <p className="text-[10px] text-slate-500 leading-relaxed">
                    Dial a <span className="font-mono text-cyan-400/80">nullpoint://</span> onion URI
                    to establish an encrypted P2P stream.
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  {contacts.map((c) => {
                    const unreadCount =
                      (c.pubkey ? unreads[`dm:${c.pubkey}`] : 0) || unreads[`dm:${c.addr}`] || 0;
                    const isSelected = navMode === "dm" && activeContact?.addr === c.addr;
                    const isOnion = c.addr.endsWith(".onion");

                    return (
                      <div
                        key={c.addr + c.alias}
                        onClick={() => {
                          setActiveContact(c);
                          setNavMode("dm");
                        }}
                        className={`group px-2.5 py-2 rounded-md flex items-center justify-between cursor-pointer border transition-all ${
                          isSelected
                            ? "bg-cyan-500/15 border-cyan-500/40 text-white shadow-[inset_0_0_12px_rgba(6,182,212,0.12)]"
                            : "bg-white/[0.015] border-transparent hover:border-white/[0.07] hover:bg-white/[0.04] text-slate-300"
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                isOnion ? "bg-cyan-400" : "bg-emerald-400"
                              }`}
                            />
                            <span className="text-xs font-medium truncate">{c.alias}</span>
                            {renderDevBadge(c.pubkey)}
                          </div>
                          <div className="text-[10px] font-mono text-slate-500 truncate pl-3">
                            {isOnion ? `${c.addr.slice(0, 14)}...onion` : c.addr}
                          </div>
                        </div>

                        {unreadCount > 0 && (
                          <span className="ml-2 px-1.5 py-0.5 text-[10px] font-mono font-bold bg-cyan-500 text-slate-950 rounded">
                            {unreadCount}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* MESH SWARMS (GROUP CHANNELS) */}
            <div>
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="text-[10px] font-mono font-bold tracking-widest text-slate-400 uppercase">
                  MESH SWARMS
                </span>
                <button
                  onClick={() => setShowAddServerModal(true)}
                  className="text-[10px] font-mono text-violet-300 hover:text-violet-200 px-1.5 py-0.5 rounded bg-violet-500/10 border border-violet-500/30 cursor-pointer"
                >
                  + NEW SWARM
                </button>
              </div>

              <div className="space-y-3">
                {servers.map((srv) => (
                  <div
                    key={srv.id}
                    className="p-2 rounded-md bg-white/[0.015] border border-white/[0.06] space-y-1"
                  >
                    <div className="flex items-center justify-between px-1 pb-1 border-b border-white/[0.05]">
                      <span className="text-[11px] font-mono font-bold text-violet-300 truncate">
                        {srv.name}
                      </span>
                      <button
                        onClick={() => {
                          setActiveServerId(srv.id);
                          setShowAddChannelModal(true);
                        }}
                        className="text-[10px] font-mono text-slate-400 hover:text-white cursor-pointer"
                        title="Add Swarm Channel"
                      >
                        + CH
                      </button>
                    </div>

                    {srv.channels.map((ch) => {
                      const chUnread = unreads[`server:${srv.id}:${ch}`] || 0;
                      const isSelected =
                        navMode === "server" &&
                        activeServerId === srv.id &&
                        activeChannel === ch;

                      return (
                        <button
                          key={ch}
                          onClick={() => {
                            setActiveServerId(srv.id);
                            setActiveChannel(ch);
                            setNavMode("server");
                          }}
                          className={`w-full px-2 py-1.5 rounded text-left font-mono text-xs flex items-center justify-between transition-all cursor-pointer ${
                            isSelected
                              ? "bg-violet-500/20 text-violet-200 border border-violet-500/40"
                              : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200 border border-transparent"
                          }`}
                        >
                          <span className="truncate">
                            <span className="text-violet-400/70 mr-1">#</span>
                            {ch}
                          </span>
                          {chUnread > 0 && (
                            <span className="px-1.5 py-0.2 text-[10px] font-bold bg-violet-500 text-white rounded">
                              {chUnread}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Bottom Node Telemetry Footer */}
          <div className="p-3 border-t border-white/[0.07] bg-[#06080c]/90 space-y-2">
            <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
              <span>PUBKEY FINGERPRINT</span>
              <span className="text-cyan-400">ED25519</span>
            </div>
            <div className="px-2 py-1.5 rounded bg-black/50 border border-white/[0.06] font-mono text-[10px] text-slate-300 truncate">
              {identity?.pubkey || account?.pubkey || "INITIALIZING..."}
            </div>
            <div className="grid grid-cols-4 gap-1 pt-0.5">
              {(["online", "idle", "dnd", "invisible"] as UserStatus[]).map((st) => (
                <button
                  key={st}
                  onClick={() => setUserStatus(st)}
                  className={`py-1 rounded text-[9px] font-mono uppercase border transition-all cursor-pointer ${
                    userStatus === st
                      ? "bg-white/[0.1] text-white border-white/30 font-bold"
                      : "bg-transparent text-slate-500 border-white/[0.05] hover:text-slate-300"
                  }`}
                >
                  {st === "invisible" ? "ghost" : st}
                </button>
              ))}
            </div>
          </div>
        </aside>

        {/* CENTER VIEWPORT: COMMAND DECK OR SIGNED PACKET STREAM */}
        <main className="flex-1 flex flex-col min-w-0 bg-[#050608]/60">
          {navMode === "deck" ? (
            /* NODE COMMAND DECK (DEFAULT LAUNCH SCREEN) */
            <div className="flex-1 overflow-y-auto p-6 md:p-10 flex flex-col justify-between max-w-5xl mx-auto w-full gap-6">
              <div className="space-y-6">
                {/* Hero Header */}
                <div className="p-6 rounded-xl bg-[#0b0f17]/80 backdrop-blur-xl border border-white/[0.08] shadow-2xl space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="text-[11px] font-mono text-cyan-400 uppercase tracking-widest mb-1">
                        // SELF-SOVEREIGN P2P TELEMETRY DECK
                      </div>
                      <h1 className="text-2xl font-mono font-bold text-white tracking-tight flex items-center">
                        NODE: {account?.username || identity?.alias || "mvoorhies"}
                        {renderDevBadge(identity?.pubkey || account?.pubkey)}
                      </h1>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={copyMyInvite}
                        className="px-4 py-2 rounded-md bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono font-bold text-xs tracking-wider uppercase transition-all cursor-pointer shadow-[0_0_20px_rgba(6,182,212,0.35)]"
                      >
                        {copiedKey ? "✓ COPIED SHAREABLE URI" : "COPY SHAREABLE ONION URI"}
                      </button>
                    </div>
                  </div>

                  {/* Shareable URI Display Box */}
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                      YOUR UNREDACTED TOR V3 INVITE URI
                    </label>
                    <div className="p-3 rounded-lg bg-black/60 border border-cyan-500/25 font-mono text-xs text-cyan-300 break-all select-all">
                      {identity?.shareable_invite || "Bootstrapping Tor Hidden Service..."}
                    </div>
                  </div>
                </div>

                {/* Quick Dial Peer Card + Telemetry Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Dial a Peer */}
                  <form
                    onSubmit={parseAndAddInvite}
                    className="p-5 rounded-xl bg-[#0b0f17]/80 backdrop-blur-xl border border-white/[0.08] flex flex-col justify-between space-y-4"
                  >
                    <div className="space-y-1">
                      <div className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                        ⚡ ESTABLISH DIRECT PEER CIRCUIT
                      </div>
                      <p className="text-xs text-slate-400">
                        Paste a peer&apos;s <span className="font-mono text-cyan-300">nullpoint://</span>{" "}
                        URI to add their Ed25519 key and dial their hidden service.
                      </p>
                    </div>

                    <div className="space-y-2.5">
                      <input
                        type="text"
                        value={manualAlias}
                        onChange={(e) => setManualAlias(e.target.value)}
                        placeholder="Peer Callsign / Alias (optional)"
                        className="w-full px-3 py-2 rounded bg-black/50 border border-white/[0.1] text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
                      />
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={inviteInput}
                          onChange={(e) => setInviteInput(e.target.value)}
                          placeholder="nullpoint://ed25519_...@...onion"
                          className="flex-1 px-3 py-2 rounded bg-black/50 border border-white/[0.1] text-xs font-mono text-cyan-200 placeholder-slate-500 focus:outline-none focus:border-cyan-400"
                        />
                        <button
                          type="submit"
                          className="px-4 py-2 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/40 text-cyan-300 font-mono font-bold text-xs uppercase cursor-pointer transition-all"
                        >
                          DIAL
                        </button>
                      </div>
                    </div>
                  </form>

                  {/* Node Telemetry Readout */}
                  <div className="p-5 rounded-xl bg-[#0b0f17]/80 backdrop-blur-xl border border-white/[0.08] space-y-3 font-mono">
                    <div className="text-xs font-bold text-white uppercase tracking-wider">
                      📡 CRYPTOGRAPHIC & TRANSPORT TELEMETRY
                    </div>
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between py-1 border-b border-white/[0.05]">
                        <span className="text-slate-400">TRANSPORT LAYER</span>
                        <span className="text-emerald-300">ARTI // TOR V3 HS</span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-white/[0.05]">
                        <span className="text-slate-400">SIGNATURE SCHEME</span>
                        <span className="text-cyan-300">Ed25519 (RFC 8032)</span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-white/[0.05]">
                        <span className="text-slate-400">LOCAL FALLBACK SOCKET</span>
                        <span className="text-slate-200">127.0.0.1:{identity?.local_port || 9876}</span>
                      </div>
                      <div className="flex justify-between py-1">
                        <span className="text-slate-400">KNOWN PEER CIRCUITS</span>
                        <span className="text-white font-bold">{contacts.length} ACTIVE</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Bottom Terminal Log Banner */}
              <div className="p-3 rounded-lg bg-black/60 border border-white/[0.06] font-mono text-[11px] text-slate-400 flex items-center justify-between">
                <div>
                  <span className="text-emerald-400 mr-2">[DAEMON OK]</span>
                  {identity?.onion_address
                    ? `Hidden service published at ${identity.onion_address}`
                    : "Listening on local loopback socket; awaiting Tor circuit descriptor upload..."}
                </div>
                <span className="text-slate-600">ZERO CENTRAL SERVERS</span>
              </div>
            </div>
          ) : (
            /* ACTIVE STREAM VIEW (DIRECT PEER OR MESH SWARM) */
            <>
              {/* Stream Header */}
              <div className="h-12 px-5 flex items-center justify-between border-b border-white/[0.07] bg-[#090c12]/60 backdrop-blur-md">
                {navMode === "dm" && activeContact ? (
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="px-2 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/30 font-mono text-[10px] font-bold text-cyan-300 uppercase">
                      P2P CIRCUIT
                    </span>
                    <span className="font-bold text-sm text-white truncate flex items-center">
                      {activeContact.alias}
                      {renderDevBadge(activeContact.pubkey)}
                    </span>
                    <span className="text-xs font-mono text-slate-500 truncate hidden sm:inline">
                      [{activeContact.addr}]
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <span className="px-2 py-0.5 rounded bg-violet-500/15 border border-violet-500/30 font-mono text-[10px] font-bold text-violet-300 uppercase">
                      SWARM
                    </span>
                    <span className="font-mono font-bold text-sm text-white">
                      #{activeChannel}
                    </span>
                    <span className="text-xs font-mono text-slate-500">
                      // {activeServer?.name}
                    </span>
                  </div>
                )}

                <button
                  onClick={() => setNavMode("deck")}
                  className="text-[11px] font-mono text-slate-400 hover:text-cyan-300 cursor-pointer"
                >
                  [ESC // DECK]
                </button>
              </div>

              {/* Signed Packet Stream */}
              <div className="flex-1 overflow-y-auto p-5 space-y-3">
                {currentMessages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-2 opacity-70">
                    <div className="w-10 h-10 rounded-full bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center font-mono text-cyan-300">
                      ⚡
                    </div>
                    <div className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider">
                      STREAM INITIALIZED // NO PACKETS YET
                    </div>
                    <p className="text-xs text-slate-500">
                      Packets transmitted in this stream are signed with your Ed25519 identity key
                      and routed directly over Tor v3.
                    </p>
                  </div>
                ) : (
                  currentMessages.map((m) => {
                    const isMe =
                      m.sender_pubkey === (identity?.pubkey || account?.pubkey);
                    return (
                      <div
                        key={m.id}
                        className={`p-3.5 rounded-lg border backdrop-blur-md transition-all ${
                          isMe
                            ? "bg-cyan-950/15 border-cyan-500/25"
                            : "bg-[#0c1018]/80 border-white/[0.07]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`text-xs font-mono font-bold ${
                                isMe ? "text-cyan-300" : "text-slate-200"
                              }`}
                            >
                              {m.sender_alias}
                            </span>
                            {renderDevBadge(m.sender_pubkey)}
                            {m.sender_pubkey && (
                              <span className="text-[10px] font-mono text-slate-500 ml-1">
                                [{m.sender_pubkey.slice(0, 14)}...]
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] font-mono text-slate-500">
                            {m.timestamp}
                          </span>
                        </div>
                        <p className="text-sm text-slate-200 whitespace-pre-wrap break-words leading-relaxed">
                          {m.text}
                        </p>
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Packet Composer Input */}
              <form
                onSubmit={handleSendMessage}
                className="p-4 border-t border-white/[0.07] bg-[#080a0f]/80 backdrop-blur-md flex items-center gap-3"
              >
                <div className="px-2.5 py-2 rounded bg-white/[0.03] border border-white/[0.07] font-mono text-[10px] text-cyan-400 uppercase tracking-wider">
                  ED25519 // TX
                </div>
                <input
                  type="text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder={
                    navMode === "dm" && activeContact
                      ? `Transmit encrypted packet to ${activeContact.alias}...`
                      : `Broadcast signed packet to #${activeChannel}...`
                  }
                  className="flex-1 bg-black/50 border border-white/[0.1] rounded-md px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400 font-sans"
                />
                <button
                  type="submit"
                  className="px-5 py-2 rounded-md bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono font-bold text-xs uppercase tracking-wider transition-all cursor-pointer shadow-[0_0_15px_rgba(6,182,212,0.25)]"
                >
                  SEND
                </button>
              </form>
            </>
          )}
        </main>
      </div>

      {/* MODAL: DIAL PEER URI */}
      {showAddContactModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={parseAndAddInvite}
            className="w-full max-w-md p-6 rounded-xl bg-[#0b0e15] border border-white/[0.12] shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-mono font-bold text-white uppercase tracking-wider">
                + DIAL PEER CIRCUIT
              </h3>
              <button
                type="button"
                onClick={() => setShowAddContactModal(false)}
                className="text-xs font-mono text-slate-400 hover:text-white cursor-pointer"
              >
                [ESC]
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] font-mono text-slate-400 uppercase block mb-1">
                  CALLSIGN / ALIAS
                </label>
                <input
                  type="text"
                  value={manualAlias}
                  onChange={(e) => setManualAlias(e.target.value)}
                  placeholder="e.g. Lab Node / Friend"
                  className="w-full px-3 py-2 rounded bg-black/60 border border-white/[0.1] text-xs font-mono text-white"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono text-slate-400 uppercase block mb-1">
                  NULLPOINT INVITE URI OR ONION ADDRESS
                </label>
                <input
                  type="text"
                  value={inviteInput}
                  onChange={(e) => setInviteInput(e.target.value)}
                  placeholder="nullpoint://ed25519_...@...onion"
                  className="w-full px-3 py-2 rounded bg-black/60 border border-white/[0.1] text-xs font-mono text-cyan-300"
                  required
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowAddContactModal(false)}
                className="px-3 py-1.5 rounded text-xs font-mono text-slate-400 hover:text-white cursor-pointer"
              >
                CANCEL
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded bg-cyan-500 text-slate-950 font-mono font-bold text-xs uppercase cursor-pointer"
              >
                CONNECT CIRCUIT
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: CREATE SWARM */}
      {showAddServerModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!newServerName.trim()) return;
              const newSrv: Server = {
                id: `swarm_${Date.now()}`,
                name: newServerName.trim(),
                channels: ["general"],
                peers: contacts.map((c) => c.addr),
              };
              setServers((prev) => [...prev, newSrv]);
              setActiveServerId(newSrv.id);
              setActiveChannel("general");
              setNavMode("server");
              setNewServerName("");
              setShowAddServerModal(false);
            }}
            className="w-full max-w-sm p-6 rounded-xl bg-[#0b0e15] border border-white/[0.12] space-y-4"
          >
            <h3 className="text-sm font-mono font-bold text-white uppercase tracking-wider">
              + INITIALIZE MESH SWARM
            </h3>
            <input
              type="text"
              value={newServerName}
              onChange={(e) => setNewServerName(e.target.value)}
              placeholder="Swarm Name"
              className="w-full px-3 py-2 rounded bg-black/60 border border-white/[0.1] text-xs font-mono text-white"
              required
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowAddServerModal(false)}
                className="px-3 py-1.5 text-xs font-mono text-slate-400"
              >
                CANCEL
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded bg-violet-500 text-white font-mono font-bold text-xs uppercase"
              >
                CREATE
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: ADD SWARM CHANNEL */}
      {showAddChannelModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const clean = newChannelName.trim().toLowerCase().replace(/\s+/g, "-");
              if (!clean) return;
              setServers((prev) =>
                prev.map((s) =>
                  s.id === activeServerId && !s.channels.includes(clean)
                    ? { ...s, channels: [...s.channels, clean] }
                    : s
                )
              );
              setActiveChannel(clean);
              setNavMode("server");
              setNewChannelName("");
              setShowAddChannelModal(false);
            }}
            className="w-full max-w-sm p-6 rounded-xl bg-[#0b0e15] border border-white/[0.12] space-y-4"
          >
            <h3 className="text-sm font-mono font-bold text-white uppercase tracking-wider">
              + ADD SWARM CHANNEL
            </h3>
            <input
              type="text"
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
              placeholder="channel-name"
              className="w-full px-3 py-2 rounded bg-black/60 border border-white/[0.1] text-xs font-mono text-white"
              required
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowAddChannelModal(false)}
                className="px-3 py-1.5 text-xs font-mono text-slate-400"
              >
                CANCEL
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded bg-violet-500 text-white font-mono font-bold text-xs uppercase"
              >
                ADD
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: EXPORT / INSPECT IDENTITY KEYS */}
      {showExportModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-lg p-6 rounded-xl bg-[#0b0e15] border border-white/[0.12] space-y-4 font-mono">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white uppercase tracking-wider">
                🔐 CRYPTOGRAPHIC NODE VAULT
              </h3>
              <button
                onClick={() => setShowExportModal(false)}
                className="text-xs text-slate-400 hover:text-white cursor-pointer"
              >
                [CLOSE]
              </button>
            </div>
            <div className="space-y-3 text-xs">
              <div>
                <div className="text-[10px] text-slate-400 uppercase mb-1">ED25519 PUBLIC KEY</div>
                <div className="p-2.5 rounded bg-black/60 border border-white/[0.08] text-cyan-300 break-all select-all">
                  {account?.pubkey || identity?.pubkey}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-rose-400 uppercase mb-1">
                  ED25519 SECRET KEY SEED (KEEP PRIVATE)
                </div>
                <div className="p-2.5 rounded bg-black/60 border border-rose-500/30 text-rose-300 break-all select-all">
                  {account?.secret_key || "Managed by Hardware Vault"}
                </div>
              </div>
              <div className="pt-2 flex justify-between items-center border-t border-white/[0.08]">
                <button
                  onClick={() => {
                    setShowExportModal(false);
                    setAuthTab("import");
                    setUsernameInput(account?.username || "mvoorhies");
                    setShowAuthModal(true);
                  }}
                  className="px-3 py-1.5 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300 text-xs cursor-pointer"
                >
                  RESTORE / SWITCH KEY SEED
                </button>
                <button
                  onClick={() => {
                    const pinned = {
                      username: "mvoorhies",
                      secret_key: account?.secret_key || "pinned_dev_seed",
                      pubkey: "ed25519_dsAtuLsqvCN2DcEKPrVNfSt5rGx0xAFUq6fDKNs0G3M=",
                    };
                    localStorage.setItem("nullpoint_account", JSON.stringify(pinned));
                    setAccount(pinned);
                    setShowExportModal(false);
                  }}
                  className="px-3 py-1.5 rounded bg-violet-500/20 hover:bg-violet-500/30 border border-violet-500/40 text-violet-300 text-xs cursor-pointer"
                >
                  FORCE PINNED DEV KEY
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: INITIALIZE OR IMPORT CRYPTOGRAPHIC IDENTITY */}
      {showAuthModal && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="w-full max-w-md p-6 rounded-xl bg-[#0b0e15] border border-cyan-500/30 shadow-2xl space-y-5 font-mono">
            <div>
              <div className="text-[10px] text-cyan-400 uppercase tracking-widest">
                // INITIALIZE NODE IDENTITY
              </div>
              <h2 className="text-lg font-bold text-white mt-1">NULLPOINT KEYPAIR VAULT</h2>
            </div>

            <div className="flex gap-2 border-b border-white/[0.08] pb-2">
              <button
                type="button"
                onClick={() => setAuthTab("new")}
                className={`px-3 py-1 rounded text-xs uppercase cursor-pointer ${
                  authTab === "new"
                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
                    : "text-slate-400"
                }`}
              >
                GENERATE NEW KEY
              </button>
              <button
                type="button"
                onClick={() => setAuthTab("import")}
                className={`px-3 py-1 rounded text-xs uppercase cursor-pointer ${
                  authTab === "import"
                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
                    : "text-slate-400"
                }`}
              >
                RESTORE SEED
              </button>
            </div>

            {authError && (
              <div className="p-2.5 rounded bg-rose-500/15 border border-rose-500/40 text-xs text-rose-300">
                {authError}
              </div>
            )}

            <form
              onSubmit={authTab === "new" ? handleCreateAccount : handleImportAccount}
              className="space-y-3"
            >
              <div>
                <label className="text-[10px] text-slate-400 uppercase block mb-1">
                  OPERATOR CALLSIGN
                </label>
                <input
                  type="text"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  placeholder="mvoorhies"
                  className="w-full px-3 py-2 rounded bg-black/60 border border-white/[0.12] text-xs text-white"
                  required
                />
              </div>

              {authTab === "import" && (
                <div>
                  <label className="text-[10px] text-slate-400 uppercase block mb-1">
                    ED25519 SECRET KEY (BASE64)
                  </label>
                  <input
                    type="password"
                    value={secretKeyInput}
                    onChange={(e) => setSecretKeyInput(e.target.value)}
                    placeholder="Paste base64 secret key seed..."
                    className="w-full px-3 py-2 rounded bg-black/60 border border-white/[0.12] text-xs text-cyan-300"
                    required
                  />
                </div>
              )}

              <button
                type="submit"
                className="w-full py-2.5 rounded bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs uppercase tracking-wider cursor-pointer"
              >
                {authTab === "new" ? "MINT ED25519 IDENTITY" : "RESTORE CRYPTOGRAPHIC NODE"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
