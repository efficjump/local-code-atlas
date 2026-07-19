import { deactivateUser } from "@fixture/user/service";

export function handleDeactivateRequest(userId: string) {
  return deactivateUser({ id: userId, active: true });
}
