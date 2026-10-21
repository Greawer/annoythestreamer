"use client"

import { useEffect, useState, useRef } from 'react'

interface FaceMeme {
  _id: string
  toptext: string
  bottomtext: string
  user: string
}

export default function FaceMeme() {
  const [meme, setMeme] = useState<FaceMeme | null>(null)
  const lastMemeId = useRef<string | null>(null)

  useEffect(() => {
    const checkForNewMeme = async () => {
      const res = await fetch('/api/facememe/next')
      const data = await res.json()
      if (data?._id && data._id !== lastMemeId.current) {
        setMeme(data)
        lastMemeId.current = data._id
      }
    }

    checkForNewMeme()
    const interval = setInterval(checkForNewMeme, 1000)
    return () => clearInterval(interval)
  }, [])

  if (!meme) return null

  return (
    <div className="fixed inset-0 pointer-events-none z-50 flex flex-col justify-between p-8 sm:p-12 md:p-16 lg:p-24 xl:p-32 bg-black/70">
      {/* Top text - pinned top, centered */}
      <div className="flex justify-center">
        <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl xl:text-8xl font-black text-white uppercase tracking-wider drop-shadow-[0_4px_12px_rgba(0,0,0,0.9)] leading-tight break-words max-w-full overflow-hidden text-center">
          {meme.toptext}
        </h1>
      </div>
      {/* Bottom text - pinned bottom, centered */}
      <div className="flex justify-center">
        <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl xl:text-8xl font-black text-white uppercase tracking-wider drop-shadow-[0_4px_12px_rgba(0,0,0,0.9)] leading-tight break-words max-w-full overflow-hidden text-center">
          {meme.bottomtext}
        </h1>
      </div>
    </div>
  )
}