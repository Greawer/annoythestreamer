import type { Metadata } from "next"
import type { ReactNode } from "react"

export const metadata: Metadata = {
  title: "ATS: Sound Meme",
}

export default function SoundMemeLayout({ children }: { children: ReactNode }) {
  return children
}
