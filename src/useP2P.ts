import { useState, useRef, useEffect } from "react";

export interface Message {
  id: string;
  sender: string;
  text: string;
  timestamp: string;
}

export function useP2P() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionString, setConnectionString] = useState<string>("");
  const [isSupported, setIsSupported] = useState(true);

  const pc = useRef<RTCPeerConnection | null>(null);
  const dataChannel = useRef<RTCDataChannel | null>(null);

  useEffect(() => {
    // Check if the current webview engine exposes WebRTC
    if (typeof window === "undefined" || !("RTCPeerConnection" in window)) {
      console.warn("RTCPeerConnection is not supported in this webview environment.");
      setIsSupported(false);
      return;
    }

    try {
      pc.current = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      pc.current.oniceconnectionstatechange = () => {
        setIsConnected(pc.current?.iceConnectionState === "connected");
      };
    } catch (err) {
      console.error("Failed to initialize RTCPeerConnection:", err);
      setIsSupported(false);
    }

    return () => {
      pc.current?.close();
    };
  }, []);

  const setupChannel = (channel: RTCDataChannel) => {
    dataChannel.current = channel;
    channel.onopen = () => setIsConnected(true);
    channel.onclose = () => setIsConnected(false);
    channel.onmessage = (e) => {
      try {
        const msg: Message = JSON.parse(e.data);
        setMessages((prev) => [...prev, msg]);
      } catch (err) {
        console.error("Invalid packet:", err);
      }
    };
  };

  const createRoom = async () => {
    if (!pc.current) return;
    const channel = pc.current.createDataChannel("chat");
    setupChannel(channel);

    const offer = await pc.current.createOffer();
    await pc.current.setLocalDescription(offer);

    pc.current.onicecandidate = () => {
      if (pc.current?.localDescription) {
        setConnectionString(btoa(JSON.stringify(pc.current.localDescription)));
      }
    };
  };

  const joinRoom = async (offerBase64: string) => {
    if (!pc.current) return;
    pc.current.ondatachannel = (e) => setupChannel(e.channel);

    const offer = JSON.parse(atob(offerBase64));
    await pc.current.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.current.createAnswer();
    await pc.current.setLocalDescription(answer);

    pc.current.onicecandidate = () => {
      if (pc.current?.localDescription) {
        setConnectionString(btoa(JSON.stringify(pc.current.localDescription)));
      }
    };
  };

  const finalizeHost = async (answerBase64: string) => {
    if (!pc.current) return;
    const answer = JSON.parse(atob(answerBase64));
    await pc.current.setRemoteDescription(new RTCSessionDescription(answer));
  };

  const sendMessage = (text: string, sender: string) => {
    if (dataChannel.current?.readyState === "open") {
      const msg: Message = {
        id: crypto.randomUUID(),
        sender,
        text,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      dataChannel.current.send(JSON.stringify(msg));
      setMessages((prev) => [...prev, msg]);
    }
  };

  return { messages, isConnected, connectionString, isSupported, createRoom, joinRoom, finalizeHost, sendMessage };
}
