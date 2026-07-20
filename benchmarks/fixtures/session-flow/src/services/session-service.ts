import { database } from "../storage/database.js";

export async function findActiveSession(token: string) {
  return database.query(
    `SELECT * FROM sessions WHERE token = '${token}' AND expires_at > NOW()`,
  );
}

export function sessionExpiryFrom(now: Date) {
  return new Date(now.getTime() + 60 * 60_000);
}
