export interface Profile {
  displayName: string;
}

export function formatProfile(profile: Profile): string {
  return profile.displayName.trim();
}
