import { Pool, PoolClient } from 'pg';

export interface AreaStats {
  period_days: number;
  new_listings_window_days: number;
  active_listings: number;
  new_listings_30d: number;
  median_list_price: number | null;
  median_price_per_sqft: number | null;
  closed_sales: number;
  median_close_price: number | null;
  median_close_price_prior: number | null;
  median_close_price_change_pct: number | null;
  median_days_on_market: number | null;
  sale_to_list_pct: number | null;
}

const round = (v: number | null, step: number) => (v === null ? null : Math.round(v / step) * step);
const pct1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

/**
 * Market statistics for listings inside a polygon, computed in SQL. Every figure a
 * neighborhood report or insight may quote comes from this object, already rounded
 * the way it should be printed, so the report validator compares like with like.
 */
export async function areaStats(db: Pool | PoolClient, polygonSql: string, params: unknown[], periodDays = 90): Promise<AreaStats> {
  const p = params.length;
  const { rows } = await db.query(
    `WITH area AS (${polygonSql}),
     l AS (
       SELECT * FROM listings
       WHERE removed_at IS NULL AND ST_Within(geom, (SELECT geom FROM area))
     )
     SELECT
       count(*) FILTER (WHERE status IN ('Active', 'ComingSoon')) AS active_listings,
       count(*) FILTER (WHERE status <> 'Closed' AND original_entry_ts >= now() - interval '30 days') AS new_listings_30d,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY list_price) FILTER (WHERE status = 'Active') AS median_list_price,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY list_price::numeric / NULLIF(living_area_sqft, 0))
         FILTER (WHERE status = 'Active') AS median_ppsf,
       count(*) FILTER (WHERE status = 'Closed' AND close_date > current_date - $${p + 1}::int) AS closed_sales,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY close_price)
         FILTER (WHERE status = 'Closed' AND close_date > current_date - $${p + 1}::int) AS median_close,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY close_price)
         FILTER (WHERE status = 'Closed' AND close_date <= current_date - $${p + 1}::int
                 AND close_date > current_date - 2 * $${p + 1}::int) AS median_close_prior,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY close_date - original_entry_ts::date)
         FILTER (WHERE status = 'Closed' AND close_date > current_date - $${p + 1}::int) AS median_dom,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY close_price::numeric / NULLIF(list_price, 0))
         FILTER (WHERE status = 'Closed' AND close_date > current_date - $${p + 1}::int) AS sale_to_list
     FROM l`,
    [...params, periodDays],
  );
  const r = rows[0];
  const medianClose = round(r.median_close, 1000);
  const medianPrior = round(r.median_close_prior, 1000);
  return {
    period_days: periodDays,
    new_listings_window_days: 30,
    active_listings: Number(r.active_listings),
    new_listings_30d: Number(r.new_listings_30d),
    median_list_price: round(r.median_list_price, 1000),
    median_price_per_sqft: r.median_ppsf === null ? null : Math.round(r.median_ppsf),
    closed_sales: Number(r.closed_sales),
    median_close_price: medianClose,
    median_close_price_prior: medianPrior,
    median_close_price_change_pct:
      medianClose !== null && medianPrior ? pct1(((medianClose - medianPrior) / medianPrior) * 100) : null,
    median_days_on_market: r.median_dom === null ? null : Math.round(r.median_dom),
    sale_to_list_pct: r.sale_to_list === null ? null : pct1(r.sale_to_list * 100),
  };
}
