"use client"

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react"

interface MemeOverlayTextProps {
  text: string
  position: "top" | "bottom"
  className?: string
  style?: CSSProperties
}

export function MemeOverlayText({
  text,
  position,
  className,
  style,
}: MemeOverlayTextProps) {
  const textRef = useRef<HTMLDivElement>(null)
  const [overflowOffset, setOverflowOffset] = useState(0)
  const lines = text.toUpperCase().split("\n")

  useLayoutEffect(() => {
    if (position !== "bottom") return
    const element = textRef.current
    if (!element) return

    const updateOverflowOffset = () => {
      const lineCount = Array.from(element.children).reduce((count, line) => {
        const range = document.createRange()
        range.selectNodeContents(line)
        return count + Math.max(1, range.getClientRects().length)
      }, 0)
      const computedLineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
      if (!Number.isFinite(computedLineHeight)) return
      setOverflowOffset(Math.max(0, lineCount - 3) * computedLineHeight)
    }

    updateOverflowOffset()
    const observer = new ResizeObserver(updateOverflowOffset)
    observer.observe(element)
    return () => observer.disconnect()
  }, [position, text])

  return (
    <div
      ref={textRef}
      className={className}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        textAlign: "center",
        overflowWrap: "anywhere",
        ...(position === "top"
          ? { top: 0 }
          : { bottom: `-${overflowOffset}px` }),
        ...style,
      }}
    >
      {lines.map((line, index) => (
        <span key={index} style={{ display: "block" }}>
          {line || "\u00a0"}
        </span>
      ))}
    </div>
  )
}
