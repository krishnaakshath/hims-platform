// Wave I (P1-23): hospital reports on the SP1-SP5 tables. Every range is an
// inclusive pair of IST calendar dates; timestamps are stored as UTC wall-clock
// (`timestamp` without zone), so an instant's IST day is
// (col at time zone 'UTC' at time zone 'Asia/Kolkata')::date and an IST day d
// starts at UTC wall-clock d - 5:30. Patient fields are UHID and name only:
// never phone, address, Aadhaar or ABHA.
import { sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { paiseFromDb } from '@/lib/billing/amounts'
import type { HospitalReportKey } from '@/lib/reports/catalog'
import type { ReportRange } from '@/lib/reports/range'
import type { ReportCell, ReportResult } from '@/lib/reports/table'

/** Row cap for the register-style sections (discharges); a truncation note is added past it. */
export const REPORT_ROW_LIMIT = 5000

const istDate = (col: SQL) => sql`((${col}) at time zone 'UTC' at time zone 'Asia/Kolkata')::date`
const istText = (col: SQL) => sql`to_char((${col}) at time zone 'UTC' at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')`
/** UTC wall-clock instant at which IST day `d` (a date expression) starts. */
const istDayStart = (d: SQL) => sql`((${d})::timestamp - interval '5 hours 30 minutes')`
const between = (col: SQL, r: ReportRange) => sql`${col} between ${r.from}::date and ${r.to}::date`

async function rows<T extends Record<string, unknown>>(q: SQL): Promise<T[]> {
  return (await getDb().execute<T>(q)).rows as T[]
}

const n = (v: unknown): number => Number(v ?? 0)
const dec = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10)
const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null)
const sumCol = (rs: ReportCell[][], i: number) => rs.reduce((a, r) => a + n(r[i]), 0)

// ---------------------------------------------------------------- OPD

export async function opdStatistics(r: ReportRange): Promise<ReportResult> {
  const dept = sql`coalesce(d.name, '(No department)')`
  const live = sql`e.status <> 'cancelled'`
  const base = sql`from encounters e join providers p on p.id = e.provider_id left join departments d on d.id = coalesce(e.department_id, p.department_id)
    where e.encounter_type = 'opd' and ${between(sql`e.encounter_date`, r)}`
  const counts = sql`count(*) filter (where ${live})::int as visits,
    count(*) filter (where ${live} and e.visit_type = 'new')::int as new_visits,
    count(*) filter (where ${live} and e.visit_type in ('follow_up', 'review'))::int as follow_ups,
    count(*) filter (where ${live} and e.visit_type = 'emergency')::int as emergencies,
    count(*) filter (where e.status = 'completed')::int as completed,
    count(*) filter (where e.status = 'cancelled')::int as cancelled`
  type C = { visits: number; new_visits: number; follow_ups: number; emergencies: number; completed: number; cancelled: number }
  const [byDept, byDoctor, byDay] = await Promise.all([
    rows<C & { dept: string }>(sql`select ${dept} as dept, ${counts} ${base} group by 1 order by visits desc, dept`),
    rows<C & { doctor: string; dept: string }>(sql`select p.name as doctor, ${dept} as dept, ${counts} ${base} group by p.id, p.name, 2 order by visits desc, doctor`),
    rows<C & { day: string }>(sql`select e.encounter_date::text as day, ${counts} ${base} group by 1 order by 1`),
  ])
  const countCells = (x: C): ReportCell[] => [x.visits, x.new_visits, x.follow_ups, x.emergencies, x.completed, x.cancelled]
  const countCols = [
    { label: 'Visits', kind: 'int' as const }, { label: 'New', kind: 'int' as const }, { label: 'Follow-up / review', kind: 'int' as const },
    { label: 'Emergency', kind: 'int' as const }, { label: 'Completed', kind: 'int' as const }, { label: 'Cancelled', kind: 'int' as const },
  ]
  const deptRows = byDept.map((x) => [x.dept, ...countCells(x)])
  return {
    note: 'Visits exclude cancelled check-ins, which are counted separately.',
    sections: [
      { title: 'By department', columns: [{ label: 'Department', kind: 'text' }, ...countCols], rows: deptRows, totals: ['Total', ...countCols.map((_, i) => sumCol(deptRows, i + 1))], empty: 'No OPD visits in this period.' },
      { title: 'By doctor', columns: [{ label: 'Doctor', kind: 'text' }, { label: 'Department', kind: 'text' }, ...countCols], rows: byDoctor.map((x) => [x.doctor, x.dept, ...countCells(x)]), empty: 'No OPD visits in this period.' },
      { title: 'By day', columns: [{ label: 'Date', kind: 'date' }, ...countCols], rows: byDay.map((x) => [x.day, ...countCells(x)]), empty: 'No OPD visits in this period.' },
    ],
  }
}

// ---------------------------------------------------------------- IPD

export async function ipdStatistics(r: ReportRange): Promise<ReportResult> {
  const admittedOn = istDate(sql`a.admitted_at`)
  const dischargedOn = istDate(sql`a.discharged_at`)
  const losDays = sql`extract(epoch from (a.discharged_at - a.admitted_at)) / 86400.0`
  const [byDept, byType, census] = await Promise.all([
    rows<{ dept: string; admissions: number; discharges: number; alos: string | null; patient_days: string | null }>(sql`
      select coalesce(d.name, '(No department)') as dept,
        count(*) filter (where ${between(admittedOn, r)})::int as admissions,
        count(*) filter (where a.discharged_at is not null and ${between(dischargedOn, r)})::int as discharges,
        avg(${losDays}) filter (where a.discharged_at is not null and ${between(dischargedOn, r)})::text as alos,
        sum(${losDays}) filter (where a.discharged_at is not null and ${between(dischargedOn, r)})::text as patient_days
      from admissions a join providers p on p.id = a.attending_provider_id left join departments d on d.id = p.department_id
      where ${between(admittedOn, r)} or (a.discharged_at is not null and ${between(dischargedOn, r)})
      group by 1 order by admissions desc, dept`),
    rows<{ admission_type: string; admissions: number }>(sql`
      select a.admission_type::text as admission_type, count(*)::int as admissions from admissions a
      where ${between(admittedOn, r)} group by 1 order by 1`),
    rows<{ day: string; admitted: number; discharged: number; in_house: number }>(sql`
      select g.day::date::text as day,
        (select count(*) from admissions a where ${admittedOn} = g.day::date)::int as admitted,
        (select count(*) from admissions a where a.discharged_at is not null and ${dischargedOn} = g.day::date)::int as discharged,
        (select count(*) from admissions a where a.admitted_at < ${istDayStart(sql`g.day::date + 1`)}
           and (a.discharged_at is null or a.discharged_at >= ${istDayStart(sql`g.day::date + 1`)}))::int as in_house
      from generate_series(${r.from}::date, ${r.to}::date, interval '1 day') as g(day)
      order by 1`),
  ])
  const deptRows: ReportCell[][] = byDept.map((x) => [x.dept, x.admissions, x.discharges, dec(x.alos)])
  const totalDischarges = sumCol(deptRows, 2)
  const totalLos = byDept.reduce((a, x) => a + Number(x.patient_days ?? 0), 0)
  return {
    note: 'Department is the attending doctor\'s. Length of stay counts discharges in the period, from admission to discharge, in days.',
    sections: [
      {
        title: 'By department',
        columns: [{ label: 'Department', kind: 'text' }, { label: 'Admissions', kind: 'int' }, { label: 'Discharges', kind: 'int' }, { label: 'Average length of stay (days)', kind: 'decimal' }],
        rows: deptRows,
        totals: ['Total', sumCol(deptRows, 1), totalDischarges, totalDischarges > 0 ? dec(totalLos / totalDischarges) : null],
        empty: 'No admissions or discharges in this period.',
      },
      { title: 'Admissions by type', columns: [{ label: 'Admission type', kind: 'text' }, { label: 'Admissions', kind: 'int' }], rows: byType.map((x) => [x.admission_type.replace('_', ' '), x.admissions]), empty: 'No admissions in this period.' },
      { title: 'Daily census', columns: [{ label: 'Date', kind: 'date' }, { label: 'Admitted', kind: 'int' }, { label: 'Discharged', kind: 'int' }, { label: 'In-house at midnight', kind: 'int' }], rows: census.map((x) => [x.day, x.admitted, x.discharged, x.in_house]), empty: 'No days in this period.' },
    ],
  }
}

// ---------------------------------------------------------------- Bed occupancy

export async function bedOccupancy(r: ReportRange): Promise<ReportResult> {
  const rangeStart = istDayStart(sql`${r.from}::date`)
  const rangeEnd = istDayStart(sql`${r.to}::date + 1`)
  const [wards, [stay]] = await Promise.all([
    rows<{ ward: string; beds: number; occupied: number; available: number; dirty: number; blocked: number }>(sql`
      select ward, count(*)::int as beds, count(*) filter (where status = 'occupied')::int as occupied,
        count(*) filter (where status = 'available')::int as available, count(*) filter (where status = 'dirty')::int as dirty,
        count(*) filter (where status = 'blocked')::int as blocked
      from rooms group by ward order by ward`),
    // Inpatient days inside the range: each admission's overlap with [range start, range end), capped at now.
    rows<{ patient_days: string | null; days: number }>(sql`
      select sum(extract(epoch from (least(coalesce(a.discharged_at, now() at time zone 'UTC'), ${rangeEnd}) - greatest(a.admitted_at, ${rangeStart}))) / 86400.0)
          filter (where a.admitted_at < ${rangeEnd} and coalesce(a.discharged_at, now() at time zone 'UTC') > ${rangeStart})::text as patient_days,
        (${r.to}::date - ${r.from}::date + 1)::int as days
      from admissions a`),
  ])
  const wardRows: ReportCell[][] = wards.map((w) => [w.ward, w.beds, w.occupied, w.available, w.dirty, w.blocked, pct(w.occupied, w.beds - w.blocked)])
  const beds = sumCol(wardRows, 1)
  const inService = beds - sumCol(wardRows, 5)
  const patientDays = Math.max(0, Number(stay?.patient_days ?? 0))
  const days = n(stay?.days)
  const bedDays = inService * days
  return {
    note: 'Ward beds are as they stand now; the period figures measure inpatient days against today\'s beds in service (not blocked).',
    sections: [
      {
        title: 'Beds by ward (now)',
        columns: [{ label: 'Ward', kind: 'text' }, { label: 'Beds', kind: 'int' }, { label: 'Occupied', kind: 'int' }, { label: 'Available', kind: 'int' }, { label: 'Awaiting cleaning', kind: 'int' }, { label: 'Blocked', kind: 'int' }, { label: 'Occupancy', kind: 'percent' }],
        rows: wardRows,
        totals: ['Total', beds, sumCol(wardRows, 2), sumCol(wardRows, 3), sumCol(wardRows, 4), sumCol(wardRows, 5), pct(sumCol(wardRows, 2), inService)],
        empty: 'No beds are set up.',
      },
      {
        title: 'Occupancy over the period',
        columns: [{ label: 'Days', kind: 'int' }, { label: 'Beds in service', kind: 'int' }, { label: 'Available bed-days', kind: 'int' }, { label: 'Inpatient days', kind: 'decimal' }, { label: 'Average daily census', kind: 'decimal' }, { label: 'Average occupancy', kind: 'percent' }],
        rows: [[days, inService, bedDays, dec(patientDays), days > 0 ? dec(patientDays / days) : null, pct(patientDays, bedDays)]],
        empty: 'No days in this period.',
      },
    ],
  }
}

// ---------------------------------------------------------------- Discharge register

export async function dischargeRegister(r: ReportRange): Promise<ReportResult> {
  const list = await rows<{
    discharged: string; uhid: string | null; name: string; gender: string | null; admitted: string; los: string; admission_type: string
    doctor: string; dept: string | null; bed: string | null
  }>(sql`
    select ${istText(sql`a.discharged_at`)} as discharged, pt.uhid, pt.name, pt.gender::text as gender, ${istText(sql`a.admitted_at`)} as admitted,
      (extract(epoch from (a.discharged_at - a.admitted_at)) / 86400.0)::text as los, a.admission_type::text as admission_type,
      p.name as doctor, d.name as dept,
      (select rm.ward || ' / ' || rm.room_number || '-' || rm.bed_number from rooms rm
        where rm.id = coalesce(a.current_room_id, (select t.to_room_id from admission_transfers t where t.admission_id = a.id order by t.transferred_at desc, t.id desc limit 1))) as bed
    from admissions a join patients pt on pt.id = a.patient_id join providers p on p.id = a.attending_provider_id
    left join departments d on d.id = p.department_id
    where a.discharged_at is not null and ${between(istDate(sql`a.discharged_at`), r)}
    order by a.discharged_at, a.id
    limit ${REPORT_ROW_LIMIT + 1}`)
  const truncated = list.length > REPORT_ROW_LIMIT
  const shown = list.slice(0, REPORT_ROW_LIMIT)
  return {
    sections: [{
      title: 'Discharges',
      columns: [
        { label: 'Discharged', kind: 'datetime' }, { label: 'UHID', kind: 'text' }, { label: 'Patient', kind: 'text' }, { label: 'Gender', kind: 'text' },
        { label: 'Admitted', kind: 'datetime' }, { label: 'Length of stay (days)', kind: 'decimal' }, { label: 'Admission type', kind: 'text' },
        { label: 'Doctor', kind: 'text' }, { label: 'Department', kind: 'text' }, { label: 'Last bed', kind: 'text' },
      ],
      rows: shown.map((x) => [x.discharged, x.uhid, x.name, x.gender, x.admitted, dec(x.los), x.admission_type.replace('_', ' '), x.doctor, x.dept, x.bed]),
      note: truncated ? `Showing the first ${REPORT_ROW_LIMIT} discharges; narrow the dates to see the rest.` : undefined,
      empty: 'No discharges in this period.',
    }],
  }
}

// ---------------------------------------------------------------- Department revenue

export async function departmentRevenue(r: ReportRange): Promise<ReportResult> {
  const base = sql`from invoice_lines il join invoices i on i.id = il.invoice_id join charge_lines cl on cl.id = il.charge_line_id
    left join departments d on d.id = cl.department_id
    where i.status = 'finalised' and ${between(sql`i.invoice_date`, r)}`
  const money = sql`count(*)::int as lines, sum(il.taxable_paise)::text as taxable, sum(il.cgst_paise + il.sgst_paise + il.igst_paise)::text as gst,
    sum(il.total_paise)::text as total, coalesce(sum(il.total_paise) filter (where i.payer_id is null), 0)::text as self_pay,
    coalesce(sum(il.total_paise) filter (where i.payer_id is not null), 0)::text as payer`
  type M = { lines: number; taxable: string; gst: string; total: string; self_pay: string; payer: string }
  const [byDept, byCategory, [inv]] = await Promise.all([
    rows<M & { dept: string }>(sql`select coalesce(d.name, case when cl.source = 'pharmacy' then 'Pharmacy' else '(No department)' end) as dept, ${money} ${base} group by 1 order by sum(il.total_paise) desc, 1`),
    rows<M & { category: string }>(sql`select coalesce(cl.service_category::text, 'pharmacy') as category, ${money} ${base} group by 1 order by sum(il.total_paise) desc, 1`),
    rows<{ invoices: number }>(sql`select count(*)::int as invoices from invoices i where i.status = 'finalised' and ${between(sql`i.invoice_date`, r)}`),
  ])
  const cells = (x: M): ReportCell[] => [x.lines, paiseFromDb(x.taxable), paiseFromDb(x.gst), paiseFromDb(x.total), paiseFromDb(x.self_pay), paiseFromDb(x.payer)]
  const cols = [
    { label: 'Lines', kind: 'int' as const }, { label: 'Taxable', kind: 'paise' as const }, { label: 'GST', kind: 'paise' as const },
    { label: 'Total', kind: 'paise' as const }, { label: 'Self-pay', kind: 'paise' as const }, { label: 'Insurer / corporate', kind: 'paise' as const },
  ]
  const deptRows = byDept.map((x) => [x.dept, ...cells(x)])
  const catRows = byCategory.map((x) => [x.category.replace(/_/g, ' '), ...cells(x)])
  const totals = (rs: ReportCell[][]): ReportCell[] => ['Total', ...cols.map((_, i) => sumCol(rs, i + 1))]
  return {
    note: `Finalised GST invoices dated in the period (${inv?.invoices ?? 0}); cancelled invoices and unbilled charges are excluded. Department is the charge line's.`,
    sections: [
      { title: 'By department', columns: [{ label: 'Department', kind: 'text' }, ...cols], rows: deptRows, totals: totals(deptRows), empty: 'No finalised invoices in this period.' },
      { title: 'By service category', columns: [{ label: 'Category', kind: 'text' }, ...cols], rows: catRows, totals: totals(catRows), empty: 'No finalised invoices in this period.' },
    ],
  }
}

// ---------------------------------------------------------------- Collections

export const PAYMENT_MODE_LABEL: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', neft: 'NEFT / RTGS', other: 'Other' }

export async function collectionsByMode(r: ReportRange): Promise<ReportResult> {
  const [payments, refunds, byDay, byCashier] = await Promise.all([
    rows<{ mode: string; count: number; advances: string; receipts: string }>(sql`
      select mode::text as mode, count(*)::int as count,
        coalesce(sum(amount_paise) filter (where kind = 'advance'), 0)::text as advances,
        coalesce(sum(amount_paise) filter (where kind = 'receipt'), 0)::text as receipts
      from patient_payments where ${between(sql`receipt_date`, r)} group by 1`),
    rows<{ mode: string; count: number; amount: string }>(sql`
      select mode::text as mode, count(*)::int as count, sum(amount_paise)::text as amount
      from refunds where ${between(sql`refund_date`, r)} group by 1`),
    rows<{ day: string; collected: string; refunded: string }>(sql`
      select day::text as day, sum(collected)::text as collected, sum(refunded)::text as refunded from (
        select receipt_date as day, amount_paise as collected, 0 as refunded from patient_payments where ${between(sql`receipt_date`, r)}
        union all
        select refund_date, 0, amount_paise from refunds where ${between(sql`refund_date`, r)}
      ) x group by 1 order by 1`),
    rows<{ cashier: string; mode: string; count: number; amount: string }>(sql`
      select received_by_name as cashier, mode::text as mode, count(*)::int as count, sum(amount_paise)::text as amount
      from patient_payments where ${between(sql`receipt_date`, r)} group by 1, 2 order by 1, 2`),
  ])
  const modes = Object.keys(PAYMENT_MODE_LABEL).filter((m) => payments.some((p) => p.mode === m) || refunds.some((x) => x.mode === m))
  const modeRows: ReportCell[][] = modes.map((m) => {
    const p = payments.find((x) => x.mode === m)
    const f = refunds.find((x) => x.mode === m)
    const adv = paiseFromDb(p?.advances ?? 0)
    const rec = paiseFromDb(p?.receipts ?? 0)
    const ref = paiseFromDb(f?.amount ?? 0)
    return [PAYMENT_MODE_LABEL[m], p?.count ?? 0, adv, rec, adv + rec, f?.count ?? 0, ref, adv + rec - ref]
  })
  const dayRows: ReportCell[][] = byDay.map((x) => { const c = paiseFromDb(x.collected); const f = paiseFromDb(x.refunded); return [x.day, c, f, c - f] })
  return {
    note: 'Advances and receipts by receipt date; refunds by refund date. Payment references are not shown.',
    sections: [
      {
        title: 'By payment mode',
        columns: [
          { label: 'Mode', kind: 'text' }, { label: 'Payments', kind: 'int' }, { label: 'Advances', kind: 'paise' }, { label: 'Receipts', kind: 'paise' },
          { label: 'Collected', kind: 'paise' }, { label: 'Refunds', kind: 'int' }, { label: 'Refunded', kind: 'paise' }, { label: 'Net', kind: 'paise' },
        ],
        rows: modeRows,
        totals: ['Total', ...[1, 2, 3, 4, 5, 6, 7].map((i) => sumCol(modeRows, i))],
        empty: 'No payments or refunds in this period.',
      },
      { title: 'By day', columns: [{ label: 'Date', kind: 'date' }, { label: 'Collected', kind: 'paise' }, { label: 'Refunded', kind: 'paise' }, { label: 'Net', kind: 'paise' }], rows: dayRows, totals: ['Total', sumCol(dayRows, 1), sumCol(dayRows, 2), sumCol(dayRows, 3)], empty: 'No payments or refunds in this period.' },
      { title: 'By cashier', columns: [{ label: 'Received by', kind: 'text' }, { label: 'Mode', kind: 'text' }, { label: 'Payments', kind: 'int' }, { label: 'Amount', kind: 'paise' }], rows: byCashier.map((x) => [x.cashier, PAYMENT_MODE_LABEL[x.mode] ?? x.mode, x.count, paiseFromDb(x.amount)]), empty: 'No payments in this period.' },
    ],
  }
}

// ---------------------------------------------------------------- Tariff price list

const SCOPE_LABEL: Record<string, string> = { base: 'Base', department: 'Department', payer: 'Payer' }

/** Every active service with each rate in force on `r.to` (a service with none shows one 'No rate' row). */
export async function tariffPriceList(r: ReportRange): Promise<ReportResult> {
  const on = r.to
  const list = await rows<{
    code: string; name: string; dept: string; category: string; hsn_sac: string; gst_rate_bp: number; scope: string | null
    applies_to: string | null; room_category: string | null; ward: string | null; amount_paise: number | null
  }>(sql`
    select s.code, s.name, d.name as dept, s.category::text as category, s.hsn_sac, s.gst_rate_bp,
      t.scope, coalesce(td.name, py.name) as applies_to, rc.name as room_category, t.ward, t.amount_paise
    from service_catalog s join departments d on d.id = s.department_id
    left join tariff_rates t on t.service_id = s.id and t.deactivated_at is null
      and t.valid_from <= ${on}::date and (t.valid_to is null or t.valid_to >= ${on}::date)
    left join departments td on td.id = t.department_id
    left join payers py on py.id = t.payer_id
    left join room_categories rc on rc.id = t.room_category_id
    where s.is_active
    order by d.name, s.name, s.id, case t.scope when 'base' then 0 when 'department' then 1 else 2 end, applies_to nulls first, rc.name nulls first, t.ward nulls first`)
  return {
    note: `Rates in force on the chosen date. Amounts are before GST.`,
    sections: [{
      title: 'Price list',
      columns: [
        { label: 'Code', kind: 'text' }, { label: 'Service', kind: 'text' }, { label: 'Department', kind: 'text' }, { label: 'Category', kind: 'text' },
        { label: 'HSN/SAC', kind: 'text' }, { label: 'GST %', kind: 'percent' }, { label: 'Scope', kind: 'text' }, { label: 'Applies to', kind: 'text' },
        { label: 'Room category', kind: 'text' }, { label: 'Ward', kind: 'text' }, { label: 'Rate', kind: 'paise' },
      ],
      rows: list.map((x) => [
        x.code, x.name, x.dept, x.category.replace(/_/g, ' '), x.hsn_sac, x.gst_rate_bp / 100,
        x.scope === null ? 'No rate' : SCOPE_LABEL[x.scope] ?? x.scope, x.applies_to, x.room_category, x.ward, x.amount_paise,
      ]),
      empty: 'No active services.',
    }],
  }
}

// ---------------------------------------------------------------- Lab TAT

export async function labTurnaround(r: ReportRange): Promise<ReportResult> {
  const hours = (a: string, b: string) => sql.raw(`extract(epoch from (o.${b} - o.${a})) / 3600.0`)
  const done = sql.raw(`coalesce(o.reported_at, o.verified_at)`)
  const toReport = sql`extract(epoch from (${done} - o.ordered_at)) / 3600.0`
  const stats = sql`count(*)::int as orders,
    count(*) filter (where ${done} is not null)::int as reported,
    count(*) filter (where ${done} is null)::int as pending,
    (percentile_cont(0.5) within group (order by ${hours('ordered_at', 'collected_at')}))::text as collect_median,
    (percentile_cont(0.5) within group (order by ${hours('received_at', 'verified_at')}))::text as verify_median,
    (percentile_cont(0.5) within group (order by ${toReport}))::text as report_median,
    avg(${toReport})::text as report_avg,
    (percentile_cont(0.9) within group (order by ${toReport}))::text as report_p90`
  const base = sql`from lab_orders o join lab_tests lt on lt.id = o.lab_test_id
    where o.status <> 'cancelled' and ${between(istDate(sql`o.ordered_at`), r)}`
  type S = { orders: number; reported: number; pending: number; collect_median: string | null; verify_median: string | null; report_median: string | null; report_avg: string | null; report_p90: string | null }
  const [byTest, [all]] = await Promise.all([
    rows<S & { test: string; category: string }>(sql`select lt.name as test, lt.category::text as category, ${stats} ${base} group by lt.id, lt.name, lt.category order by orders desc, test`),
    rows<S>(sql`select ${stats} ${base}`),
  ])
  const cells = (x: S): ReportCell[] => [x.orders, x.reported, x.pending, dec(x.collect_median), dec(x.verify_median), dec(x.report_median), dec(x.report_avg), dec(x.report_p90)]
  return {
    note: 'Orders placed in the period (cancelled excluded). Times are hours; "report" is release of the report, or verification when no report has been released.',
    sections: [{
      title: 'By test',
      columns: [
        { label: 'Test', kind: 'text' }, { label: 'Kind', kind: 'text' }, { label: 'Orders', kind: 'int' }, { label: 'Reported', kind: 'int' }, { label: 'Pending', kind: 'int' },
        { label: 'Median order to collection (h)', kind: 'decimal' }, { label: 'Median receipt to verification (h)', kind: 'decimal' },
        { label: 'Median order to report (h)', kind: 'decimal' }, { label: 'Average order to report (h)', kind: 'decimal' }, { label: '90th percentile order to report (h)', kind: 'decimal' },
      ],
      rows: byTest.map((x) => [x.test, x.category, ...cells(x)]),
      totals: all && all.orders > 0 ? ['All tests', null, ...cells(all)] : undefined,
      empty: 'No lab orders in this period.',
    }],
  }
}

// ---------------------------------------------------------------- Pharmacy

export async function pharmacyStockAndDispensing(r: ReportRange): Promise<ReportResult> {
  const inRange = between(istDate(sql`md.dispensed_at`), r)
  const [stock, byMed, byDay] = await Promise.all([
    rows<{ name: string; generic: string | null; form: string; on_hand: number; unit: string; reorder: number; dispensed: number }>(sql`
      select m.name, m.generic_name as generic, m.form::text as form, inv.quantity_on_hand as on_hand, inv.unit, inv.reorder_threshold as reorder,
        coalesce((select sum(md.quantity) from medication_dispenses md where md.medication_id = m.id and ${inRange}), 0)::int as dispensed
      from medications m join medication_inventory inv on inv.medication_id = m.id
      order by (inv.quantity_on_hand <= inv.reorder_threshold) desc, m.name`),
    rows<{ name: string; dispenses: number; quantity: number; patients: number; billed: number }>(sql`
      select m.name, count(*)::int as dispenses, sum(md.quantity)::int as quantity, count(distinct md.patient_id)::int as patients,
        count(*) filter (where md.charge_id is not null or exists (select 1 from charge_lines cl where cl.medication_dispense_id = md.id and cl.status <> 'void'))::int as billed
      from medication_dispenses md join medications m on m.id = md.medication_id
      where ${inRange} group by m.id, m.name order by quantity desc, m.name`),
    rows<{ day: string; dispenses: number; quantity: number }>(sql`
      select ${istDate(sql`md.dispensed_at`)}::text as day, count(*)::int as dispenses, sum(md.quantity)::int as quantity
      from medication_dispenses md where ${inRange} group by 1 order by 1`),
  ])
  const medRows: ReportCell[][] = byMed.map((x) => [x.name, x.dispenses, x.quantity, x.patients, x.billed])
  const dayRows: ReportCell[][] = byDay.map((x) => [x.day, x.dispenses, x.quantity])
  return {
    note: 'Stock is as it stands now; dispensing is for the period.',
    sections: [
      {
        title: 'Stock',
        columns: [
          { label: 'Medication', kind: 'text' }, { label: 'Generic', kind: 'text' }, { label: 'Form', kind: 'text' }, { label: 'On hand', kind: 'int' },
          { label: 'Unit', kind: 'text' }, { label: 'Reorder at', kind: 'int' }, { label: 'Status', kind: 'text' }, { label: 'Dispensed in period', kind: 'int' },
        ],
        rows: stock.map((x) => [x.name, x.generic, x.form, x.on_hand, x.unit, x.reorder, x.on_hand <= x.reorder ? 'Reorder' : 'OK', x.dispensed]),
        empty: 'No medications are stocked.',
      },
      { title: 'Dispensing by medication', columns: [{ label: 'Medication', kind: 'text' }, { label: 'Dispenses', kind: 'int' }, { label: 'Quantity', kind: 'int' }, { label: 'Patients', kind: 'int' }, { label: 'Billed dispenses', kind: 'int' }], rows: medRows, totals: ['Total', sumCol(medRows, 1), sumCol(medRows, 2), null, sumCol(medRows, 4)], empty: 'Nothing dispensed in this period.' },
      { title: 'Dispensing by day', columns: [{ label: 'Date', kind: 'date' }, { label: 'Dispenses', kind: 'int' }, { label: 'Quantity', kind: 'int' }], rows: dayRows, empty: 'Nothing dispensed in this period.' },
    ],
  }
}

export const HOSPITAL_REPORT_QUERIES: Record<HospitalReportKey, (r: ReportRange) => Promise<ReportResult>> = {
  opd: opdStatistics,
  ipd: ipdStatistics,
  'bed-occupancy': bedOccupancy,
  discharges: dischargeRegister,
  'department-revenue': departmentRevenue,
  collections: collectionsByMode,
  tariff: tariffPriceList,
  'lab-tat': labTurnaround,
  pharmacy: pharmacyStockAndDispensing,
}

