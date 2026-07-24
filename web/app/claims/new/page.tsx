'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, apiGet, apiPost } from '../../../lib/api/client';
import { previewClaimTotals } from '../../../lib/claims/claim-totals';
import { queryKeys } from '../../../lib/query/keys';

const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;

const lineSchema = z.object({
  description: z.string().trim().min(1, 'Description is required').max(200),
  quantity: z
    .string()
    .regex(/^\d+$/, 'Quantity must be a whole number')
    .refine((v) => {
      const n = Number(v);
      return n >= 1 && n <= 1_000_000;
    }, 'Quantity must be between 1 and 1,000,000'),
  unitPrice: z
    .string()
    .regex(MONEY_RE, 'Unit price must be non-negative with at most 2 decimals'),
  isFuel: z.boolean(),
});

const claimSchema = z.object({
  projectId: z.string().min(1, 'Select a project'),
  expenseDate: z.string().min(1, 'Expense date is required'),
  lines: z.array(lineSchema).min(1, 'At least one line is required'),
});

type ClaimForm = z.infer<typeof claimSchema>;
type Project = { id: string; code: string; name: string };

export default function NewClaimPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const projects = useQuery({
    queryKey: queryKeys.projects.list(1, 'ACTIVE'),
    queryFn: () => apiGet<Project[]>('/projects?pageSize=100&status=ACTIVE'),
  });

  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
    setError,
  } = useForm<ClaimForm>({
    resolver: zodResolver(claimSchema),
    defaultValues: {
      projectId: '',
      expenseDate: '',
      lines: [{ description: '', quantity: '1', unitPrice: '', isFuel: false }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });

  // useWatch re-renders on every line/date change — watch()+useMemo missed in-place updates.
  const expenseDate = useWatch({ control, name: 'expenseDate' }) ?? '';
  const lines = useWatch({ control, name: 'lines' }) ?? [];

  // Rate comes from the API (same effective-dated lookup the create path uses) so
  // the preview can't drift from the server if a SurchargeRate row changes.
  const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(expenseDate);
  const rateQuery = useQuery({
    queryKey: queryKeys.claims.effectiveRate(expenseDate),
    queryFn: () =>
      apiGet<{ date: string; ratePercent: string | null; effectiveFrom: string | null }>(
        `/claims/effective-rate?date=${encodeURIComponent(expenseDate)}`,
      ),
    enabled: isValidDate,
  });
  const levyRate = isValidDate ? rateQuery.data?.data.ratePercent ?? null : null;

  const preview = (() => {
    if (!levyRate || lines.length === 0) return null;
    const parsed: { quantity: number; unitPrice: string; isFuel: boolean }[] = [];
    for (const l of lines) {
      const unitPrice = String(l?.unitPrice ?? '').trim();
      const quantityRaw = String(l?.quantity ?? '').trim();
      // Any incomplete/invalid line means the preview can't match the server → show "—".
      if (!unitPrice || !MONEY_RE.test(unitPrice) || !/^\d+$/.test(quantityRaw)) return null;
      const quantity = Number(quantityRaw);
      if (quantity < 1) return null;
      parsed.push({ quantity, unitPrice, isFuel: Boolean(l?.isFuel) });
    }
    return previewClaimTotals(parsed, levyRate);
  })();

  const create = useMutation({
    mutationFn: (values: ClaimForm) =>
      apiPost('/claims', {
        projectId: values.projectId,
        expenseDate: values.expenseDate,
        lines: values.lines.map((l) => ({
          description: l.description.trim(),
          quantity: parseInt(l.quantity, 10),
          unitPrice: l.unitPrice,
          isFuel: l.isFuel,
        })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.claims.all });
      router.push('/claims');
    },
    onError: (err) => {
      setError('root', {
        message: err instanceof ApiError ? err.message : 'Failed to create claim',
      });
    },
  });

  return (
    <>
      <div className="page-header">
        <h1>New Expense Claim</h1>
      </div>
      <div className="card" style={{ padding: 20 }}>
        <form className="form-grid" onSubmit={handleSubmit((v) => create.mutate(v))}>
          <label>
            Cost code (project){' '}
            <select {...register('projectId')}>
              <option value="">Select project…</option>
              {(projects.data?.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} — {p.name}
                </option>
              ))}
            </select>
            {errors.projectId && (
              <span style={{ color: 'var(--danger)' }}> {errors.projectId.message}</span>
            )}
          </label>

          <label>
            Expense date <input type="date" {...register('expenseDate')} />
            {errors.expenseDate && (
              <span style={{ color: 'var(--danger)' }}> {errors.expenseDate.message}</span>
            )}
            {isValidDate && rateQuery.isPending && (
              <span className="muted"> Checking levy rate…</span>
            )}
            {isValidDate && rateQuery.isError && (
              <span style={{ color: 'var(--danger)' }}> Could not load the levy rate for this date</span>
            )}
            {isValidDate && rateQuery.isSuccess && !levyRate && (
              <span style={{ color: 'var(--danger)' }}> No levy rate in force for this date</span>
            )}
            {levyRate && (
              <span className="muted"> Levy rate on this date: {levyRate}%</span>
            )}
          </label>

          <div>
            <strong>Line items</strong>
            {errors.lines?.root && (
              <span style={{ color: 'var(--danger)' }}> {errors.lines.root.message}</span>
            )}
          </div>

          {fields.map((field, i) => (
            <div className="line-row" key={field.id}>
              <input placeholder="Description" {...register(`lines.${i}.description`)} />
              <input placeholder="Qty" {...register(`lines.${i}.quantity`)} style={{ width: 90 }} />
              <input placeholder="Unit price" {...register(`lines.${i}.unitPrice`)} />
              <label>
                <input type="checkbox" {...register(`lines.${i}.isFuel`)} /> fuel
              </label>
              <button
                type="button"
                disabled={fields.length <= 1}
                onClick={() => remove(i)}
                aria-label="Remove line"
              >
                ×
              </button>
              {(errors.lines?.[i]?.description ||
                errors.lines?.[i]?.quantity ||
                errors.lines?.[i]?.unitPrice) && (
                <span style={{ color: 'var(--danger)', gridColumn: '1 / -1', fontSize: 13 }}>
                  {errors.lines?.[i]?.description?.message ??
                    errors.lines?.[i]?.quantity?.message ??
                    errors.lines?.[i]?.unitPrice?.message}
                </span>
              )}
            </div>
          ))}

          <div>
            <button
              type="button"
              onClick={() =>
                append({ description: '', quantity: '1', unitPrice: '', isFuel: false })
              }
            >
              + Add line
            </button>
          </div>

          <div className="total-preview">
            {preview ? (
              <>
                <div className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
                  Lines ${preview.linesSubtotal} · Fuel ${preview.fuelSubtotal} · Levy (${levyRate}%)
                  ${preview.levyAmount}
                </div>
                Total (ex-GST): ${preview.total}
              </>
            ) : (
              <>Total (ex-GST): —</>
            )}
          </div>

          {errors.root && <p style={{ color: 'var(--danger)' }}>{errors.root.message}</p>}

          <div>
            <button className="primary" type="submit" disabled={create.isPending || !levyRate}>
              {create.isPending ? 'Saving…' : 'Create draft'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
