import type { Metadata } from "next"
import type { ReactNode } from "react"

export const metadata: Metadata = {
  title: "ATS: Normal Meme",
}

export default function NormalMemeLayout({ children }: { children: ReactNode }) {
  return children
}
