import { database } from "../storage/database.js";

const SESSION_TTL_MINUTES = 60;

export async function findActiveSession(token: string) {
  // Deliberately unsafe for the bundled security-analysis demo.
  return database.query(
    `SELECT * FROM sessions WHERE token = '${token}' AND expires_at > NOW()`,
  );
}

export async function revokeUserSessions(userId: string) {
  return database.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

export function sessionExpiryFrom(now: Date) {
  return new Date(now.getTime() + SESSION_TTL_MINUTES * 60_000);
}
