'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { ApiError, apiGet, apiPost } from '../../../lib/api/client';
import { buildCsvPreview, CSV_FIELD_COLUMNS, splitCsvLines } from '../../../lib/claims/csv-preview';
import { useActingUser } from '../../../lib/use-acting-user';
import { queryKeys } from '../../../lib/query/keys';

type Project = { id: string; code: string; name: string };

type ImportedClaim = {
  id: string;
  reference: string;
  total: number | string;
  project?: { code: string; name: string };
  lines?: unknown[];
};

type FailedGroup = { group: string; rowNumbers: number[]; reasons: string[] };

type ImportResult = { created: ImportedClaim[]; failed: FailedGroup[] };

const CSV_HEADER = 'expense_date,description,quantity,unit_price,is_fuel,group';
const CSV_SAMPLE = `${CSV_HEADER}
2026-02-10,Diesel,3,19.99,true,A
2026-02-10,Timber,1,"1,299.50",false,A
2026-02-11,Paint,2,45.00,false,B`;

export default function ImportClaimsPage() {
  const queryClient = useQueryClient();
  const { can } = useActingUser();
  const canCreate = can('claims.create');

  const [projectId, setProjectId] = useState('');
  const [csv, setCsv] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const projects = useQuery({
    queryKey: queryKeys.projects.list(1, 'ACTIVE'),
    queryFn: () => apiGet<Project[]>('/projects?pageSize=100&status=ACTIVE'),
  });

  const importer = useMutation({
    mutationFn: (payload: { projectId: string; csv: string }) =>
      apiPost<ImportResult>('/claims/import', payload),
    onSuccess: (res) => {
      // Only refresh the list if at least one claim was actually created.
      if (res.data.created.length > 0) {
        queryClient.invalidateQueries({ queryKey: queryKeys.claims.all });
      }
    },
    onError: (err) => {
      setFormError(err instanceof ApiError ? err.message : 'Import failed');
    },
  });

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    try {
      const text = await file.text();
      setCsv(text);
      setFormError(null);
    } catch {
      setFormError('Could not read that file');
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!projectId) {
      setFormError('Select a cost code (project) for the imported claims');
      return;
    }
    if (!csv.trim()) {
      setFormError('Paste or upload a LegacyPlant CSV first');
      return;
    }
    importer.mutate({ projectId, csv });
  }

  function loadSample() {
    setCsv(CSV_SAMPLE);
    setFileName(null);
    setFormError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function clearAll() {
    setCsv('');
    setFileName(null);
    setFormError(null);
    importer.reset();
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  const result = importer.data?.data;
  // Count / editor sizing use the same non-empty-line split as the server + preview,
  // so blank lines don't inflate the "data rows" badge.
  const nonEmptyLines = splitCsvLines(csv);
  const rowCount = Math.max(0, nonEmptyLines.length - (nonEmptyLines.length > 0 ? 1 : 0));
  const preview = buildCsvPreview(csv);
  const MAX_PREVIEW_GROUPS = 100;
  // Keep the editor compact for small imports, while allowing it to grow for
  // a typical pasted export before the textarea's own scrollbar takes over.
  const physicalLineCount = csv ? csv.split(/\r?\n/).length : 0;
  const editorRows = Math.min(14, Math.max(7, physicalLineCount + 1));

  if (!canCreate) {
    return (
      <>
        <div className="page-header">
          <h1>Import Claims</h1>
          <Link href="/claims" className="btn">
            Back to claims
          </Link>
        </div>
        <div className="callout">
          You need the <code className="inline">claims.create</code> permission to import claims.
          Switch to a user who can lodge claims (e.g. a supervisor).
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Import Claims</h1>
          <span className="meta muted">Bulk-load claims from a RoadCo LegacyPlant CSV export.</span>
        </div>
        <Link href="/claims" className="btn">
          Back to claims
        </Link>
      </div>

      <form onSubmit={onSubmit}>
        <div className="import-grid">
          {/* Left: cost code + CSV input */}
          <div className="card">
            <div className="card-section">
              <h3>1 · Cost code</h3>
              <div className="field" style={{ marginTop: 14 }}>
                <span className="field-label">Project</span>
                <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">Select a project…</option>
                  {(projects.data?.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code} — {p.name}
                    </option>
                  ))}
                </select>
                <span className="hint">
                  The export has no cost code, so this project applies to every imported claim.
                </span>
              </div>
            </div>

            <div className="card-section" style={{ borderTop: '1px solid var(--border)' }}>
              <h3>2 · CSV data</h3>

              <div className="csv-source" style={{ marginTop: 14 }}>
                <div>
                  <span className="field-label">Upload a CSV or paste it below</span>
                  <span className="hint">You can upload a file, then review or edit its rows before importing.</span>
                </div>
                <div className="csv-source-actions">
                  <input
                    ref={fileInputRef}
                    id="claims-csv-file"
                    className="visually-hidden"
                    type="file"
                    accept=".csv,text/csv,text/plain"
                    onChange={onFileChange}
                  />
                  <label className="btn" htmlFor="claims-csv-file">
                    Choose CSV file
                  </label>
                  <button type="button" onClick={loadSample}>
                    Load sample
                  </button>
                </div>
                {fileName && <span className="csv-file-name">Loaded: {fileName}</span>}
              </div>

              <div className="csv-editor-field" style={{ marginTop: 18 }}>
                <div className="csv-editor-header">
                  <label className="field-label" htmlFor="claims-csv-editor">
                    CSV editor
                  </label>
                  <span className="csv-row-count" aria-live="polite">
                    {rowCount > 0
                      ? `${rowCount} data row${rowCount === 1 ? '' : 's'}`
                      : 'No data rows yet'}
                  </span>
                </div>
                <p id="claims-csv-editor-help" className="hint">
                  First row must be the column headers. Keep each claim's rows under the same <code className="inline">group</code>.
                </p>
                <textarea
                  id="claims-csv-editor"
                  className="csv-editor"
                  rows={editorRows}
                  value={csv}
                  onChange={(e) => setCsv(e.target.value)}
                  placeholder={`Paste CSV here, starting with:\n${CSV_HEADER}`}
                  spellCheck={false}
                  aria-describedby="claims-csv-editor-help"
                />
              </div>

              {preview && !preview.headerOk && (
                <div className="csv-preview-warning">
                  The first row must be the column headers — missing:{' '}
                  {preview.missingColumns.map((c, i) => (
                    <span key={c}>
                      {i > 0 && ', '}
                      <code className="inline">{c}</code>
                    </span>
                  ))}
                  . Expected: <code className="inline">{CSV_HEADER}</code>
                </div>
              )}
            </div>
          </div>

          {/* Right: format guide (sticky so it stays in view while editing) */}
          <aside className="card card-section import-guide">
            <h3>CSV format</h3>
            <p className="hint" style={{ marginTop: 12 }}>Required columns, in this order:</p>
            <pre className="code-block">{CSV_HEADER}</pre>
            <p className="hint" style={{ marginTop: 14 }}>Example:</p>
            <pre className="code-block">{CSV_SAMPLE}</pre>
            <ul className="help-list" style={{ marginTop: 16 }}>
              <li>
                Rows sharing a <code className="inline">group</code> become <strong>one claim</strong>.
              </li>
              <li>Each imported claim is created as a <strong>DRAFT</strong> for you.</li>
              <li>
                Prices may be quoted with a comma, e.g. <code className="inline">&quot;1,299.50&quot;</code>.
              </li>
              <li>
                <code className="inline">is_fuel</code> accepts <code className="inline">true</code>/
                <code className="inline">false</code> (or 1/0).
              </li>
              <li>
                Import is <strong>best-effort</strong>: valid groups are created; any group with a bad
                or missing line is rejected whole and reported below.
              </li>
            </ul>
          </aside>
        </div>

        {/* Full-width parsed preview, grouped into the claims that will be created. */}
        {preview && preview.headerOk && preview.groups.length > 0 && (
          <div className="card" style={{ marginTop: 20 }}>
            <div className="card-section">
              <div className="csv-editor-header">
                <span className="field-label">Claims this will create</span>
                {preview.problemGroupCount > 0 ? (
                  <span className="csv-row-count csv-row-count-bad">
                    {preview.problemGroupCount} group
                    {preview.problemGroupCount === 1 ? '' : 's'} will be skipped
                  </span>
                ) : (
                  <span className="csv-row-count csv-row-count-ok">
                    {preview.validClaimCount} claim{preview.validClaimCount === 1 ? '' : 's'} ready
                  </span>
                )}
              </div>
              <p className="hint">
                Updates as you type. Rows sharing a <code className="inline">group</code> become one
                claim (even if they aren't next to each other). Row numbers match the import report;
                hover a highlighted cell for the reason. Final validation still happens on import.
              </p>

              <div className="csv-groups" style={{ marginTop: 14 }}>
                {preview.groups.slice(0, MAX_PREVIEW_GROUPS).map((grp, gi) => (
                  <div
                    key={`${grp.group}-${gi}`}
                    className={`csv-group ${grp.valid ? 'is-valid' : 'is-invalid'}`}
                  >
                    <div className="csv-group-head">
                      <span className="csv-group-name">
                        Group <code className="inline">{grp.group || '(empty)'}</code>
                      </span>
                      {grp.valid ? (
                        <span className="csv-row-count csv-row-count-ok">1 claim</span>
                      ) : (
                        <span className="csv-row-count csv-row-count-bad">
                          Skipped — {grp.reason}
                        </span>
                      )}
                    </div>
                    <div className="csv-preview-scroll">
                      <table className="csv-preview-table">
                        <thead>
                          <tr>
                            <th className="num">Row</th>
                            {CSV_FIELD_COLUMNS.map((c) => (
                              <th key={c}>{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {grp.rows.map((row) => (
                            <tr key={row.rowNumber}>
                              <td className="num muted">{row.rowNumber}</td>
                              {CSV_FIELD_COLUMNS.map((c) => {
                                const cell = row.cells[c];
                                return (
                                  <td
                                    key={c}
                                    className={cell.error ? 'csv-cell-bad' : undefined}
                                    title={cell.error}
                                  >
                                    {cell.value || (cell.error ? '(missing)' : '')}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>

              {preview.groups.length > MAX_PREVIEW_GROUPS && (
                <p className="hint" style={{ marginTop: 12 }}>
                  Showing the first {MAX_PREVIEW_GROUPS} of {preview.groups.length} groups.
                </p>
              )}
            </div>
          </div>
        )}

        {formError && <p style={{ color: 'var(--danger)', margin: '16px 0 0' }}>{formError}</p>}

        <div className="action-row" style={{ marginTop: 16 }}>
          <button className="primary" type="submit" disabled={importer.isPending}>
            {importer.isPending ? 'Importing…' : 'Import claims'}
          </button>
          <button
            type="button"
            onClick={clearAll}
            disabled={importer.isPending || (!csv && !result)}
          >
            Clear
          </button>
        </div>
      </form>

      {result && (
        <div className="stack" style={{ marginTop: 20 }}>
          <div className="card">
            <div className="card-section">
              <h3>
                Created — {result.created.length} claim{result.created.length === 1 ? '' : 's'}
              </h3>
            </div>
            {result.created.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Project</th>
                    <th className="num">Total (ex-GST)</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {result.created.map((c) => (
                    <tr key={c.id}>
                      <td>{c.reference}</td>
                      <td>{c.project?.code ?? '—'}</td>
                      <td className="num">${Number(c.total).toFixed(2)}</td>
                      <td>
                        <Link href={`/claims/${c.id}`}>View</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="card-section muted">No claims were created.</div>
            )}
          </div>

          <div className="card">
            <div className="card-section">
              <h3>
                Failed — {result.failed.length} group{result.failed.length === 1 ? '' : 's'}
              </h3>
            </div>
            {result.failed.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th>Group</th>
                    <th>Rows</th>
                    <th>Reasons</th>
                  </tr>
                </thead>
                <tbody>
                  {result.failed.map((f, i) => (
                    <tr key={`${f.group}-${i}`}>
                      <td>{f.group}</td>
                      <td>{f.rowNumbers.join(', ') || '—'}</td>
                      <td style={{ color: 'var(--danger)' }}>
                        {f.reasons.map((r, ri) => (
                          <div key={ri}>{r}</div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="card-section muted">No groups failed.</div>
            )}
          </div>

          {result.created.length > 0 && (
            <div>
              <Link href="/claims" className="btn primary">
                View claims list
              </Link>
            </div>
          )}
        </div>
      )}
    </>
  );
}
