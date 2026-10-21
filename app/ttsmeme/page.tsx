"use client"

import { useEffect, useRef, useState } from 'react'

interface TTSMeme {
  id: string
  filepath: string
  text: string
  user: string
}

export default function TTSMeme() {
  const [ttsQueue, setTtsQueue] = useState<TTSMeme[]>([])
  const [currentPlaying, setCurrentPlaying] = useState<TTSMeme | null>(null)
  const [status, setStatus] = useState('Polling...')
  const audioRef = useRef<HTMLAudioElement>(null)
  const lastIdRef = useRef<string>('')
  const queueRef = useRef<TTSMeme[]>([])
  const currentPlayingRef = useRef<TTSMeme | null>(null)
  const isStartingRef = useRef(false)
  const blockedAutoplayIdRef = useRef<string | null>(null)
  const playbackAttemptsRef = useRef(new Map<string, number>())
  const isHandlingFailureRef = useRef(false)
  const isCompletingRef = useRef(false)

  async function playNext() {
    if (isStartingRef.current || isHandlingFailureRef.current || isCompletingRef.current || currentPlayingRef.current) return
    const next = queueRef.current[0]
    const audio = audioRef.current
    if (!next || !audio) {
      setCurrentPlaying(null)
      setStatus('Ready - Queue: 0')
      return
    }
    isStartingRef.current = true
    currentPlayingRef.current = next
    setCurrentPlaying(next)
    setStatus(`Playing: "${next.text}"`)
    audio.pause()
    audio.src = next.filepath
    audio.load()
    try {
      await audio.play()
      blockedAutoplayIdRef.current = null
    } catch (error) {
      await handlePlaybackFailure(error)
    }
  }

  async function handlePlaybackFailure(error: unknown) {
    const failed = currentPlayingRef.current
    if (!failed || isHandlingFailureRef.current || isCompletingRef.current) return

    if (error instanceof Error && error.name === 'NotAllowedError') {
      isStartingRef.current = false
      currentPlayingRef.current = null
      setCurrentPlaying(null)
      if (blockedAutoplayIdRef.current !== failed.id) {
        console.warn('TTS autoplay blocked by the browser; allow audio playback for this OBS Browser Source.')
        blockedAutoplayIdRef.current = failed.id
      }
      setStatus('Browser blocked audio playback')
      return
    }

    isHandlingFailureRef.current = true
    isStartingRef.current = false
    currentPlayingRef.current = null
    setCurrentPlaying(null)
    const attempts = (playbackAttemptsRef.current.get(failed.id) ?? 0) + 1
    playbackAttemptsRef.current.set(failed.id, attempts)
    console.error(`TTS playback failed for ${failed.id} (attempt ${attempts}/3):`, error)

    if (attempts < 3) {
      setStatus(`TTS playback failed; retrying (${attempts}/3)`)
      const audio = audioRef.current
      audio?.pause()
      audio?.removeAttribute('src')
      audio?.load()
      setTimeout(() => {
        isHandlingFailureRef.current = false
        void playNext()
      }, attempts * 500)
      return
    }

    setStatus('TTS playback failed after retries; skipping this item')
    await completeItem(failed)
  }

  async function completeItem(item: TTSMeme) {
    if (isCompletingRef.current) return
    isCompletingRef.current = true
    try {
      const response = await fetch(`/api/tts/done/${item.id}`, { method: 'PUT' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch (error) {
      console.error(`Failed to acknowledge TTS item ${item.id}; keeping it queued:`, error)
      setStatus('TTS queue update failed; retrying')
      isCompletingRef.current = false
      setTimeout(() => void completeItem(item), 2000)
      return
    }

    if (queueRef.current[0]?.id === item.id) {
      queueRef.current = queueRef.current.slice(1)
      setTtsQueue(queueRef.current)
    }
    playbackAttemptsRef.current.delete(item.id)
    currentPlayingRef.current = null
    isStartingRef.current = false
    isHandlingFailureRef.current = false
    isCompletingRef.current = false
    setCurrentPlaying(null)
    setTimeout(() => void playNext(), 200)
  }

  async function handleEnded() {
    const finished = currentPlayingRef.current
    if (finished) await completeItem(finished)
  }

  useEffect(() => {
    const pollTTS = async () => {
      try {
        const res = await fetch('/api/ttsmeme/next')
        if (!res.ok) {
          console.error(`TTS queue request failed: HTTP ${res.status}`)
          return
        }
        const data = await res.json()
        if (data && data.id && data.id !== lastIdRef.current && data.filepath) {
          const nextQueue = [...queueRef.current, data]
          queueRef.current = nextQueue
          setTtsQueue(nextQueue)
          lastIdRef.current = data.id
        }
        if (queueRef.current.length > 0 && !currentPlayingRef.current) void playNext()
      } catch (error: unknown) {
        setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const interval = setInterval(pollTTS, 2000)
    pollTTS()
    return () => {
      clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const handleError = () => {
      const mediaError = audio.error
      void handlePlaybackFailure(new Error(mediaError?.message || `Media error ${mediaError?.code ?? 'unknown'}`))
    }
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('error', handleError)
    return () => {
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('error', handleError)
    }
  }, [])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8 gap-8 max-w-2xl mx-auto">
      <audio ref={audioRef} crossOrigin="anonymous" preload="auto" />
      <p role="status" aria-live="polite" className="sr-only">{status}; queue: {ttsQueue.length}</p>
      {currentPlaying && (
        <div className="backdrop-blur-sm bg-gradient-to-b from-black/80 to-black/40 rounded-2xl p-8 shadow-2xl border border-white/20 w-full text-center">
          <div className="text-5xl mb-6 animate-pulse">🎤</div>
          <p className="text-2xl font-bold text-white mb-4">{currentPlaying.text}</p>
          <p className="text-xl text-blue-300">- {currentPlaying.user}</p>
        </div>
      )}
    </div>
  )
}