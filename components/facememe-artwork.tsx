"use client"

import type { CSSProperties } from "react"
import { MemeOverlayText } from "@/components/meme-overlay-text"

interface FaceMemeArtworkProps {
  toptext: string
  bottomtext: string
  preview?: boolean
}

export function FaceMemeArtwork({ toptext, bottomtext, preview = false }: FaceMemeArtworkProps) {
  const frameStyle = preview
    ? {
        width: "100%",
        height: "100%",
        boxSizing: "border-box" as const,
        containerType: "inline-size" as const,
        display: "flex",
        flexDirection: "column" as const,
        justifyContent: "space-between",
        position: "relative" as const,
        overflow: "hidden",
      }
    : undefined
  const textStyle: CSSProperties = {
    color: "white",
    fontSize: preview ? "8cqw" : "clamp(2rem, 8cqw, 5rem)",
    fontWeight: "bold",
    WebkitTextStroke: preview ? "0.25cqw black" : "1px black",
    textShadow: preview ? "0.5cqw 0.5cqw 1cqw black" : "2px 2px 4px black",
    textAlign: "center",
    fontFamily: '"Impact", "Arial Black", sans-serif',
    letterSpacing: preview ? "0.25cqw" : "1px",
    lineHeight: 1.1,
    whiteSpace: "pre-wrap",
  }

  return (
    <div
      className={preview
        ? "flex h-full w-full flex-col justify-between"
        : "fixed inset-0 pointer-events-none z-50 flex flex-col justify-between p-8 sm:p-12 md:p-16 lg:p-24 xl:p-32"}
      style={frameStyle}
    >
      <img
        src="/img/meme/facememe/facememe-template-placeholder.png"
        alt=""
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "fill",
          background: "black",
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.3)",
          pointerEvents: "none",
        }}
      />
      <MemeOverlayText
        text={toptext}
        position="top"
        style={{
          ...textStyle,
          padding: preview ? "4cqw 4cqw 4cqw" : "1rem 1rem 1rem",
          zIndex: 10,
        }}
      />
      <MemeOverlayText
        text={bottomtext}
        position="bottom"
        style={{
          ...textStyle,
          padding: preview ? "4cqw 4cqw 4cqw" : "1rem 1rem 1rem",
          zIndex: 10,
        }}
      />
    </div>
  )
}
