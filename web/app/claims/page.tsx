'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { apiGet } from '../../lib/api/client';
import { queryKeys } from '../../lib/query/keys';

type Claim = {
  id: string;
  reference: string;
  status: string;
  expenseDate: string;
  total: number | string;
  project?: { code: string; name: string };
};

type Meta = { total: number; page: number; pageSize: number; pageCount: number };

function claimsListUrl(page: number, status: string, fy: string) {
  const params = new URLSearchParams({ page: String(page), pageSize: '10' });
  if (status) params.set('status', status);
  if (fy) params.set('fy', fy);
  return `/claims?${params}`;
}

/** Two-digit AU FY codes for the filter: current FY (from today) and the 3 before it. */
function fyOptions(): string[] {
  const now = new Date();
  const endYear = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
  return [0, 1, 2, 3].map((back) => String((endYear - back) % 100).padStart(2, '0'));
}

export default function ClaimsPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [fy, setFy] = useState('');

  const filters = useMemo(
    () => ({ status: status || undefined, fy: fy || undefined }),
    [status, fy],
  );

  const { data, isPending, isError, error } = useQuery({
    queryKey: queryKeys.claims.list(page, filters),
    queryFn: () => apiGet<Claim[]>(claimsListUrl(page, status, fy)),
    placeholderData: keepPreviousData,
  });

  const claims = data?.data ?? [];
  const meta = data?.meta as Meta | undefined;

  return (
    <>
      <div className="page-header">
        <h1>Expense Claims</h1>
        <div className="action-row">
          <Link href="/claims/import" className="btn">
            Import CSV
          </Link>
          <Link href="/claims/new" className="btn primary">
            New claim
          </Link>
        </div>
      </div>
      <div className="toolbar">
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="SUBMITTED">Submitted</option>
          <option value="PARTIALLY_APPROVED">Partially approved</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
        </select>
        <select
          value={fy}
          onChange={(e) => {
            setFy(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All FY</option>
          {fyOptions().map((code) => (
            <option key={code} value={code}>
              FY{code}
            </option>
          ))}
        </select>
      </div>
      <div className="card">
        {isPending && <p className="pager">Loading…</p>}
        {isError && (
          <p className="pager" style={{ color: 'var(--danger)' }}>
            {(error as Error).message}
          </p>
        )}
        {!isPending && !isError && (
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Project</th>
                <th>Date</th>
                <th>Status</th>
                <th className="num">Total (ex-GST)</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/claims/${c.id}`}>{c.reference}</Link>
                  </td>
                  <td>{c.project?.code ?? '—'}</td>
                  <td>{c.expenseDate.slice(0, 10)}</td>
                  <td>
                    <span className={`badge ${c.status}`}>{c.status}</span>
                  </td>
                  <td className="num">${Number(c.total).toFixed(2)}</td>
                </tr>
              ))}
              {claims.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No claims match these filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {meta && (
          <div className="pager">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Prev
            </button>
            <span>
              Page {meta.page} of {Math.max(meta.pageCount, 1)} · {meta.total} total
            </span>
            <button disabled={page >= meta.pageCount} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        )}
      </div>
    </>
  );
}
