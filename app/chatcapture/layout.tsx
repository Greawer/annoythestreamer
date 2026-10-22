import type { Metadata } from "next"
import type { ReactNode } from "react"

export const metadata: Metadata = {
  title: "ATS: Chatcapture",
}

export default function ChatCaptureLayout({ children }: { children: ReactNode }) {
  return children
}
