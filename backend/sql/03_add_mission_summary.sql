-- Mission summary is a reporting cache. It never writes to the canonical
-- event, match, or exception tables.
create table if not exists finance.mission_summaries (
  mission_id uuid primary key references finance.finance_missions(id) on delete cascade,
  generated_at timestamptz not null default now(),
  aggregate_json jsonb not null,
  narrative_json jsonb not null,
  model text not null,
  prompt_version text not null
);

create index if not exists normalized_events_mission_date_idx
  on finance.normalized_events(mission_id, event_date);

create or replace function finance.build_mission_aggregate(p_mission_id uuid)
returns jsonb
language sql
stable
as $$
with mission as (
  select id, period_start, period_end
  from finance.finance_missions
  where id = p_mission_id
), event_base as (
  select
    e.*,
    coalesce(nullif(e.metadata->>'canonical_event_type', ''), e.event_type::text) as canonical_type,
    coalesce(nullif(e.metadata->>'canonical_source_system', ''), e.source_system::text) as canonical_source,
    lower(coalesce(e.metadata->>'deduction_category', e.metadata->>'deduction_type', e.deduction_type, 'unrecognized_deduction')) as category
  from finance.normalized_events e
  where e.mission_id = p_mission_id
), match_events as (
  select distinct m.id as match_id, e.id as event_id, e.canonical_type, e.canonical_source, e.event_date, e.amount
  from finance.matches m
  cross join lateral unnest(m.event_ids) as ids(event_id)
  join event_base e on e.id = ids.event_id
), complete_matches as (
  select match_id
  from match_events
  group by match_id
  having bool_or(canonical_type = 'SALE')
     and bool_or(canonical_type in ('BANK_CREDIT', 'BANK_TRANSACTION'))
), matched_sales as (
  select distinct me.event_id
  from match_events me
  join complete_matches cm on cm.match_id = me.match_id
  where me.canonical_type = 'SALE'
), sales as (
  select
    e.*,
    case when e.canonical_source in ('courier', 'cod') then 'cod' else e.canonical_source end as report_source,
    (e.id in (select event_id from matched_sales)) as is_matched
  from event_base e
  where e.canonical_type = 'SALE'
), source_rollup as (
  select source_key,
    coalesce(sum(s.sale_count), 0) as order_count,
    coalesce(sum(s.gross_sales), 0) as gross_sales,
    coalesce(sum(s.matched_count), 0) as matched_count,
    coalesce(sum(s.unmatched_value), 0) as unmatched_value
  from (values ('shopify'::text), ('cod'::text), ('amazon'::text)) keys(source_key)
  left join (
    select report_source,
      count(*) as sale_count,
      sum(greatest(amount, 0)) as gross_sales,
      count(*) filter (where is_matched) as matched_count,
      sum(greatest(amount, 0)) filter (where not is_matched) as unmatched_value
    from sales
    group by report_source
  ) s on s.report_source = keys.source_key
  group by source_key
), deductions as (
  select
    e.category,
    abs(e.amount) as value,
    e.id,
    (e.metadata->>'is_statutory_withholding')::boolean as is_withholding,
    e.canonical_type,
    coalesce((e.metadata->>'is_return_clawback')::boolean, false) as is_return_clawback
  from event_base e
  where (coalesce((e.metadata->>'is_deduction')::boolean, false)
      or e.canonical_type in ('FEE', 'COD_DEDUCTION')
      or e.canonical_type in ('REFUND', 'CHARGEBACK'))
), deduction_rollup as (
  select category, sum(value) as value, count(*) as count
  from deductions
  group by category
  order by value desc
), matched_bank as (
  select distinct me.event_id
  from match_events me
  join complete_matches cm on cm.match_id = me.match_id
  where me.canonical_type in ('BANK_CREDIT', 'BANK_TRANSACTION')
), complete_cod_lag as (
  select (max(me.event_date) filter (where me.canonical_type in ('BANK_CREDIT', 'BANK_TRANSACTION'))
        - min(me.event_date) filter (where me.canonical_type = 'COD_REMITTANCE'))::numeric as lag_days
  from match_events me
  join complete_matches cm on cm.match_id = me.match_id
  where me.canonical_source in ('courier', 'cod')
  group by me.match_id
  having bool_or(me.canonical_type = 'COD_REMITTANCE')
     and bool_or(me.canonical_type in ('BANK_CREDIT', 'BANK_TRANSACTION'))
), exception_type_rollup as (
  select exception_type::text as type, count(*) as count
  from finance.exceptions
  where mission_id = p_mission_id
  group by exception_type
), exception_status_rollup as (
  select
    count(*) filter (where status in ('open', 'investigating')) as open_count,
    count(*) filter (where status in ('resolved', 'explained')) as resolved_count,
    count(*) filter (where status = 'requires_human_review') as human_count
  from finance.exceptions
  where mission_id = p_mission_id
), top_open as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'type', exception_type::text,
    'amount', abs(coalesce(difference, expected_amount, actual_amount, 0)),
    'ageDays', greatest(0, floor(extract(epoch from (now() - created_at)) / 86400))::int
  ) order by abs(coalesce(difference, expected_amount, actual_amount, 0)) desc), '[]'::jsonb) as rows
  from finance.exceptions
  where mission_id = p_mission_id and status in ('open', 'investigating', 'requires_human_review')
), weekly as (
  select date_trunc('week', event_date)::date as bucket,
    sum(greatest(amount, 0)) filter (where is_matched) as matched_value,
    sum(greatest(amount, 0)) filter (where not is_matched) as unmatched_value
  from sales
  group by date_trunc('week', event_date)::date
  order by bucket
), totals as (
  select
    coalesce((select sum(greatest(amount, 0)) from event_base where canonical_type = 'SALE'), 0) as gross_sales,
    coalesce((select sum(value) from deductions where coalesce(is_withholding, false) = false and canonical_type not in ('REFUND', 'CHARGEBACK') and not is_return_clawback), 0) as total_fees,
    coalesce((select sum(value) from deductions where canonical_type in ('REFUND', 'CHARGEBACK') or is_return_clawback), 0) as total_refunds,
    coalesce((select sum(value) from deductions where is_withholding), 0) as statutory_withholding,
    coalesce((select sum(amount) from event_base where id in (select event_id from matched_bank) and amount > 0), 0) as net_received
)
select jsonb_build_object(
  'missionId', p_mission_id,
  'dateRange', jsonb_build_object(
    'from', coalesce((select min(event_date)::text from event_base), (select period_start::text from mission)),
    'to', coalesce((select max(event_date)::text from event_base), (select period_end::text from mission))
  ),
  'totals', jsonb_build_object(
    'grossSales', totals.gross_sales,
    'totalFees', totals.total_fees,
    'totalRefunds', totals.total_refunds,
    'statutoryWithholding', totals.statutory_withholding,
    'netExpected', totals.gross_sales - totals.total_fees - totals.total_refunds - totals.statutory_withholding,
    'netReceived', totals.net_received,
    'variance', totals.net_received - (totals.gross_sales - totals.total_fees - totals.total_refunds - totals.statutory_withholding)
  ),
  'orderCounts', jsonb_build_object(
    'total', coalesce((select count(*) from sales), 0),
    'bySource', coalesce((select jsonb_object_agg(source_key, order_count) from source_rollup), '{}'::jsonb)
  ),
  'salesBySource', coalesce((select jsonb_object_agg(source_key, jsonb_build_object('orderCount', order_count, 'grossSales', gross_sales)) from source_rollup), '{}'::jsonb),
  'matchHealth', jsonb_build_object(
    'overallMatchRatePct', coalesce(round(100.0 * (select count(*) from sales where is_matched) / nullif((select count(*) from sales), 0), 2), 0),
    'bySource', coalesce((select jsonb_object_agg(source_key, jsonb_build_object(
      'matchRatePct', coalesce(round(100.0 * matched_count / nullif(order_count, 0), 2), 0),
      'unmatchedValue', unmatched_value,
      'unmatchedCount', order_count - matched_count
    )) from source_rollup), '{}'::jsonb)
  ),
  'deductionsByCategory', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'value', value, 'count', count)) from deduction_rollup), '[]'::jsonb),
  'exceptions', jsonb_build_object(
    'byType', coalesce((select jsonb_object_agg(type, count) from exception_type_rollup), '{}'::jsonb),
    'byStatus', jsonb_build_object('open', (select open_count from exception_status_rollup), 'resolved', (select resolved_count from exception_status_rollup), 'requiresHumanReview', (select human_count from exception_status_rollup)),
    'topOpen', (select rows from top_open)
  ),
  'cod', jsonb_build_object(
    'remittanceCount', coalesce((select count(*) from event_base where canonical_type = 'COD_REMITTANCE'), 0),
    'avgSettlementLagDays', coalesce((select round(avg(lag_days), 2) from complete_cod_lag), 0),
    'rtoCount', coalesce((select count(*) from event_base where canonical_type = 'RTO_EVENT'), 0),
    'rtoValue', coalesce((select sum(abs(amount)) from event_base where canonical_type = 'RTO_EVENT'), 0)
  ),
  'amazon', jsonb_build_object(
    'unmatchedOrderCount', coalesce((select count(*) from sales s left join core.orders o on o.id = s.order_id where s.report_source = 'amazon' and o.id is null), 0),
    'unresolvedUnknownDeductions', coalesce((select count(*) from event_base where canonical_source = 'amazon' and category = 'unrecognized_deduction' and metadata->>'deduction_label' is null), 0),
    'resolvedUnknownDeductions', coalesce((select count(*) from event_base where canonical_source = 'amazon' and category = 'unrecognized_deduction' and metadata->>'deduction_label' is not null), 0)
  ),
  'timeSeries', coalesce((select jsonb_agg(jsonb_build_object('bucket', bucket, 'matchedValue', coalesce(matched_value, 0), 'unmatchedValue', coalesce(unmatched_value, 0))) from weekly), '[]'::jsonb)
)
from totals;
$$;
