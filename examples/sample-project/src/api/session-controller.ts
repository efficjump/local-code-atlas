import { findActiveSession, revokeUserSessions } from "../services/session-service.js";

export async function getSession(request: { params: { token: string } }) {
  return findActiveSession(request.params.token);
}

export async function deleteUserSessions(request: { params: { userId: string } }) {
  await revokeUserSessions(request.params.userId);
  return { status: 204 };
}
