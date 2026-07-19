import { saveUser, type UserRecord } from "./repository";

export interface User {
  id: string;
  active: boolean;
}

export const password = "fixture-value-that-must-be-redacted";

export function deactivateUser(user: User): UserRecord {
  const inactive = { ...user, active: false };
  return saveUser(inactive);
}
