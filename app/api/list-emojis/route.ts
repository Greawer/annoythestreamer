import fs from "fs"
import path from "path"
import { NextResponse } from "next/server"

export async function GET() {
  try {
    const emojisDir = path.join(process.cwd(), "public", "img", "emoji")
    const files = fs.readdirSync(emojisDir)
    const emojis = files
      .filter((f) => f.endsWith(".png"))
      .map((f) => f.replace(/\.png$/, "")) // strip extension
    return NextResponse.json(emojis)
  } catch (err) {
    console.error("Failed to list emojis:", err)
    return NextResponse.json([], { status: 500 })
  }
}