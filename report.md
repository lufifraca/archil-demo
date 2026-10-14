# NYC Yellow Taxi – January 2024: exploration & cleaning

Scripts: `clean_taxi.py` (cleaning → `data/taxi_clean.parquet`, `cleaning_log.json`), `analyze_taxi.py` (summaries, `tips_by_hour.csv`, `tips_by_hour.png`).
Run: `PYTHONPATH=/mnt/archil/workspace/pylib python3 clean_taxi.py && ... analyze_taxi.py`

## Raw data issues found
- 2,964,624 rows, 19 columns, no exact duplicates.
- 140,162 rows (4.7%) have null `passenger_count`, `RatecodeID`, `store_and_fwd_flag`, `congestion_surcharge`, `Airport_fee` (same rows). Kept (not needed for core analysis); passenger_count nulls are retained.
- Pickup timestamps outside January 2024 (earliest 2002-12-31).
- Impossible values: negative fares (min -$899), negative tips/tolls/surcharges, trip_distance up to 312,722 miles, fares up to $5,000, passenger_count 0 or up to 9, RatecodeID 99, zero/very short trips.

## Cleaning rules (rows removed, sequential)
| Rule | Removed |
|---|---|
| Pickup outside Jan 2024 | 18 |
| Duration < 1 min or > 3 h | 37,104 |
| Distance ≤ 0 or > 100 mi | 36,269 |
| fare_amount < $3 (min metered fare) or > $500 | 33,671 |
| passenger_count 0 or > 6 (nulls kept) | 30,496 |
| Implied speed > 80 mph | 88 |

Result: **2,826,978 rows (95.4%) kept**. Added columns: `duration_min`, `speed_mph`, `pickup_hour`, `pickup_dow`, `tip_pct`.
Thresholds are judgment calls; adjust in `clean_taxi.py`.
Note: the initial fare rule (> $0) let through tiny fares with large tips, which made the mean tip % at 3am look like 49%; tightening to ≥ $3 fixed it, and I use the median in the chart as it's robust.

## Findings (cleaned data)
- Typical trip: median 1.7 mi, ~12 min, $12.80 fare; mean speed 11.5 mph.
- Payment: ~80% credit card (type 1). Tips are only recorded for cards (cash tips are ~$0), so tip analysis uses card trips only. 4.7% of card trips have zero tip.
- Tip % of fare (card trips): median ~25–26% for most of the day, lowest early morning (5–6am, ~24%), and highest in the evening 16–20h (~27–28%).
- Trips peak at 17–18h (~200k each hour) and are fewest at 4am (~15k).
- Busiest days: Wednesday, Tuesday; Sunday is the quietest. Monday has the longest/most expensive average trips (avg fare $19.7).

## Chart
![tips by hour](tips_by_hour.png)

Caveat: one month of data; outlier thresholds affect means; tip % is relative to fare only (excludes tolls/surcharges).
