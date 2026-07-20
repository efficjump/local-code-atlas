import { findActiveSession } from "../services/session-service.js";

export async function getSession(request: { params: { token: string } }) {
  return findActiveSession(request.params.token);
}
