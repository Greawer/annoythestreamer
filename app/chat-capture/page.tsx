"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

interface ChatMessage {
  user: string;
  message: string;
  id?: string;
}

const admins = ["Greawer"];
const colors = { admin: "#ffc0cb", user: "#a855f7", self: "#ef4444" };

const getCookie = (name: string) => {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop()?.split(";").shift() || "";
  return "";
};

const getUserColor = (user: string, currentUsername: string) => {
  if (admins.includes(user)) return colors.admin;
  if (user === currentUsername) return colors.self;
  return colors.user;
};

const ChatCapturePage = () => {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [emojis, setEmojis] = useState<string[]>([]);
  const [currentUsername, setCurrentUsername] = useState("");
  const chatBoxRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const usernameFromCookie = getCookie("ats_username") || "OBS";
    setCurrentUsername(usernameFromCookie);
  }, []);

  useEffect(() => {
    const loadEmojis = async () => {
      try {
        const res = await fetch("/api/list-emojis");
        if (!res.ok) throw new Error(res.statusText);
        const data = await res.json();
        setEmojis(data);
      } catch (err) {
        console.warn("Failed to load emojis:", err);
      }
    };
    loadEmojis();
  }, []);

  useEffect(() => {
    if (!currentUsername) return;

    socketRef.current = io(window.location.origin, { query: { username: currentUsername } });

    socketRef.current.on("chat_message", (msg: ChatMessage) =>
      setChatMessages((prev) => [...prev, msg])
    );
    socketRef.current.on("chat_history", (msgs: ChatMessage[]) => {
      setChatMessages(msgs.slice(-50));
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, [currentUsername]);

  // Auto-scroll to bottom whenever messages change
  useEffect(() => {
    if (chatBoxRef.current) {
      chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const renderMessageWithEmojis = (message: string) => {
    const parts = message.split(/(:\w+:)/g);
    return parts.map((part, idx) => {
      const emojiName = part.replace(/:/g, "");
      if (emojis.includes(emojiName)) {
        return (
          <img
            key={idx}
            src={`/img/emoji/${emojiName}.png`}
            alt={emojiName}
            className="inline h-5 w-5 align-text-bottom"
          />
        );
      } else if (part.startsWith("@")) {
        return (
          <span key={idx} className="mention-tag">
            {part}
          </span>
        );
      } else {
        return <span key={idx}>{part}</span>;
      }
    });
  };

  return (
    <div
      ref={chatBoxRef}
      className="flex flex-col gap-0.5 p-2 h-full font-sans text-foreground text-base overflow-auto scrollbar-none"
      style={{
        height: "100%",
        scrollbarWidth: "none",
        msOverflowStyle: "none",
      }}
    >
      <style>{`
        /* Hide scrollbar for Chrome, Safari and Opera */
        .scrollbar-none::-webkit-scrollbar {
          display: none;
        }
        html, body {
          overflow: hidden;
          height: 100%;
          margin: 0;
          padding: 0;
        }
      `}</style>

      {chatMessages.length === 0 && (
        <div className="text-center text-muted-foreground py-4">
          No messages yet.
        </div>
      )}

      {chatMessages.map((msg, idx) => {
        const isMentioned = new RegExp(`@${currentUsername}\\b`, "i").test(msg.message);
        const highlightClass = isMentioned ? "mention-highlight-self" : "";

        return (
          <div
            key={msg.id || idx}
            className={`group p-1 sm:p-1.5 rounded flex items-start justify-between gap-2 ${highlightClass}`}
          >
            <div className="flex-1 min-w-0 break-words">
              <span style={{ color: getUserColor(msg.user, currentUsername) }} className="font-semibold">
                {msg.user}:
              </span>{" "}
              <span className="break-words">{renderMessageWithEmojis(msg.message)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default ChatCapturePage;
