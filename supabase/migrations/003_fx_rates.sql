-- 003_fx_rates.sql
-- Daily FX rates for cost conversion (ADR-024). USD is the currency Bedrock bills in;
-- cost_pln = usd_cost x the latest USD/PLN rate here. Source: NBP (Narodowy Bank
-- Polski) Web API table A average rates — free, no key, and the official rate Polish
-- accounting uses: https://api.nbp.pl/api/exchangerates/rates/a/usd/?format=json
-- A small daily n8n cron upserts one row per NBP publication day; cost lookups read
-- the most recent row. Append-only migration (CLAUDE.md).

create table if not exists fx_rates (
  rate_date   date not null,                 -- NBP effectiveDate
  base        text not null default 'USD',
  quote       text not null default 'PLN',
  rate        numeric not null,              -- NBP rates[0].mid (1 USD = <rate> PLN)
  source      text not null default 'NBP-A', -- NBP table A
  table_no    text,                          -- NBP table number, for audit
  fetched_at  timestamptz not null default now(),
  primary key (rate_date, base, quote)
);

comment on table fx_rates is 'Daily USD/PLN (and future pairs) from NBP table A. Cost conversion uses the latest row. ADR-024.';

-- Latest rate for cost conversion:
--   select rate from fx_rates where base='USD' and quote='PLN' order by rate_date desc limit 1;
