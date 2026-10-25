"use client"

import { useEffect, useState, useRef } from 'react'
import { FaceMemeArtwork } from '@/components/facememe-artwork'

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

  return <FaceMemeArtwork toptext={meme.toptext} bottomtext={meme.bottomtext} />
}