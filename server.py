import http.server
import socketserver
import json
import os
import urllib.parse
from pathlib import Path
import pandas as pd

# Import the ML prediction API
from electricity_prediction1 import predict_family_api

PORT = 3000

class PredictionAPIHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        # Silence standard HTTP access logs to keep terminal logs clean
        pass

    def do_POST(self):
        if self.path == '/api/predict':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            
            try:
                # Load records sent by frontend
                data = json.loads(post_data.decode('utf-8'))
                records = data.get('records', [])
                
                if not records:
                    raise ValueError("No records provided in the request.")

                # Temporary file for predictions
                temp_filename = "temp_predict.csv"
                df = pd.DataFrame(records)
                
                # Check for standard columns and map them appropriately
                # Ensure the CSV format contains standard headers for the python script
                # We'll save with header columns date, occupants, units, bill_amount
                df.to_csv(temp_filename, index=False)
                
                # Call prediction
                predictions = predict_family_api(temp_filename)
                
                # Clean up
                if os.path.exists(temp_filename):
                    os.remove(temp_filename)
                
                # Send success response
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(predictions).encode('utf-8'))
                
            except Exception as e:
                # Clean up temp file if it was created
                if os.path.exists("temp_predict.csv"):
                    os.remove("temp_predict.csv")
                
                # Send error response
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

if __name__ == '__main__':
    # Change working directory to the directory of this server script to ensure files are served correctly
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)
    
    # Enable address reuse so restarting server doesn't hit "Address already in use" errors
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), PredictionAPIHandler) as httpd:
        print(f"WattCast backend server running on http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")
            httpd.server_close()
