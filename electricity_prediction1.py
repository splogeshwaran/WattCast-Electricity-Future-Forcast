import pandas as pd
from pathlib import Path

def calculate_amount(u):
    # Define the rate slabs for total usage > 500
    slabs_above_500 = [
        (100, 0.0), (300, 4.70), (100, 6.30), (100, 8.40), (200, 9.45), (200, 10.50), (float('inf'), 11.55)
    ]
    # Define the rate slabs for total usage <= 500
    slabs_below_500 = [
        (200, 0.0), (200, 4.70), (float('inf'), 6.30)
    ]

    # Pick the correct slab definition based on total usage
    slabs = slabs_below_500 if u <= 500 else slabs_above_500

    amt = 0.0
    remaining_units = u

    for limit, rate in slabs:
        if remaining_units <= 0:
            break
        # Take either the full slab limit or whatever units are left
        units_in_slab = min(remaining_units, limit)
        amt += units_in_slab * rate
        remaining_units -= units_in_slab

    return amt

def predict_family_api(file_path):
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File '{file_path}' not found.")

    df = pd.read_csv(path)

    # Standardize column names (case-insensitive mapping to accommodate different CSV formats)
    rename_map = {}
    for col in df.columns:
        col_lower = col.lower().strip()
        if col_lower in ['date', 'month', 'period', 'billingmonth', 'monthyear']:
            rename_map[col] = 'Date'
        elif col_lower in ['units', 'kwh', 'consumption', 'units consumed', 'electricity consumed']:
            rename_map[col] = 'Units consumed'
        elif col_lower in ['occupants', 'occupends', 'members', 'people', 'familysize']:
            rename_map[col] = 'Occupends'
        elif col_lower in ['bill_amount', 'bill', 'amount', 'bill amount']:
            rename_map[col] = 'bill_amount'
    df = df.rename(columns=rename_map)

    # We specify format='mixed' or a specific string to handle the variety in CSV date styles
    df['Date'] = pd.to_datetime(df['Date'], dayfirst=True, errors='coerce')

    # Sort and remove null dates
    df = df.dropna(subset=['Date']).sort_values('Date')

    # Check if there is enough data
    if len(df) < 4:
        # Fallback to linear regression
        import numpy as np
        x_pts = np.arange(len(df))
        y_pts = df['Units consumed'].values if 'Units consumed' in df.columns else np.array([300.0] * len(df))
        
        slope, intercept = np.polyfit(x_pts, y_pts, 1) if len(df) >= 2 else (0.0, y_pts[0] if len(df) > 0 else 300.0)
        
        predictions = []
        last_date = df['Date'].iloc[-1] if len(df) > 0 else pd.Timestamp.now()
        prediction_dates = [last_date + pd.DateOffset(months=1), last_date + pd.DateOffset(months=2)]
        
        predictions.append(max(0.0, float(intercept + slope * len(df))))
        predictions.append(max(0.0, float(intercept + slope * (len(df) + 1))))
    else:
        # Aggregate using mean to stay within your actual observed unit range
        df_monthly = df.groupby([df['Date'].dt.year, df['Date'].dt.month]).agg({
            'Units consumed': 'mean',
            'Occupends': 'mean',
            'Date': 'first'
        }).reset_index(drop=True)

        df_monthly = df_monthly.sort_values('Date')

        # Features derived ONLY from the existing historical columns
        df_monthly['Year'] = df_monthly['Date'].dt.year
        df_monthly['Month'] = df_monthly['Date'].dt.month
        df_monthly['Usage_Lag_1'] = df_monthly['Units consumed'].shift(1)
        df_monthly['Usage_Rolling_3'] = df_monthly['Units consumed'].shift(1).rolling(window=3).mean()
        
        df_ml = df_monthly.dropna().copy()
        
        if len(df_ml) < 2:
            # Fallback if too many NaNs were dropped
            import numpy as np
            x_pts = np.arange(len(df_monthly))
            y_pts = df_monthly['Units consumed'].values
            slope, intercept = np.polyfit(x_pts, y_pts, 1) if len(df_monthly) >= 2 else (0.0, y_pts[0])
            predictions = [
                max(0.0, float(intercept + slope * len(df_monthly))),
                max(0.0, float(intercept + slope * (len(df_monthly) + 1)))
            ]
            last_date = df_monthly['Date'].iloc[-1]
            prediction_dates = [last_date + pd.DateOffset(months=1), last_date + pd.DateOffset(months=2)]
        else:
            from sklearn.ensemble import RandomForestRegressor

            features = ['Year', 'Month', 'Occupends', 'Usage_Lag_1', 'Usage_Rolling_3']
            X = df_ml[features]
            y = df_ml['Units consumed']

            model = RandomForestRegressor(n_estimators=100, random_state=42)

            # Fit on the entire historical dataset to capture the most recent monthly trends
            model.fit(X, y)

            df_h = df_ml.copy()
            predictions = []
            prediction_dates = []

            for i in range(2):
                last_month_data = df_h.iloc[-1]
                next_date = last_month_data['Date'] + pd.DateOffset(months=1)

                future_row = pd.DataFrame({
                    'Year': [next_date.year],
                    'Month': [next_date.month],
                    'Occupends': [last_month_data['Occupends']],
                    'Usage_Lag_1': [last_month_data['Units consumed']],
                    # Use df_h to dynamically include Month 1's prediction in Month 2's rolling average
                    'Usage_Rolling_3': [df_h['Units consumed'].tail(3).mean()]
                })

                next_month_pred = model.predict(future_row)[0]
                predictions.append(float(next_month_pred))
                prediction_dates.append(next_date)

                next_row = pd.DataFrame({
                    'Date': [next_date],
                    'Units consumed': [next_month_pred],
                    'Occupends': [last_month_data['Occupends']]
                })
                df_h = pd.concat([df_h, next_row], ignore_index=True)

    total_two_months = sum(predictions)
    amt = calculate_amount(total_two_months)

    # Output details structured as JSON-serializable list
    res = [
        {
            'date': prediction_dates[0].strftime('%b %Y'),
            'units': int(predictions[0]),
            'bill_amount': int(round((predictions[0] / total_two_months) * amt)) if total_two_months > 0 else 0,
            'predicted': True
        },
        {
            'date': prediction_dates[1].strftime('%b %Y'),
            'units': int(predictions[1]),
            'bill_amount': int(round((predictions[1] / total_two_months) * amt)) if total_two_months > 0 else 0,
            'predicted': True
        }
    ]
    return res

if __name__ == "__main__":
    import sys
    
    # Check if a custom CSV file is passed as a command-line argument
    file_path = "Family_7.csv"
    if len(sys.argv) > 1:
        file_path = sys.argv[1]
        
    print(f"Electricity Forecast & Billing Engine (Refactored)")
    print(f"Dataset path: {file_path}")
    print("-" * 40)
    
    try:
        # Generate predictions from the CSV file
        results = predict_family_api(file_path)
        print("Predictions successfully generated:")
        
        total_units = 0
        total_bill = 0
        
        for i, res in enumerate(results):
            print(f" Month {i+1} ({res['date']}): {res['units']} kWh | Estimated Bill: Rs. {res['bill_amount']}")
            total_units += res['units']
            total_bill += res['bill_amount']
            
        print("-" * 40)
        print(f"Total Predicted Units (Bi-monthly): {total_units} kWh")
        print(f"Combined Bill Amount: Rs. {total_bill}")
        
    except FileNotFoundError:
        print(f"\n[Warning] File '{file_path}' was not found.")
        print("Falling back to interactive manual entry mode...\n")
        
        try:
            monthly_usage1 = float(input("Enter Electricity Used in Month 1 (kWh): "))
            monthly_usage2 = float(input("Enter Electricity Used in Month 2 (kWh): "))
            total_units = monthly_usage1 + monthly_usage2
            combined_bill = calculate_amount(total_units)
            
            bill1 = (monthly_usage1 / total_units) * combined_bill if total_units > 0 else 0.0
            bill2 = (monthly_usage2 / total_units) * combined_bill if total_units > 0 else 0.0
            
            print("-" * 40)
            print(f"Total Predicted Units (Bi-monthly): {total_units:.2f} kWh")
            print(f"Combined Bill Amount: Rs. {combined_bill:.2f}")
            print(f"Predicted Bill for Month 1: Rs. {bill1:.2f}")
            print(f"Predicted Bill for Month 2: Rs. {bill2:.2f}")
        except ValueError:
            print("Invalid input. Please enter numerical values.")
        except KeyboardInterrupt:
            print("\nInteractive mode aborted.")