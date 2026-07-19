export interface UserRecord {
  id: string;
  active: boolean;
}

export function saveUser(user: UserRecord): UserRecord {
  return user;
}
