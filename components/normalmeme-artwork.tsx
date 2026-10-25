"use client"

import type { CSSProperties } from "react"
import { MemeOverlayText } from "@/components/meme-overlay-text"

interface NormalMemeArtworkProps {
  image?: string
  toptext?: string
  bottomtext?: string
  preview?: boolean
}

export function NormalMemeArtwork({ image, toptext, bottomtext, preview = false }: NormalMemeArtworkProps) {
  const textStyle: CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
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
    <div style={{
      position: "relative",
      width: "100%",
      height: "100%",
      containerType: "inline-size",
      background: "black",
    }}>
      {image ? (
        <img
          src={image}
          alt="Normal meme preview"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "fill",
            objectPosition: "center",
          }}
        />
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(45deg, #333, #666)",
          }}
        />
      )}
      {toptext ? (
        <MemeOverlayText
          text={toptext}
          position="top"
          style={{
            ...textStyle,
            padding: preview ? "4cqw 4cqw 4cqw" : "1rem 1rem 1rem",
          }}
        />
      ) : null}
      {bottomtext ? (
        <MemeOverlayText
          text={bottomtext}
          position="bottom"
          style={{
            ...textStyle,
            padding: preview ? "4cqw 4cqw 4cqw" : "1rem 1rem 1rem",
          }}
        />
      ) : null}
    </div>
  )
}
