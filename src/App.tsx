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

interface ContextMenuState {
  x: number;
  y: number;
  type: "contact" | "channel" | "server";
  targetId: string;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function generateId() {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export default function App() {
  const [identity, setIdentity] = useState<NodeIdentity | null>(null);
  const [navMode, setNavMode] = useState<"dm" | "server">("dm");
  const [activeServerId, setActiveServerId] = useState<string>("srv_mesh_alpha");
  const [activeChannel, setActiveChannel] = useState<string>("general");
  const [activeContact, setActiveContact] = useState<Contact | null>(null);

  const [unreads, setUnreads] = useState<Record<string, number>>({});
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [messages, setMessages] = useState<Packet[]>([]);

  const [inputText, setInputText] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Modals
  const [showAddContactModal, setShowAddContactModal] = useState(false);
  const [inviteInput, setInviteInput] = useState("");
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

  // Close context menu on outside click
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, []);

  useEffect(() => {
    if (!isTauri) return;

    let cleanup: (() => void) | undefined;

    const init = async () => {
      try {
        const id = await invoke<NodeIdentity>("init_node");
        setIdentity(id);

        const defaultPeer: Contact = {
          alias: id.target_alias,
          pubkey: `ed25519_peer_${id.target_port}`,
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
            const isViewing = navModeRef.current === "dm";
            if (!isViewing) {
              setUnreads((prev) => ({
                ...prev,
                [`contact:${packet.sender_pubkey}`]:
                  (prev[`contact:${packet.sender_pubkey}`] || 0) + 1,
              }));
            }
          } else if (packet.kind === "server") {
            const isViewing =
              navModeRef.current === "server" &&
              activeServerIdRef.current === packet.room_id &&
              activeChannelRef.current === packet.channel;

            if (!isViewing) {
              setUnreads((prev) => ({
                ...prev,
                [`channel:${packet.room_id}:${packet.channel}`]:
                  (prev[`channel:${packet.room_id}:${packet.channel}`] || 0) + 1,
              }));
            }
          }
        });

        cleanup = unlisten;
      } catch (err) {
        console.error("Initialization error:", err);
      }
    };

    init();

    return () => {
      if (cleanup) cleanup();
    };
  }, []);

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
        recipient_pubkey: activeContact.pubkey,
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
      const activeSrv = servers.find((s) => s.id === activeServerId);
      if (!activeSrv) return;

      const packet: Packet = {
        kind: "server",
        id: messageId,
        room_id: activeSrv.id,
        channel: activeChannel,
        sender_alias: identity.alias,
        text: inputText,
        timestamp: time,
      };

      setMessages((prev) => [...prev, packet]);
      setInputText("");

      if (isTauri) {
        for (const peer of activeSrv.peers) {
          await invoke("send_packet", {
            targetAddr: peer,
            packet,
          }).catch(console.error);
        }
      }
    }
  };

  const parseAndAddInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteInput.trim()) return;

    let targetPubkey = "";
    let targetAddr = "";

    // Example format: mesh://ed25519_abc123@192.168.1.50:9876 or raw 127.0.0.1:9876
    if (inviteInput.startsWith("mesh://")) {
      const clean = inviteInput.replace("mesh://", "");
      const [pub, addr] = clean.split("@");
      targetPubkey = pub;
      targetAddr = addr;
    } else if (inviteInput.includes(":")) {
      targetAddr = inviteInput;
      targetPubkey = `key_${Math.random().toString(36).substring(2, 8)}`;
    }

    if (!targetAddr) return;

    const newContact: Contact = {
      alias: manualAlias.trim() || `Node (${targetAddr.split(":")[1]})`,
      pubkey: targetPubkey || `key_${Date.now()}`,
      addr: targetAddr,
    };

    setContacts((prev) => [...prev.filter((c) => c.addr !== targetAddr), newContact]);
    setActiveContact(newContact);
    setNavMode("dm");
    setInviteInput("");
    setManualAlias("");
    setShowAddContactModal(false);
  };

  const createChannel = () => {
    if (!newChannelName.trim()) return;
    const cleanName = newChannelName.toLowerCase().replace(/\s+/g, "-");
    setServers((prev) =>
      prev.map((s) =>
        s.id === activeServerId
          ? { ...s, channels: [...s.channels, cleanName] }
          : s
      )
    );
    setActiveChannel(cleanName);
    setNewChannelName("");
    setShowAddChannelModal(false);
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
      className="flex h-screen w-screen overflow-hidden text-[#dbdee1] font-sans antialiased select-none"
      style={{ backgroundColor: "#1e1f22" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 1. Server Rail */}
      <div
        className="w-[72px] flex-shrink-0 flex flex-col items-center py-3 gap-2 border-r border-[#2b2d31]"
        style={{ backgroundColor: "#1e1f22" }}
      >
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

        <div className="w-8 h-[2px] bg-[#35373c] my-1 rounded" />

        {servers.map((srv) => (
          <button
            key={srv.id}
            onClick={() => {
              setNavMode("server");
              setActiveServerId(srv.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY, type: "server", targetId: srv.id });
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
        ))}

        <button
          onClick={() => setShowAddServerModal(true)}
          title="Create Server"
          className="w-12 h-12 rounded-2xl bg-[#313338] hover:bg-[#23a55a] text-[#23a55a] hover:text-white flex items-center justify-center font-bold text-xl hover:rounded-xl transition-all cursor-pointer"
        >
          +
        </button>
      </div>

      {/* 2. Channel / Friend Rail */}
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
                {contacts.map((c) => (
                  <div
                    key={c.addr}
                    onClick={() => setActiveContact(c)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, type: "contact", targetId: c.addr });
                    }}
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
                  </div>
                ))}
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
                  ?.channels.map((ch) => (
                    <div
                      key={ch}
                      onClick={() => setActiveChannel(ch)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenu({ x: e.clientX, y: e.clientY, type: "channel", targetId: ch });
                      }}
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
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>

        {/* Cryptographic Node Profile & Shareable Key Bar */}
        <div
          className="p-3 border-t border-[#1f2023] flex flex-col gap-2"
          style={{ backgroundColor: "#232428" }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 overflow-hidden">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 flex-shrink-0" />
              <div className="flex flex-col truncate">
                <span className="text-xs font-bold text-white truncate">
                  {identity?.alias || "Initializing..."}
                </span>
                <span className="text-[10px] font-mono text-emerald-400 truncate">
                  :{identity?.local_port}
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
            {identity?.pubkey || "ed25519_..."}
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
                ? `Direct message channel with ${activeContact?.alias || "peer"} is ready.`
                : `Beginning of #${activeChannel}.`}
            </div>
          ) : (
            currentMessages.map((m) => (
              <div key={m.id} className="flex flex-col">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-white">{m.sender_alias}</span>
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

      {/* Right-Click Context Menu */}
      {contextMenu && (
        <div
          className="fixed bg-[#111214] border border-[#2b2d31] rounded-lg shadow-2xl py-1 w-44 z-50 text-xs font-sans text-slate-300"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === "contact" && (
            <>
              <button
                onClick={() => {
                  const c = contacts.find((item) => item.addr === contextMenu.targetId);
                  if (c) navigator.clipboard.writeText(c.pubkey);
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#5865f2] hover:text-white transition"
              >
                Copy Public Key
              </button>
              <button
                onClick={() => {
                  const c = contacts.find((item) => item.addr === contextMenu.targetId);
                  if (c) navigator.clipboard.writeText(c.addr);
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#5865f2] hover:text-white transition"
              >
                Copy IP / Port
              </button>
              <div className="h-[1px] bg-[#2b2d31] my-1" />
              <button
                onClick={() => {
                  setContacts((prev) => prev.filter((item) => item.addr !== contextMenu.targetId));
                  if (activeContact?.addr === contextMenu.targetId) {
                    setActiveContact(null);
                  }
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-rose-500 hover:bg-rose-600 hover:text-white transition"
              >
                Remove Contact
              </button>
            </>
          )}

          {contextMenu.type === "channel" && (
            <>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(`#${contextMenu.targetId}`);
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#5865f2] hover:text-white transition"
              >
                Copy Channel Name
              </button>
              <div className="h-[1px] bg-[#2b2d31] my-1" />
              <button
                onClick={() => {
                  setServers((prev) =>
                    prev.map((s) =>
                      s.id === activeServerId
                        ? { ...s, channels: s.channels.filter((c) => c !== contextMenu.targetId) }
                        : s
                    )
                  );
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-rose-500 hover:bg-rose-600 hover:text-white transition"
              >
                Delete Channel
              </button>
            </>
          )}

          {contextMenu.type === "server" && (
            <>
              <button
                onClick={() => {
                  setShowAddChannelModal(true);
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#5865f2] hover:text-white transition"
              >
                Create Channel
              </button>
              <div className="h-[1px] bg-[#2b2d31] my-1" />
              <button
                onClick={() => {
                  setServers((prev) => prev.filter((s) => s.id !== contextMenu.targetId));
                  setNavMode("dm");
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-rose-500 hover:bg-rose-600 hover:text-white transition"
              >
                Leave Server
              </button>
            </>
          )}
        </div>
      )}

      {/* Modal: Add Contact by Key / Invite */}
      {showAddContactModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <form
            onSubmit={parseAndAddInvite}
            className="bg-[#313338] border border-[#2b2d31] w-full max-w-md rounded-xl p-5 shadow-2xl"
          >
            <h3 className="text-white font-bold text-base mb-1">Add Peer by Invite or Key</h3>
            <p className="text-xs text-[#949ba4] mb-4">
              Paste a mesh invite link or direct <code>IP:Port</code>.
            </p>

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

      {/* Modal: Create Channel */}
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
                onClick={createChannel}
                className="text-xs px-4 py-2 bg-[#5865f2] hover:bg-[#4752c4] text-white rounded font-medium"
              >
                Create Channel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Create Server */}
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
