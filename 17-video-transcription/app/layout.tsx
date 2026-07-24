import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "SeekCast — Transcription & Moment Search",
  description:
    "Podcast/video transcription with timestamped moment search — keyword, semantic, and hybrid modes.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
