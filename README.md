WattCast — Electricity Usage Forecasting

Smart 2-month electricity consumption forecasting system powered by Machine Learning.

Problem

Most electricity monitoring systems mainly show past or current consumption. Users often know their actual electricity bill only after the billing cycle, making it difficult to identify rising consumption and plan future usage.

Solution

WattCast is a web-based electricity management system that uses historical household electricity data to:

Analyze consumption patterns
Predict the next 2 months of electricity usage
Estimate upcoming electricity bills
Visualize historical and predicted consumption
Identify increasing consumption trends
Key Features
ML Forecasting — Random Forest Regression for future usage prediction
2-Month Prediction — Forecasts upcoming electricity consumption
Bill Estimation — Calculates estimated bills using Tamil Nadu slab-based billing
Interactive Dashboard — Visualizes historical and predicted usage
Data Upload — Supports CSV, XLS and XLSX files
Manual Entry — Add monthly readings manually
Fallback Model — Linear Regression when available data is insufficient
Multi-Family Support — Manage separate family datasets
How It Works
Historical Electricity Data
          ↓
     Data Processing
          ↓
   Feature Engineering
          ↓
   Random Forest Model
          ↓
  2-Month Usage Forecast
          ↓
   Bill Estimation
          ↓
 Dashboard & Insights
ML Features

The prediction model uses:

Year & Month
Previous month's usage
3-month rolling average
Number of occupants

The system predicts Month +1 and Month +2 iteratively.

Tech Stack

Frontend

HTML5
CSS3
JavaScript
Chart.js
SheetJS
PapaParse

Backend & ML

Python
Pandas
NumPy
Scikit-learn
Random Forest Regressor
Impact

WattCast transforms electricity data from a historical record into a predictive decision-support system.

Monitor → Analyze → Predict → Estimate → Act

Key Benefits
Better awareness of future electricity usage
Early understanding of potential high consumption
Improved electricity bill planning
Data-driven energy management
Support for reducing unnecessary consumption
USP

“Don't just know what you consumed — predict what you are likely to consume next.”

Unlike a basic electricity dashboard, WattCast combines consumption monitoring, ML-based forecasting, and bill estimation in one system.

Project Structure
WattCast/
├── index.html
├── styles.css
├── app.js
├── server.py
├── electricity_prediction1.py
└── README.md
