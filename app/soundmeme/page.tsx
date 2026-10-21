"use client";

import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";

export default function SoundMeme() {
  const socketRef = useRef<Socket | null>(null);
  const audioPool = useRef<HTMLAudioElement[]>([]);

  useEffect(() => {
    // Pre-create audio pool
    for (let i = 0; i < 10; i++) {
      const audio = new Audio();
      audio.crossOrigin = "anonymous";
      audio.volume = 0.8;
      audioPool.current.push(audio);
    }

    socketRef.current = io(window.location.origin, {
      transports: ['websocket']
    });

    socketRef.current.on("playsound", (data: { file: string }) => {
      const filename = data.file.replace(/\.mp3$/i, '');
      playFromPool(`/static/sounds/soundboard/${filename}.mp3`);
    });

    return () => {
      socketRef.current?.disconnect();
      audioPool.current.forEach(audio => audio.pause());
    };
  }, []);

  const playFromPool = (src: string) => {
    let audio = audioPool.current.find(a => a?.ended || a?.paused);
    if (!audio) {
      audio = new Audio(src);
      audio.crossOrigin = "anonymous";
      audio.volume = 0.8;
      audioPool.current.push(audio);
    }

    audio.src = src;
    audio.currentTime = 0;
    audio.play().catch((error: unknown) => {
      if (error instanceof Error && error.name === "NotAllowedError") {
        console.error("Sound autoplay blocked; allow audio playback for this OBS Browser Source.");
      } else {
        console.error("Sound playback failed:", error);
      }
    });

  };

  return null;
}