'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use, useState } from 'react';
import { ApiError, apiGet, apiPost } from '../../../lib/api/client';
import { requiresTwoKeys } from '../../../lib/claims/claim-lifecycle';
import { queryKeys } from '../../../lib/query/keys';
import { useActingUser } from '../../../lib/use-acting-user';

type ClaimLine = {
  id: string;
  description: string;
  quantity: number;
  unitPrice: string | number;
  isFuel: boolean;
};

type AuditRow = {
  id: string;
  actorId: string;
  action: string;
  createdAt: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

type ClaimDetail = {
  id: string;
  reference: string;
  status: string;
  expenseDate: string;
  total: string | number;
  levyRatePercent: string | number;
  levyAmount: string | number;
  submitterId: string;
  firstApprovedById?: string | null;
  firstApprovedAt?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  rejectedById?: string | null;
  rejectedAt?: string | null;
  project?: { code: string; name: string };
  lines: ClaimLine[];
  history: AuditRow[];
};

function money(v: string | number): string {
  return Number(v).toFixed(2);
}

function lineTotal(line: ClaimLine): string {
  return money(Number(line.quantity) * Number(line.unitPrice));
}

function actionLabel(action: string): string {
  switch (action) {
    case 'claim.created':
      return 'Claim created';
    case 'claim.submitted':
      return 'Submitted for review';
    case 'claim.partially_approved':
      return 'First approval (key 1)';
    case 'claim.approved':
      return 'Final approval';
    case 'claim.rejected':
      return 'Rejected';
    default:
      return action;
  }
}

export default function ClaimDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const { user, users, can } = useActingUser();
  const [actionError, setActionError] = useState<string | null>(null);

  const claimQuery = useQuery({
    queryKey: queryKeys.claims.detail(id),
    queryFn: () => apiGet<ClaimDetail>(`/claims/${id}`),
  });

  const claim = claimQuery.data?.data;
  const nameOf = (userId: string | null | undefined) =>
    users.find((u) => u.id === userId)?.name ?? (userId ? `${userId.slice(0, 8)}…` : '—');

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.claims.all });
    queryClient.invalidateQueries({ queryKey: queryKeys.claims.detail(id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.reports.burn });
  };

  const submit = useMutation({
    mutationFn: () => apiPost(`/claims/${id}/submit`, {}),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) =>
      setActionError(err instanceof ApiError ? err.message : 'Submit failed'),
  });

  const approve = useMutation({
    mutationFn: () => apiPost(`/claims/${id}/approve`, {}),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) =>
      setActionError(err instanceof ApiError ? err.message : 'Approve failed'),
  });

  const reject = useMutation({
    mutationFn: () => apiPost(`/claims/${id}/reject`, {}),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) =>
      setActionError(err instanceof ApiError ? err.message : 'Reject failed'),
  });

  const busy = submit.isPending || approve.isPending || reject.isPending;

  const twoKey = claim ? requiresTwoKeys(claim.total) : false;
  const isSubmitter = user?.id === claim?.submitterId;
  const canSubmit =
    claim?.status === 'DRAFT' && isSubmitter && can('claims.create');
  const canDecide =
    claim &&
    (claim.status === 'SUBMITTED' || claim.status === 'PARTIALLY_APPROVED') &&
    can('claims.approve') &&
    !isSubmitter;
  const blockedSecondKey =
    claim?.status === 'PARTIALLY_APPROVED' && claim.firstApprovedById === user?.id;

  let fuelSubtotal = 0;
  let linesSubtotal = 0;
  if (claim) {
    for (const line of claim.lines) {
      const lt = Number(line.quantity) * Number(line.unitPrice);
      linesSubtotal += lt;
      if (line.isFuel) fuelSubtotal += lt;
    }
  }
  const exGst = claim ? Number(claim.total) : 0;
  const gstRef = exGst * 0.1;
  const incGstRef = exGst + gstRef;

  return (
    <>
      <p className="breadcrumb">
        <Link href="/claims">← Expense claims</Link>
      </p>

      {claimQuery.isPending && <p className="muted">Loading…</p>}
      {claimQuery.isError && (
        <p style={{ color: 'var(--danger)' }}>{(claimQuery.error as Error).message}</p>
      )}

      {claim && (
        <>
          <div className="page-header">
            <div>
              <h1>{claim.reference}</h1>
              <span className="meta muted">
                {claim.project?.code} — {claim.project?.name} · Expense {claim.expenseDate.slice(0, 10)}
              </span>
            </div>
            <span className={`badge ${claim.status}`}>{claim.status}</span>
          </div>

          {twoKey && claim.status !== 'APPROVED' && claim.status !== 'REJECTED' && (
            <div className="callout">
              {claim.status === 'PARTIALLY_APPROVED' ? (
                <>
                  <strong>Two-key rule:</strong> first key by{' '}
                  <strong>{nameOf(claim.firstApprovedById)}</strong> — second approval pending
                  (must be a different approver).
                </>
              ) : (
                <>
                  <strong>Two-key rule:</strong> total exceeds $1,000.00 ex-GST — needs two
                  different approvers.
                </>
              )}
            </div>
          )}

          <div className="detail-grid">
            <div className="stack">
              <div className="card">
                <div className="card-section">
                  <h3>Line items</h3>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Description</th>
                      <th className="num">Qty</th>
                      <th className="num">Unit price</th>
                      <th>Fuel</th>
                      <th className="num">Line total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {claim.lines.map((line) => (
                      <tr key={line.id}>
                        <td>{line.description}</td>
                        <td className="num">{line.quantity}</td>
                        <td className="num">${money(line.unitPrice)}</td>
                        <td>{line.isFuel ? 'Yes' : '—'}</td>
                        <td className="num">${lineTotal(line)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="card card-section">
                <h3>Totals</h3>
                <div className="totals-rows">
                  <div className="totals-row">
                    <span>Lines subtotal (ex-GST)</span>
                    <span>${money(linesSubtotal)}</span>
                  </div>
                  <div className="totals-row">
                    <span>Fuel subtotal</span>
                    <span>${money(fuelSubtotal)}</span>
                  </div>
                  <div className="totals-row">
                    <span>Site fuel levy ({money(claim.levyRatePercent)}% on fuel)</span>
                    <span>${money(claim.levyAmount)}</span>
                  </div>
                  <div className="totals-row divider emphasis">
                    <span>Total (ex-GST)</span>
                    <span>${money(claim.total)}</span>
                  </div>
                  <div className="totals-row reference">
                    <span className="muted">GST (10%) — reference only</span>
                    <span className="muted">${money(gstRef)}</span>
                  </div>
                  <div className="totals-row reference">
                    <span className="muted">Inc-GST — reference only</span>
                    <span className="muted">${money(incGstRef)}</span>
                  </div>
                </div>
                <div className="totals-meta">
                  Lodged by {nameOf(claim.submitterId)}
                  {claim.approvedBy && claim.status === 'APPROVED' && (
                    <> · Approved by {nameOf(claim.approvedBy)}</>
                  )}
                  {claim.rejectedById && claim.status === 'REJECTED' && (
                    <> · Rejected by {nameOf(claim.rejectedById)}</>
                  )}
                </div>
              </div>
            </div>

            <div className="stack">
              {(canSubmit || canDecide) && (
                <div className="card card-section actions-card">
                  <h3>Actions</h3>
                  {actionError && <p className="action-error">{actionError}</p>}
                  {canSubmit && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => submit.mutate()}
                    >
                      {submit.isPending ? 'Submitting…' : 'Submit for review'}
                    </button>
                  )}
                  {canDecide && (
                    <div className="action-row">
                      <button
                        className="primary"
                        disabled={busy || blockedSecondKey}
                        onClick={() => approve.mutate()}
                        title={
                          blockedSecondKey
                            ? 'Second key must be a different approver'
                            : undefined
                        }
                      >
                        {approve.isPending ? 'Approving…' : 'Approve'}
                      </button>
                      <button disabled={busy} onClick={() => reject.mutate()}>
                        {reject.isPending ? 'Rejecting…' : 'Reject'}
                      </button>
                    </div>
                  )}
                  {blockedSecondKey && (
                    <p className="action-hint">
                      You turned the first key — a different approver must finish this claim.
                    </p>
                  )}
                </div>
              )}

              <div className="card card-section">
                <h3>Decision history</h3>
                <ul className="timeline">
                  {claim.history.map((entry) => (
                    <li key={entry.id}>
                      <time>{new Date(entry.createdAt).toLocaleString()}</time>
                      <span className="event-title">{actionLabel(entry.action)}</span>
                      <span className="event-meta">
                        {nameOf(entry.actorId)}
                        {entry.after?.status != null && <> · → {String(entry.after.status)}</>}
                      </span>
                    </li>
                  ))}
                  {claim.history.length === 0 && (
                    <li className="muted">No audit entries yet</li>
                  )}
                </ul>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
