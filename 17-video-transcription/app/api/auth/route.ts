import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { createSession, destroySession, getSessionUser, verifyPassword } from "@/lib/auth"

export const dynamic = "force-dynamic"

export async function GET() {
  const user = await getSessionUser()
  return NextResponse.json({ user })
}

export async function POST(req: Request) {
  let body: { email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const email = (body.email ?? "").trim().toLowerCase()
  const password = body.password ?? ""
  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 })
  }

  const res = await db().query(
    `SELECT id, name, email, role, password_hash FROM users WHERE email = $1`,
    [email],
  )
  const row = res.rows[0]
  // No-enumeration: identical response for unknown email and wrong password.
  if (!row || !verifyPassword(password, row.password_hash)) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 })
  }

  await createSession(row.id)
  return NextResponse.json({
    user: { id: row.id, name: row.name, email: row.email, role: row.role },
  })
}

export async function DELETE() {
  await destroySession()
  return NextResponse.json({ ok: true })
}
