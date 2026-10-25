"use client"

import { useEffect, useState, useRef } from 'react'
import { NormalMemeArtwork } from '@/components/normalmeme-artwork'

interface NormalMeme {
  _id: string
  image?: string
  toptext?: string
  bottomtext?: string
  user: string
}

export default function NormalMeme() {
  const [meme, setMeme] = useState<NormalMeme | null>(null)
  const lastMemeId = useRef<string | null>(null)

  useEffect(() => {
    const checkForNewMeme = async () => {
      try {
        const res = await fetch('/api/normalmeme/next')
        const data = await res.json()
        if (data._id && data._id !== lastMemeId.current) {
          setMeme(data)
          lastMemeId.current = data._id
        }
      } catch (e) {
        console.error('Error fetching normal meme:', e)
      }
    }

    checkForNewMeme()
    const interval = setInterval(checkForNewMeme, 1000)
    return () => clearInterval(interval)
  }, [])

  if (!meme) return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 9999
      }}
    />
  )

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: 9999,
        background: 'rgba(0,0,0,0.5)'
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100vw',
          height: '100vh'
        }}
      >
        <NormalMemeArtwork
          image={meme.image}
          toptext={meme.toptext}
          bottomtext={meme.bottomtext}
        />
      </div>
    </div>
  )
}