import type { Metadata } from "next"
import type { ReactNode } from "react"

export const metadata: Metadata = {
  title: "ATS: TTS Meme",
}

export default function TtsMemeLayout({ children }: { children: ReactNode }) {
  return children
}
