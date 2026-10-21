"use client"

import { useEffect, useState, useRef } from 'react'

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
        {/* Image - full viewport stretch */}
        {meme.image ? (
          <img
            src={meme.image}
            alt="Normal meme"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'fill',
              objectPosition: 'center'
            }}
          />
        ) : (
          /* Fallback background for text-only */
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'linear-gradient(45deg, #333, #666)',
              width: '100%',
              height: '100%'
            }}
          />
        )}

        {/* Top text - FaceMeme style */}
        {meme.toptext ? (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              color: 'white',
              padding: '2rem 1rem 1rem',
              fontSize: 'clamp(2rem, 8vw, 5rem)',
              fontWeight: 'bold',
              textShadow: '2px 2px 4px black',
              textAlign: 'center',
              fontFamily: '"Impact", "Arial Black", sans-serif',
              letterSpacing: '1px',
              lineHeight: 1.1
            }}
          >
            {meme.toptext.toUpperCase()}
          </div>
        ) : null}

        {/* Bottom text - FaceMeme style */}
        {meme.bottomtext ? (
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              color: 'white',
              padding: '1rem 1rem 2rem',
              fontSize: 'clamp(2rem, 8vw, 5rem)',
              fontWeight: 'bold',
              textShadow: '2px 2px 4px black',
              textAlign: 'center',
              fontFamily: '"Impact", "Arial Black", sans-serif',
              letterSpacing: '1px',
              lineHeight: 1.1
            }}
          >
            {meme.bottomtext.toUpperCase()}
          </div>
        ) : null}
      </div>
    </div>
  )
}