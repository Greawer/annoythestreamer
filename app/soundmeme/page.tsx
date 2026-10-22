"use client";

import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";

export default function SoundMeme() {
  const socketRef = useRef<Socket | null>(null);
  const audioPool = useRef<HTMLAudioElement[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodesRef = useRef(new WeakMap<HTMLAudioElement, GainNode>());

  useEffect(() => {
    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    for (let i = 0; i < 10; i++) {
      const audio = new Audio();
      audio.crossOrigin = "anonymous";
      audio.volume = 1;
      const source = audioContext.createMediaElementSource(audio);
      const gain = audioContext.createGain();
      source.connect(gain);
      gain.connect(audioContext.destination);
      gainNodesRef.current.set(audio, gain);
      audioPool.current.push(audio);
    }

    socketRef.current = io(window.location.origin, {
      transports: ['websocket']
    });

    socketRef.current.on("playsound", (data: { file: string; loudness?: number }) => {
      const filename = data.file.replace(/\.mp3$/i, '');
      playFromPool(
        `/static/sounds/soundboard/${filename}.mp3`,
        typeof data.loudness === "number" ? data.loudness : 0.8,
      );
    });

    const pooledAudio = audioPool.current;
    return () => {
      socketRef.current?.disconnect();
      pooledAudio.forEach(audio => audio.pause());
      void audioContext.close();
      audioContextRef.current = null;
    };
  }, []);

  const playFromPool = (src: string, loudness: number) => {
    let audio = audioPool.current.find(a => a?.ended || a?.paused);
    if (!audio) {
      audio = new Audio(src);
      audio.crossOrigin = "anonymous";
      audio.volume = 1;
      audioPool.current.push(audio);
      const audioContext = audioContextRef.current;
      if (!audioContext) {
        console.error("Sound playback audio context is unavailable.");
        return;
      }
      const source = audioContext.createMediaElementSource(audio);
      const gain = audioContext.createGain();
      source.connect(gain);
      gain.connect(audioContext.destination);
      gainNodesRef.current.set(audio, gain);
    }

    audio.src = src;
    const gain = gainNodesRef.current.get(audio);
    if (!gain) {
      console.error("Sound playback gain node is unavailable.");
      return;
    }
    gain.gain.value = Math.max(0, Math.min(2, loudness));
    const audioContext = audioContextRef.current;
    if (audioContext?.state === "suspended") {
      void audioContext.resume().catch((error: unknown) => {
        console.error("Sound playback audio context could not be resumed:", error);
      });
    }
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