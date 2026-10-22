import type { Metadata } from "next"
import type { ReactNode } from "react"

export const metadata: Metadata = {
  title: "ATS: Face Meme",
}

export default function FaceMemeLayout({ children }: { children: ReactNode }) {
  return children
}
