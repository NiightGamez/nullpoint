
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

export type UserStatus = "online" | "idle" | "dnd" | "invisible";
import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export default function App() {

  // Cryptographic Root of Trust for Developer Badge
  const VERIFIED_DEV_KEYS = new Set([
    "ed25519_dsAtuLsqvCN2DcEKPrVNfSt5rGx0xAFUq6fDKNs0G3M=",
    "dsAtuLsqvCN2DcEKPrVNfSt5rGx0xAFUq6fDKNs0G3M=", // bare key fallback
  ]);

  const renderDevBadge = (senderPubkey?: string) => {
    if (senderPubkey && VERIFIED_DEV_KEYS.has(senderPubkey)) {
      return (
        <span 
          title="Verified NullPoint Developer"
          className="ml-2 px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider bg-gradient-to-r from-amber-500 via-rose-500 to-purple-600 text-white rounded shadow-sm border border-white/20 select-none cursor-default inline-flex items-center"
        >
          DEV
        </span>
      );
    }
    return null;
  };

  const statusRef = useRef<string>("online");

  const [incomingRequests, setIncomingRequests] = useState<FriendRequestPacket[]>([]);
  const [inviteInput, setInviteInput] = useState("");
  const [friendList, setFriendList] = useState<{ pubkey: string; alias: string; addr: string }[]>([]);

  const parseInvite = (invite: string) => {
    const clean = invite.trim().replace(/^nullpoint:\/\//, "");
    const parts = clean.split("@");
    return {
      targetPubkey: parts[0] || "",
      targetAddr: parts[1] || "",
    };
  };

  const handleSendFriendRequest = async () => {
    if (!inviteInput.trim()) return;
    const { targetPubkey, targetAddr } = parseInvite(inviteInput);
    const resolvedTarget = targetAddr.trim();

    const myPub = (identity as any)?.pubkey || (account as any)?.pubkey || "dev_key";
    const myAlias = (account as any)?.username || (account as any)?.alias || (identity as any)?.alias || "mvoorhies";
    const myAddr = (identity as any)?.onion_address || `127.0.0.1:${(identity as any)?.local_port || 9876}`;

    const reqPacket: FriendRequestPacket = {
      kind: "friend_request",
      id: crypto.randomUUID(),
      sender_pubkey: myPub,
      sender_alias: myAlias,
      sender_addr: myAddr,
      recipient_pubkey: targetPubkey,
    };

    try {
      await invoke("send_packet", {
        targetAddr: resolvedTarget,
        packet: reqPacket,
      });
      setInviteInput("");
    } catch (err) {
      console.error("Failed to send request:", err);
    }
  };

  const handleAcceptRequest = async (req: FriendRequestPacket) => {
    const myPub = (identity as any)?.pubkey || (account as any)?.pubkey || "dev_key";
    const myAlias = (account as any)?.username || (account as any)?.alias || (identity as any)?.alias || "mvoorhies";
    const myAddr = (identity as any)?.onion_address || `127.0.0.1:${(identity as any)?.local_port || 9876}`;

    const acceptPacket: FriendAcceptPacket = {
      kind: "friend_accept",
      id: crypto.randomUUID(),
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
      setFriendList((prev) => [...prev, { pubkey: req.sender_pubkey, alias: req.sender_alias, addr: req.sender_addr }]);
      setIncomingRequests((prev) => prev.filter((r) => r.id !== req.id));
    } catch (err) {
      console.error("Failed to accept request:", err);
    }
  };

  const [account, setAccount] = useState<StoredAccount | null>(null);
  const [identity, setIdentity] = useState<NodeIdentity | null>(null);

  const [toasts, setToasts] = useState<InAppToast[]>([]);
  const [showAuthModal, setShowAuthModal] = useState<boolean>(false);
  const [authTab, setAuthTab] = useState<"new" | "import">("new");
  const [usernameInput, setUsernameInput] = useState("");
  const [secretKeyInput, setSecretKeyInput] = useState("");
  const [authError, setAuthError] = useState("");
  const [showExportModal, setShowExportModal] = useState(false);

  const [navMode, setNavMode] = useState<"dm" | "server">("dm");
  const [activeServerId, setActiveServerId] = useState<string>("srv_mesh_alpha");
  const [activeChannel, setActiveChannel] = useState<string>("general");
  const [activeContact, setActiveContact] = useState<Contact | null>(null);

  const [unreads, setUnreads] = useState<Record<string, number>>({});
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [messages, setMessages] = useState<Packet[]>([]);
  const [inputText, setInputText] = useState("");

  const [showAddContactModal, setShowAddContactModal] = useState(false);
  const [manualAlias, setManualAlias] = useState("");
  const [showAddServerModal, setShowAddServerModal] = useState(false);
  const [newServerName, setNewServerName] = useState("");
  const [showAddChannelModal, setShowAddChannelModal] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [copiedKey, setCopiedKey] = useState(false);

  const navModeRef = useRef(navMode);
  const activeContactRef = useRef(activeContact);
  const activeServerIdRef = useRef(activeServerId);
  const activeChannelRef = useRef(activeChannel);

  useEffect(() => {
    navModeRef.current = navMode;
    activeContactRef.current = activeContact;
    activeServerIdRef.current = activeServerId;
    activeChannelRef.current = activeChannel;
  }, [navMode, activeContact, activeServerId, activeChannel]);

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
  }, []);

  const pushToast = (toast: Omit<InAppToast, "id">) => {
    const id = generateId();
    setToasts((prev) => [...prev, { ...toast, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  };

  // Clear unreads when viewing
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

        const hostEndpoint = (id as any)?.onion_address || (id as any)?.wan_endpoint || `127.0.0.1:${id.local_port || 9876}`; id.shareable_invite = `nullpoint://${account.pubkey}@${hostEndpoint}`;
        setIdentity(id);

        const defaultPeer: Contact = {
          alias: id.target_alias,
          pubkey: "", // Populated dynamically on first packet
          addr: `127.0.0.1:${id.target_port}`,
        };

        setContacts([defaultPeer]);
        setActiveContact(defaultPeer);

        setServers([
          {
            id: "srv_mesh_alpha",
            name: "Homelab Swarm",
            channels: ["general", "announcements", "hardware-lab"],
            peers: [`127.0.0.1:${id.target_port}`],
          },
        ]);

        const unlisten = await listen<Packet>("p2p_message", (event) => {
          const packet = event.payload;

          setMessages((prev) => {
            if (prev.some((m) => m.id === packet.id)) return prev;
            return [...prev, packet];
          });

          if (packet.kind === "dm") {
            // Update known peer pubkey if missing
            setContacts((prev) =>
              prev.map((c) =>
                !c.pubkey || c.pubkey === packet.sender_pubkey
                  ? { ...c, pubkey: packet.sender_pubkey, alias: packet.sender_alias }
                  : c
              )
            );

            const isViewing =
              navModeRef.current === "dm" &&
              (activeContactRef.current?.pubkey === packet.sender_pubkey ||
                (!activeContactRef.current?.pubkey && activeContactRef.current !== null));

            if (!isViewing) {
              if (statusRef.current === "dnd") return;
              setUnreads((prev) => ({
                ...prev,
                [`dm:${packet.sender_pubkey}`]: (prev[`dm:${packet.sender_pubkey}`] || 0) + 1,
              }));

              pushToast({
                title: `@${packet.sender_alias}`,
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

            if (!isViewing) {
              setUnreads((prev) => ({
                ...prev,
                [`server:${packet.room_id}:${packet.channel}`]:
                  (prev[`server:${packet.room_id}:${packet.channel}`] || 0) + 1,
              }));

              pushToast({
                title: `#${packet.channel} (${packet.sender_alias})`,
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
    };
  }, [account]);

  // Total unread DM count for the left rail icon
  const totalDmUnreads = Object.entries(unreads)
    .filter(([k]) => k.startsWith("dm:"))
    .reduce((sum, [, count]) => sum + count, 0);

  const getServerUnreads = (serverId: string) => {
    return Object.entries(unreads)
      .filter(([k]) => k.startsWith(`server:${serverId}:`))
      .reduce((sum, [, count]) => sum + count, 0);
  };

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

    try {
      const res = await invoke<{ secret_key: string; pubkey: string }>(
        "restore_identity_from_key",
        { secretB64: secretKeyInput.trim() }
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

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !identity) return;

    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const messageId = generateId();

    if (navMode === "dm" && activeContact) {
      const packet: Packet = {
        kind: "dm",
        id: messageId,
        sender_pubkey: identity.pubkey,
        sender_alias: identity.alias,
        recipient_pubkey: activeContact.pubkey || "pending",
        text: inputText,
        timestamp: time,
      };

      setMessages((prev) => [...prev, packet]);
      setInputText("");

      if (isTauri) {
        await invoke("send_packet", {
          targetAddr: activeContact.addr,
          packet,
        }).catch(console.error);
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
      sender_pubkey: identity?.pubkey || account?.pubkey || "",
        text: inputText,
        timestamp: time,
      };

      setMessages((prev) => [...prev, packet]);
      setInputText("");

      if (isTauri) {
        for (const peer of srv.peers) {
          await invoke("send_packet", { targetAddr: peer, packet }).catch(console.error);
        }
      }
    }
  };

  const parseAndAddInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteInput.trim()) return;

    let targetPubkey = "";
    let targetAddr = "";

    if (inviteInput.startsWith("mesh://")) {
      const clean = inviteInput.replace("mesh://", "");
      const [pub, addr] = clean.split("@");
      targetPubkey = pub;
      targetAddr = addr;
    } else if (inviteInput.includes(":")) {
      targetAddr = inviteInput;
    }

    if (!targetAddr) return;

    const newContact: Contact = {
      alias: manualAlias.trim() || `Node (${targetAddr.split(":")[1]})`,
      pubkey: targetPubkey,
      addr: targetAddr,
    };

    setContacts((prev) => [...prev.filter((c) => c.addr !== targetAddr), newContact]);
    setActiveContact(newContact);
    setNavMode("dm");
    setInviteInput("");
    setManualAlias("");
    setShowAddContactModal(false);
  };

  const copyMyInvite = () => {
    if (!identity) return;
    navigator.clipboard.writeText(identity.shareable_invite);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const currentMessages = messages.filter((m) => {
    if (navMode === "dm") return m.kind === "dm";
    if (navMode === "server") {
      return m.kind === "server" && m.room_id === activeServerId && m.channel === activeChannel;
    }
    return false;
  });

  return (
    <div
      className="relative flex h-screen w-screen overflow-hidden text-[#dbdee1] font-sans antialiased select-none"
      style={{ backgroundColor: "#1e1f22" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Toast Notification Stack */}
      <div className="absolute top-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            onClick={() => {
              if (toast.kind === "dm") {
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
            className="pointer-events-auto cursor-pointer bg-[#232428] border-l-4 border-[#5865f2] border-y border-r border-[#1f2023] rounded-r-lg shadow-2xl p-3 flex flex-col gap-1 hover:bg-[#2b2d31]"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-bold text-white truncate">{toast.title}</span>
              <span className="text-[10px] text-[#949ba4] font-medium uppercase">
                {toast.kind === "dm" ? "Direct Message" : "Channel"}
              </span>
            </div>
            <p className="text-xs text-[#dbdee1] line-clamp-2 break-words">{toast.body}</p>
          </div>
        ))}
      </div>

      {/* 1. Server Rail (Leftmost) */}
      <div
        className="w-[72px] flex-shrink-0 flex flex-col items-center py-3 gap-2 border-r border-[#2b2d31]"
        style={{ backgroundColor: "#1e1f22" }}
      >
        <div className="relative">
          <button
            onClick={() => {
              setNavMode("dm");
              if (contacts.length > 0 && !activeContact) setActiveContact(contacts[0]);
            }}
            title="Direct Messages"
            className={`w-12 h-12 rounded-2xl flex items-center justify-center font-bold text-sm transition-all cursor-pointer ${
              navMode === "dm"
                ? "bg-[#5865f2] rounded-xl text-white"
                : "bg-[#313338] text-slate-300 hover:rounded-xl hover:bg-[#5865f2] hover:text-white"
            }`}
          >
            DMs
          </button>
          {totalDmUnreads > 0 && (
            <span className="absolute -top-1 -right-1 px-1.5 py-0.5 text-[10px] font-bold bg-[#f23f43] text-white rounded-full border-2 border-[#1e1f22]">
              {totalDmUnreads}
            </span>
          )}
        </div>

        <div className="w-8 h-[2px] bg-[#35373c] my-1 rounded" />

        {servers.map((srv) => {
          const srvBadge = getServerUnreads(srv.id);
          return (
            <div key={srv.id} className="relative">
              <button
                onClick={() => {
                  setNavMode("server");
                  setActiveServerId(srv.id);
                }}
                title={srv.name}
                className={`w-12 h-12 rounded-2xl flex items-center justify-center font-bold text-sm uppercase transition-all cursor-pointer ${
                  navMode === "server" && activeServerId === srv.id
                    ? "bg-[#23a55a] rounded-xl text-white"
                    : "bg-[#313338] text-slate-300 hover:rounded-xl hover:bg-[#23a55a] hover:text-white"
                }`}
              >
                {srv.name.slice(0, 2)}
              </button>
              {srvBadge > 0 && (
                <span className="absolute -top-1 -right-1 px-1.5 py-0.5 text-[10px] font-bold bg-[#f23f43] text-white rounded-full border-2 border-[#1e1f22]">
                  {srvBadge}
                </span>
              )}
            </div>
          );
        })}

        <button
          onClick={() => setShowAddServerModal(true)}
          title="Create Server"
          className="w-12 h-12 rounded-2xl bg-[#313338] hover:bg-[#23a55a] text-[#23a55a] hover:text-white flex items-center justify-center font-bold text-xl hover:rounded-xl transition-all cursor-pointer"
        >
          +
        </button>
      </div>

      {/* 2. Channel & Contact Sidebar */}
      <div
        className="w-60 flex-shrink-0 flex flex-col justify-between border-r border-[#1f2023]"
        style={{ backgroundColor: "#2b2d31" }}
      >
        <div className="p-3 overflow-y-auto">
          {navMode === "dm" ? (
            <div>
              <div className="flex items-center justify-between mb-2 px-2">
                <span className="text-[11px] font-bold tracking-wider text-[#949ba4] uppercase">
                  Direct Messages
                </span>
                <button
                  onClick={() => setShowAddContactModal(true)}
                  className="text-xs text-emerald-400 hover:text-emerald-300 font-bold cursor-pointer"
                >
                  + Add Key
                </button>
              </div>

              <div className="space-y-1 mb-4">
                {contacts.map((c) => {
                  const unreadCount =
                    (c.pubkey ? unreads[`dm:${c.pubkey}`] : 0) ||
                    unreads[`dm:${c.addr}`] ||
                    0;

                  return (
                    <div
                      key={c.addr}
                      onClick={() => setActiveContact(c)}
                      className={`flex items-center justify-between px-2 py-1.5 rounded text-sm font-medium cursor-pointer ${
                        activeContact?.addr === c.addr
                          ? "bg-[#35373c] text-white"
                          : "text-[#949ba4] hover:bg-[#35373c]/50 hover:text-slate-200"
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
                        <span className="truncate">{c.alias}</span>
                      </div>
                      {unreadCount > 0 && (
                        <span className="px-2 py-0.5 text-[11px] font-bold bg-[#f23f43] text-white rounded-full">
                          {unreadCount}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-2 px-2">
                <span className="text-[11px] font-bold tracking-wider text-[#949ba4] uppercase">
                  Text Channels
                </span>
                <button
                  onClick={() => setShowAddChannelModal(true)}
                  className="text-slate-400 hover:text-white text-base font-bold cursor-pointer"
                >
                  +
                </button>
              </div>

              <div className="space-y-1 mb-4">
                {servers
                  .find((s) => s.id === activeServerId)
                  ?.channels.map((ch) => {
                    const unreadCount = unreads[`server:${activeServerId}:${ch}`] || 0;
                    return (
                      <div
                        key={ch}
                        onClick={() => setActiveChannel(ch)}
                        className={`flex items-center justify-between px-2 py-1.5 rounded text-sm font-medium cursor-pointer ${
                          activeChannel === ch
                            ? "bg-[#35373c] text-white"
                            : "text-[#949ba4] hover:bg-[#35373c]/50 hover:text-slate-200"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-base text-[#949ba4]">#</span>
                          <span>{ch}</span>
                        </div>
                        {unreadCount > 0 && (
                          <span className="px-2 py-0.5 text-[11px] font-bold bg-[#f23f43] text-white rounded-full">
                            {unreadCount}
                          </span>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>

        {/* Identity Footer Card */}
        <div
          className="p-3 border-t border-[#1f2023] flex flex-col gap-2"
          style={{ backgroundColor: "#232428" }}
        >
          <div className="flex items-center justify-between">
            <div
              onClick={() => setShowExportModal(true)}
              className="flex items-center gap-2 overflow-hidden cursor-pointer group"
              title="Click to view Key Backup & Account Details"
            >
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 flex-shrink-0" />
              <div className="flex flex-col truncate">
                <span className="text-xs font-bold text-white group-hover:text-emerald-400 transition truncate">
                  {account?.username || "Guest Node"}
                </span>
                <span className="text-[10px] font-mono text-slate-400 truncate">
                  :{identity?.local_port || "..."}
                </span>
              </div>
            </div>

            <button
              onClick={copyMyInvite}
              title="Copy your Shareable Mesh Invite"
              className="text-[10px] px-2 py-1 bg-[#35373c] hover:bg-[#5865f2] text-slate-200 hover:text-white rounded font-mono transition cursor-pointer"
            >
              {copiedKey ? "Copied!" : "Share Key"}
            </button>
          </div>

          <div className="text-[9px] font-mono text-slate-500 truncate select-all">
            {account?.pubkey || "ed25519_..."}
          </div>
        </div>
      </div>

      {/* 3. Main Chat View */}
      <div className="flex-1 flex flex-col justify-between" style={{ backgroundColor: "#313338" }}>
        <div className="h-12 border-b border-[#1f2023] px-4 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-2">
            <span className="text-[#80848e] text-lg font-bold">
              {navMode === "dm" ? "@" : "#"}
            </span>
            <span className="text-white text-sm font-semibold">
              {navMode === "dm"
                ? activeContact?.alias || "Select Contact"
                : `${servers.find((s) => s.id === activeServerId)?.name || "Server"} / ${activeChannel}`}
            </span>
          </div>
          <span className="text-xs font-mono text-slate-500">
            {navMode === "dm" ? `Peer: ${activeContact?.addr || "None"}` : "Mesh Swarm"}
          </span>
        </div>

        <div className="flex-1 p-4 overflow-y-auto flex flex-col gap-3">
          {currentMessages.length === 0 ? (
            <div className="m-auto text-center text-[#949ba4] text-xs font-mono">
              {navMode === "dm"
                ? `Direct message channel with ${activeContact?.alias || "user"} is ready.`
                : `Beginning of #${activeChannel}.`}
            </div>
          ) : (
            currentMessages.map((m) => (
              <div key={m.id} className="flex flex-col">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-white">{m.sender_alias}</span>
                      {renderDevBadge(m.sender_pubkey)}
                  <span className="text-[10px] text-[#949ba4] font-mono">{m.timestamp}</span>
                </div>
                <div className="text-sm text-[#dbdee1] leading-relaxed break-words">{m.text}</div>
              </div>
            ))
          )}
        </div>

        <form onSubmit={handleSendMessage} className="p-4" style={{ backgroundColor: "#313338" }}>
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            disabled={navMode === "dm" && !activeContact}
            placeholder={
              navMode === "dm"
                ? `Message @${activeContact?.alias || "..."}`
                : `Message #${activeChannel}`
            }
            className="w-full bg-[#383a40] text-sm text-slate-100 placeholder-[#949ba4] rounded-lg px-4 py-2.5 focus:outline-none disabled:opacity-40"
          />
        </form>
      </div>

      {/* Onboarding Dialog */}
      {showAuthModal && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center p-4 z-50">
          <div className="bg-[#313338] border border-[#2b2d31] w-full max-w-md rounded-2xl p-6 shadow-2xl">
            <h2 className="text-white font-bold text-lg mb-1">Welcome to NullPoint</h2>
            <p className="text-xs text-[#949ba4] mb-4">
              Decentralized, zero-server chat. Create a new profile or import your existing keypair.
            </p>

            <div className="flex gap-2 border-b border-[#3b3e45] pb-2 mb-4 text-xs font-medium">
              <button
                type="button"
                onClick={() => setAuthTab("new")}
                className={`pb-1 px-2 ${
                  authTab === "new"
                    ? "border-b-2 border-[#5865f2] text-white"
                    : "text-[#949ba4] hover:text-white"
                }`}
              >
                Create New Profile
              </button>
              <button
                type="button"
                onClick={() => setAuthTab("import")}
                className={`pb-1 px-2 ${
                  authTab === "import"
                    ? "border-b-2 border-[#5865f2] text-white"
                    : "text-[#949ba4] hover:text-white"
                }`}
              >
                Import Existing Key
              </button>
            </div>

            {authError && (
              <div className="text-xs text-rose-400 bg-rose-950/40 border border-rose-900 rounded p-2 mb-3">
                {authError}
              </div>
            )}

            {authTab === "new" ? (
              <form onSubmit={handleCreateAccount} className="space-y-4">
                <div>
                  <label className="text-[11px] uppercase tracking-wider text-[#949ba4] block mb-1 font-bold">
                    Choose Username
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Alice"
                    value={usernameInput}
                    onChange={(e) => setUsernameInput(e.target.value)}
                    className="w-full bg-[#1e1f22] border border-[#3b3e45] rounded p-2 text-sm text-white focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-2.5 bg-[#5865f2] hover:bg-[#4752c4] text-white rounded font-medium text-xs transition cursor-pointer"
                >
                  Generate Ed25519 Identity & Start
                </button>
              </form>
            ) : (
              <form onSubmit={handleImportAccount} className="space-y-3">
                <div>
                  <label className="text-[11px] uppercase tracking-wider text-[#949ba4] block mb-1 font-bold">
                    Profile Username
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Alice"
                    value={usernameInput}
                    onChange={(e) => setUsernameInput(e.target.value)}
                    className="w-full bg-[#1e1f22] border border-[#3b3e45] rounded p-2 text-sm text-white focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[11px] uppercase tracking-wider text-[#949ba4] block mb-1 font-bold">
                    Secret Key / Seed (Base64)
                  </label>
                  <textarea
                    rows={3}
                    required
                    placeholder="Paste 32-byte Base64 key..."
                    value={secretKeyInput}
                    onChange={(e) => setSecretKeyInput(e.target.value)}
                    className="w-full bg-[#1e1f22] border border-[#3b3e45] rounded p-2 text-xs font-mono text-emerald-400 focus:outline-none resize-none"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-2.5 bg-[#23a55a] hover:bg-[#1f924f] text-white rounded font-medium text-xs transition cursor-pointer"
                >
                  Restore Account & Messages
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Account Backup Modal */}
      {showExportModal && account && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-[#313338] border border-[#2b2d31] w-full max-w-md rounded-2xl p-6 shadow-2xl">
            <h3 className="text-white font-bold text-base mb-1">Account & Secret Key Backup</h3>
            <p className="text-xs text-[#949ba4] mb-4">
              Keep your secret key safe to restore your profile on any machine.
            </p>

            <div className="space-y-3 text-xs mb-4">
              <div>
                <span className="text-[#949ba4] block text-[10px] uppercase font-bold">Username</span>
                <span className="text-white font-semibold">{account.username}</span>
              </div>
              <div>
                <span className="text-[#949ba4] block text-[10px] uppercase font-bold">Public Key</span>
                <span className="font-mono text-[11px] text-emerald-400 break-all select-all">
                  {account.pubkey}
                </span>
              </div>
              <div>
                <span className="text-[#949ba4] block text-[10px] uppercase font-bold">
                  Secret Key (Do NOT share)
                </span>
                <div className="p-2 bg-[#1e1f22] border border-[#3b3e45] rounded font-mono text-[11px] text-rose-300 break-all select-all">
                  {account.secret_key}
                </div>
              </div>
            </div>

            <div className="flex justify-between items-center">
              <button
                type="button"
                onClick={() => {
                  localStorage.removeItem("nullpoint_account");
                  window.location.reload();
                }}
                className="text-xs text-rose-400 hover:underline cursor-pointer"
              >
                Log Out / Reset Key
              </button>
              <button
                type="button"
                onClick={() => setShowExportModal(false)}
                className="text-xs px-4 py-2 bg-[#5865f2] hover:bg-[#4752c4] text-white rounded font-medium cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Contact Modal */}
      {showAddContactModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <form
            onSubmit={parseAndAddInvite}
            className="bg-[#313338] border border-[#2b2d31] w-full max-w-md rounded-xl p-5 shadow-2xl"
          >
            <h3 className="text-white font-bold text-base mb-1">Add Peer by Invite or Key</h3>
            <input
              type="text"
              placeholder="Nickname / Alias (e.g., Alice)"
              value={manualAlias}
              onChange={(e) => setManualAlias(e.target.value)}
              className="w-full bg-[#1e1f22] border border-[#3b3e45] text-sm text-slate-200 rounded p-2 focus:outline-none mb-3"
            />
            <input
              type="text"
              placeholder="mesh://ed25519_... or 127.0.0.1:9877"
              value={inviteInput}
              onChange={(e) => setInviteInput(e.target.value)}
              required
              className="w-full bg-[#1e1f22] border border-[#3b3e45] font-mono text-xs text-emerald-400 rounded p-2 focus:outline-none mb-4"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowAddContactModal(false)}
                className="text-xs px-3 py-2 text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="text-xs px-4 py-2 bg-[#5865f2] hover:bg-[#4752c4] text-white rounded font-medium"
              >
                Add Peer
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Add Channel Modal */}
      {showAddChannelModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-[#313338] border border-[#2b2d31] w-full max-w-sm rounded-xl p-5 shadow-2xl">
            <h3 className="text-white font-bold text-base mb-1">Create Text Channel</h3>
            <input
              type="text"
              placeholder="channel-name"
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
              className="w-full bg-[#1e1f22] border border-[#3b3e45] text-sm text-slate-200 rounded p-2 focus:outline-none mb-4"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowAddChannelModal(false)}
                className="text-xs px-3 py-2 text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!newChannelName.trim()) return;
                  const clean = newChannelName.toLowerCase().replace(/\s+/g, "-");
                  setServers((prev) =>
                    prev.map((s) =>
                      s.id === activeServerId ? { ...s, channels: [...s.channels, clean] } : s
                    )
                  );
                  setActiveChannel(clean);
                  setNewChannelName("");
                  setShowAddChannelModal(false);
                }}
                className="text-xs px-4 py-2 bg-[#5865f2] hover:bg-[#4752c4] text-white rounded font-medium"
              >
                Create Channel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Server Modal */}
      {showAddServerModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-[#313338] border border-[#2b2d31] w-full max-w-sm rounded-xl p-5 shadow-2xl">
            <h3 className="text-white font-bold text-base mb-1">Create Server</h3>
            <input
              type="text"
              placeholder="Server Name"
              value={newServerName}
              onChange={(e) => setNewServerName(e.target.value)}
              className="w-full bg-[#1e1f22] border border-[#3b3e45] text-sm text-slate-200 rounded p-2 focus:outline-none mb-4"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowAddServerModal(false)}
                className="text-xs px-3 py-2 text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!newServerName.trim()) return;
                  const newSrv: Server = {
                    id: `srv_${Date.now()}`,
                    name: newServerName.trim(),
                    channels: ["general"],
                    peers: [`127.0.0.1:${identity?.target_port || 9877}`],
                  };
                  setServers((prev) => [...prev, newSrv]);
                  setActiveServerId(newSrv.id);
                  setNavMode("server");
                  setNewServerName("");
                  setShowAddServerModal(false);
                }}
                className="text-xs px-4 py-2 bg-[#5865f2] hover:bg-[#4752c4] text-white rounded font-medium"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
