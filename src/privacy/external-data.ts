/**
 * Public, user-facing descriptions of the fields included in optional network
 * requests. Keep these lists beside the request implementations so the health
 * endpoint, analysis receipt, and workbench disclosure cannot drift apart.
 */
export const OSV_REQUEST_FIELDS = [
  "package ecosystem",
  "package name",
  "exact version",
] as const;
export const AI_SYNTHESIS_REQUEST_FIELDS = [
  "project name",
  "detected languages and frameworks",
  "question",
  "project-relative evidence paths",
  "bounded redacted impact and security evidence",
  "table and column names",
] as const;
