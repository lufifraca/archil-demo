import pandas as pd
df = pd.read_parquet("data/taxi.parquet")
print(f"{len(df):,} taxi trips loaded from the Archil disk")
print(df[["trip_distance", "fare_amount", "tip_amount"]].describe().round(2))
