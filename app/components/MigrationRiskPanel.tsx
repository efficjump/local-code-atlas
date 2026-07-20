"use client";

import { useMemo, useState } from "react";

export type MigrationReviewStatus =
  | "complete"
  | "partial"
  | "not-run"
  | "failed";

export type MigrationRiskSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "info";

export interface MigrationRiskView {
  status: MigrationReviewStatus;
  comparison?: {
    mode: "working-tree" | "staged" | "base" | "unknown";
    label: string;
    beforeSource?: string;
    afterSource?: string;
  };
  summary: {
    files: number;
    operations: number;
    risks: number;
    destructive: number;
    safe: number;
    bySeverity: Record<MigrationRiskSeverity, number>;
  };
  risks: Array<{
    id: string;
    label: string;
    category: string;
    severity: MigrationRiskSeverity;
    destructive: boolean;
    safe: boolean;
    confidence: number;
    explanation: string;
    remediation: string;
    table?: string;
    column?: string;
    nextName?: string;
    file: string;
    line?: number;
    relevance: "direct" | "indirect" | "project" | "unknown";
    introduced: boolean;
  }>;
  diagnostics: string[];
}

interface MigrationRiskPanelProps {
  migration: MigrationRiskView;
  copySource?: (file: string, line?: number) => void | Promise<void>;
}

const SEVERITY_ORDER: Record<MigrationRiskSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function sourceLabel(file: string, line?: number): string {
  return `${file}${line ? `:${line}` : ""}`;
}

function statusMessage(status: MigrationReviewStatus): string {
  if (status === "partial") {
    return "Some relevant migration input could not be compared or interpreted. An empty list is not a clean result.";
  }
  if (status === "failed") {
    return "Migration comparison failed. Review the diagnostics before making a schema decision.";
  }
  if (status === "not-run") {
    return "No supported migration file was present in the selected Git comparison, so no safety conclusion was made.";
  }
  return "Every supported migration operation in the selected comparison was evaluated locally.";
}

export function MigrationRiskPanel({
  migration,
  copySource,
}: MigrationRiskPanelProps) {
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState<MigrationRiskSeverity | "all">("all");
  const [category, setCategory] = useState("all");
  const categories = useMemo(
    () =>
      [...new Set(migration.risks.map((risk) => risk.category))].sort((a, b) =>
        a.localeCompare(b, "en"),
      ),
    [migration.risks],
  );
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return migration.risks
      .filter((risk) => severity === "all" || risk.severity === severity)
      .filter((risk) => category === "all" || risk.category === category)
      .filter(
        (risk) =>
          !normalizedQuery ||
          [
            risk.label,
            risk.category,
            risk.table,
            risk.column,
            risk.file,
            risk.explanation,
          ]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedQuery),
      )
      .sort(
        (left, right) =>
          SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity] ||
          Number(right.destructive) - Number(left.destructive) ||
          left.file.localeCompare(right.file, "en") ||
          (left.line ?? 0) - (right.line ?? 0),
      );
  }, [category, migration.risks, query, severity]);

  return (
    <section className="atlas-migration-review" aria-labelledby="atlas-migration-title">
      <div className="atlas-migration-heading">
        <div>
          <span className="atlas-section-label">GIT-AWARE SCHEMA CHANGE</span>
          <h3 id="atlas-migration-title">Migration review</h3>
          <p>{statusMessage(migration.status)}</p>
        </div>
        <span className="atlas-migration-status" data-status={migration.status}>
          {migration.status.replaceAll("-", " ")}
        </span>
      </div>

      {migration.comparison && (
        <div className="atlas-migration-comparison">
          <strong>{migration.comparison.label}</strong>
          <span>
            {migration.comparison.beforeSource ?? "before"} →{" "}
            {migration.comparison.afterSource ?? "after"}
          </span>
        </div>
      )}

      {(migration.status === "partial" || migration.status === "failed") && (
        <div className="atlas-migration-warning" role="alert">
          <strong>Do not treat missing findings as safe.</strong>
          <span>{migration.diagnostics[0] ?? statusMessage(migration.status)}</span>
        </div>
      )}

      <div className="atlas-migration-summary" aria-label="Migration review summary">
        <article>
          <span>FILES</span>
          <strong>{migration.summary.files}</strong>
        </article>
        <article>
          <span>OPERATIONS</span>
          <strong>{migration.summary.operations}</strong>
        </article>
        <article>
          <span>REVIEW RISKS</span>
          <strong>{migration.summary.risks}</strong>
        </article>
        <article>
          <span>DESTRUCTIVE</span>
          <strong>{migration.summary.destructive}</strong>
        </article>
        <article>
          <span>SAFE CHANGES</span>
          <strong>{migration.summary.safe}</strong>
        </article>
      </div>

      {migration.risks.length > 0 && (
        <div className="atlas-filter-bar atlas-migration-filters" aria-label="Migration risk filters">
          <label className="atlas-filter-search">
            <span>Find an operation</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="table, column, source…"
            />
          </label>
          <label>
            <span>Severity</span>
            <select
              value={severity}
              onChange={(event) =>
                setSeverity(event.target.value as MigrationRiskSeverity | "all")
              }
            >
              <option value="all">All severities</option>
              {(["critical", "high", "medium", "low", "info"] as const).map(
                (value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            <span>Operation</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="all">All operations</option>
              {categories.map((value) => (
                <option value={value} key={value}>
                  {value.replaceAll("-", " ")}
                </option>
              ))}
            </select>
          </label>
          <p aria-live="polite">
            <strong>{filtered.length}</strong> of {migration.risks.length} shown
          </p>
        </div>
      )}

      <div className="atlas-migration-list">
        {filtered.map((risk) => (
          <details
            className="atlas-migration-item"
            key={risk.id}
            open={risk.destructive || risk.severity === "critical"}
          >
            <summary>
              <span className={`atlas-severity-pill atlas-severity-pill--${risk.severity}`}>
                {risk.severity}
              </span>
              <span>
                <strong>{risk.category.replaceAll("-", " ")}</strong>
                <small>
                  {risk.label} · {sourceLabel(risk.file, risk.line)}
                </small>
              </span>
              <span className="atlas-migration-flags">
                {risk.destructive && <b>destructive</b>}
                {risk.safe && <b>safe</b>}
                <small>{Math.round(risk.confidence * 100)}% confidence</small>
              </span>
              <span className="atlas-disclosure" aria-hidden="true">
                +
              </span>
            </summary>
            <div className="atlas-migration-detail">
              <section>
                <span>WHY THIS MATTERS</span>
                <p>{risk.explanation}</p>
              </section>
              <section>
                <span>SAFER NEXT STEP</span>
                <p>{risk.remediation}</p>
              </section>
              <footer>
                <div>
                  <code>{risk.id}</code>
                  {risk.relevance !== "unknown" && <b>{risk.relevance} relevance</b>}
                </div>
                <button
                  type="button"
                  className="atlas-copy-source"
                  onClick={() => void copySource?.(risk.file, risk.line)}
                  aria-label={`Copy source location ${sourceLabel(risk.file, risk.line)}`}
                >
                  Copy <code>{sourceLabel(risk.file, risk.line)}</code>
                </button>
              </footer>
            </div>
          </details>
        ))}
        {migration.status !== "not-run" && migration.risks.length === 0 && (
          <div className="atlas-migration-empty">
            <strong>No introduced operations require review.</strong>
            <p>
              This statement applies only to supported migration inputs in the selected
              comparison and is not a guarantee that deployment is risk-free.
            </p>
          </div>
        )}
        {migration.risks.length > 0 && filtered.length === 0 && (
          <div className="atlas-migration-empty">
            <strong>No operations match these filters.</strong>
            <p>Adjust the search, severity, or operation filter.</p>
          </div>
        )}
      </div>

      {migration.diagnostics.length > 1 && (
        <details className="atlas-migration-diagnostics">
          <summary>Migration diagnostics · {migration.diagnostics.length}</summary>
          <ul>
            {migration.diagnostics.map((diagnostic) => (
              <li key={diagnostic}>{diagnostic}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
