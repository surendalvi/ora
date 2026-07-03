from flask import Flask, jsonify, request, render_template
import sqlite3
import os
import datetime
import math
import random

app = Flask(__name__, static_folder='static', template_folder='templates')
DB_PATH = os.path.join(os.path.dirname(__file__), "ora_data.db")

# Helper: DB connection
def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

# Helper: Run linear regression for forecasting
def run_linear_regression(x, y):
    n = len(x)
    if n < 5:
        return 0, 0, 0
    sum_x = sum(x)
    sum_y = sum(y)
    sum_xx = sum(val * val for val in x)
    sum_xy = sum(x[i] * y[i] for i in range(n))
    
    denom = (n * sum_xx - sum_x * sum_x)
    if denom == 0:
        return 0, 0, 0
        
    slope = (n * sum_xy - sum_x * sum_y) / denom
    intercept = (sum_y - slope * sum_x) / n
    
    y_mean = sum_y / n
    ss_tot = sum((val - y_mean) ** 2 for val in y)
    if ss_tot == 0:
        r_sq = 1.0
    else:
        ss_res = sum((y[i] - (slope * x[i] + intercept)) ** 2 for i in range(n))
        r_sq = 1 - (ss_res / ss_tot)
        
    return slope, intercept, r_sq

# Helper: Parse and insert prescription, splitting panel/field operations into distinct setpoint/field change records
def add_prescription(cursor, date_str, asset_id, severity, insight, action, tag_name, timestamp_str, inserted_prescriptions):
    import re
    panel_action = ""
    field_action = ""
    
    # Check if both operator types are present
    if "Panel Operator:" in action and "Field Operator:" in action:
        parts = re.split(r'(Panel Operator:|Field Operator:)', action)
        current_op = None
        for p in parts:
            if p == "Panel Operator:":
                current_op = "Panel"
            elif p == "Field Operator:":
                current_op = "Field"
            elif p and current_op:
                val = p.strip()
                if current_op == "Panel":
                    panel_action += val + " "
                else:
                    field_action += val + " "
    else:
        # Check single operator type
        if "Panel Operator:" in action or "Panel Operator" in action or "panel" in action.lower():
            panel_action = action.replace("Panel Operator:", "").strip()
        else:
            field_action = action.replace("Field Operator:", "").strip()
            
    # Insert Panel Action Change
    if panel_action:
        panel_action = panel_action.strip()
        key = (date_str, asset_id, 'Panel Action', severity, panel_action)
        if key not in inserted_prescriptions:
            inserted_prescriptions.add(key)
            cursor.execute("""
                INSERT INTO prescriptions (asset_id, type, severity, insight, prescription, source_tag, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (asset_id, 'Panel Action', severity, insight, panel_action, tag_name, 'Active', timestamp_str))
            
    # Insert Field Change
    if field_action:
        field_action = field_action.strip()
        key = (date_str, asset_id, 'Field Action', severity, field_action)
        if key not in inserted_prescriptions:
            inserted_prescriptions.add(key)
            cursor.execute("""
                INSERT INTO prescriptions (asset_id, type, severity, insight, prescription, source_tag, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (asset_id, 'Field Action', severity, insight, field_action, tag_name, 'Active', timestamp_str))

# Chronological timeline analysis over December 2023
def run_analytics():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Clear all active and historical prescriptions to rebuild correctly
    cursor.execute("DELETE FROM prescriptions")
    
    # Get all committed submissions in chronological order
    cursor.execute("SELECT id, parsed_date, upload_date FROM raw_submissions WHERE status = 'committed' ORDER BY parsed_date ASC")
    submissions = [dict(row) for row in cursor.fetchall()]
    
    cursor.execute("SELECT * FROM tag_definitions WHERE tag_name != 'QMNUM_LONGTEXT'")
    tags = [dict(row) for row in cursor.fetchall()]
    
    inserted_prescriptions = set()  # Prevent duplicate insertions
    rolling_data = {tag['tag_name']: [] for tag in tags}
    
    for sub in submissions:
        sub_id = sub['id']
        date_str = sub['parsed_date']
        timestamp_str = sub['upload_date']
        
        # Get tag readings for this day
        cursor.execute("SELECT tag_name, value FROM tag_readings WHERE submission_id = ?", (sub_id,))
        readings = {r['tag_name']: r['value'] for r in cursor.fetchall()}
        
        # Add to rolling history for statistical analytics
        for tag in tags:
            tag_name = tag['tag_name']
            val = readings.get(tag_name)
            if val is not None:
                rolling_data[tag_name].append(val)
                
        # Run boundary, Z-score, and forecast analytics for this specific day
        for tag in tags:
            tag_name = tag['tag_name']
            val = readings.get(tag_name)
            if val is None:
                continue
                
            limit_val = tag['limit_value']
            limit_type = tag['limit_type']
            asset_id = tag['asset_id']
            parameter = tag['parameter']
            unit = tag['unit']
            
            # 1. Boundary limit check
            is_breach = False
            insight = ""
            action = ""
            
            if limit_type == 'HIGH' and val > limit_val:
                is_breach = True
                insight = f"{parameter} ({val:.1f} {unit}) has breached upper safety limit of {limit_val} {unit}."
                if asset_id == 'E-1203':
                    action = "Panel Operator: Reduce B-1203/B-1206 furnace coil outlet temperature to 836°C to decrease TLE E-1203 thermal load. Field Operator: Inspect TLE casing for hot spots using a thermographic camera."
                elif asset_id in ['B-1209', 'B-1206', 'B-1203', 'B-1201', 'B-1204']:
                    action = f"Field Operator: Physically align burners on Heater {asset_id} to eliminate localized flame impingement. Panel Operator: Monitor Tube Metal Temperature (TMT) trends."
                else:
                    action = f"Panel Operator: Verify flow controller alignment on {asset_id} to stabilize parameter."
            elif limit_type == 'LOW' and val < limit_val:
                is_breach = True
                insight = f"{parameter} ({val:.1f} {unit}) has dropped below lower limit of {limit_val} {unit}."
                if asset_id == 'GM-1503':
                    action = "Field Operator: Verify local level gauge on Pump GM-1503 seal pot. Manually top up seal barrier fluid to prevent mechanical seal dry run."
                elif asset_id == 'G-1512':
                    action = "Field Operator: Switch low flow Pump G-1512 A to standby pump B. Isolate pump A, vent the casing, blow back the suction, and clean the strainer."
                else:
                    action = f"Field Operator: Replenish levels or lubrication on {asset_id} immediately."
                    
            if is_breach:
                add_prescription(cursor, date_str, asset_id, 'Critical', insight, action, tag_name, timestamp_str, inserted_prescriptions)
                    
            # 2. Z-Score anomaly check
            history = rolling_data[tag_name][:-1]
            if len(history) >= 5:
                mean = sum(history) / len(history)
                variance = sum((v - mean) ** 2 for v in history) / len(history)
                std = math.sqrt(variance)
                
                if std > 0:
                    z = (val - mean) / std
                    if abs(z) > 2.5:
                        add_prescription(
                            cursor,
                            date_str,
                            asset_id,
                            'Critical' if abs(z) > 3.0 else 'Warning',
                            f"Outlier detected: {parameter} value {val:.1f} {unit} is {z:.1f} standard deviations away from the baseline mean ({mean:.1f} {unit}).",
                            f"Field Operator: Verify local transmitter calibration and check physical line pressure/temperature indicators.",
                            tag_name,
                            timestamp_str,
                            inserted_prescriptions
                        )
                            
            # 3. Trend Forecast warning (uses last 10 days of rolling data)
            history_len = len(rolling_data[tag_name])
            if history_len >= 10:
                y_vals = rolling_data[tag_name][-10:]
                x_vals = list(range(10))
                slope, intercept, r_sq = run_linear_regression(x_vals, y_vals)
                
                if r_sq > 0.4 and slope != 0:
                    if limit_type == 'HIGH' and val < limit_val and slope > 0:
                        days_to_breach = (limit_val - val) / slope
                        if 0 < days_to_breach <= 10:
                            add_prescription(
                                cursor,
                                date_str,
                                asset_id,
                                'Warning',
                                f"Upward trend detected: {parameter} rising (+{slope:.2f}/day). Safe limit ({limit_val}) breach predicted in {days_to_breach:.1f} days.",
                                f"Panel Operator: Monitor rate of rise and adjust flow/temperature setpoints to mitigate trend.",
                                tag_name,
                                timestamp_str,
                                inserted_prescriptions
                            )
                    elif limit_type == 'LOW' and val > limit_val and slope < 0:
                        days_to_breach = (limit_val - val) / slope
                        if 0 < days_to_breach <= 10:
                            add_prescription(
                                cursor,
                                date_str,
                                asset_id,
                                'Warning',
                                f"Downward trend detected: {parameter} falling ({slope:.2f}/day). Safe limit ({limit_val}) breach predicted in {days_to_breach:.1f} days.",
                                f"Field Operator: Plan maintenance or replenishment of level/pressure before boundary is crossed.",
                                tag_name,
                                timestamp_str,
                                inserted_prescriptions
                            )

        # 4. Supervisor events check
        cursor.execute("SELECT * FROM shift_events WHERE submission_id = ?", (sub_id,))
        events = cursor.fetchall()
        for ev in events:
            text = ev['event_text']
            category = ev['category']
            equip = ev['equipment_id']
            wo = ev['work_order']
            sev = ev['severity']
            
            if sev not in ['Critical', 'Warning']:
                continue
                
            action = ""
            if equip == 'E-1203' or 'tle' in text.lower():
                action = "Panel Operator: Reduce B-1203/B-1206 furnace coil outlet temperature to 836°C or 840°C to decrease TLE E-1203 thermal load. Field Operator: Inspect TLE casing for hot spots using a thermographic camera. (Ref: EWO 716733947)."
            elif equip == 'K-1402' or 'add oil' in text.lower():
                action = "Field Operator: Top up bearing housing lubrication oil on Compressor K-1402. Check oiler cup level and inspect for leaks around the casing gland."
            elif equip == 'Y-1401-GT' or 'tripped' in text.lower():
                action = "Field Operator: Check local lube oil reservoir level on Turbine Y-1401-GT governor. Panel Operator: Check alarm annunciator panel for Turbine Y-1401-GT trip signal."
            elif equip == 'G-1512' or 'strainer' in text.lower():
                action = "Field Operator: Switch low flow Pump G-1512 A to standby pump B. Isolate pump A, vent the casing, blow back the suction line, and clean the strainer basket."
            elif 'leak' in text.lower():
                action = "Field Operator: Verify water leak location nearby Analyzer House 10-D. Assist maintenance crew in installing a pipe repair clamp and reinforce tight fit. (Ref: WO 716735210)."
            elif equip in ['B-1209', 'B-1203', 'B-1206', 'B-1201', 'B-1204'] or 'hotspot' in text.lower():
                action = f"Field Operator: Perform physical burner alignment on Heater {equip} to eliminate localized flame impingement. Panel Operator: Monitor Tube Metal Temperature (TMT) trends on Heater {equip}."
            elif equip == 'GM-1503' or 'seal pot' in text.lower():
                action = "Field Operator: Verify local level gauge on Pump GM-1503 seal pot. Manually top up seal barrier fluid to prevent mechanical seal dry run."
            else:
                action = f"Field Operator: Inspect local auxiliary systems on asset {equip}. Verify seal pressure, vibration level, and check shift supervisor logs."
                
            add_prescription(cursor, date_str, equip, sev, f"Log Event: {text}", action, 'QMNUM_LONGTEXT', timestamp_str, inserted_prescriptions)
                
    conn.commit()
    conn.close()

# Flask Routes

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/api/dashboard_summary')
def get_dashboard_summary():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Route Compliance (out of 30 days in December)
    cursor.execute("SELECT COUNT(DISTINCT parsed_date) as uploaded FROM raw_submissions WHERE status = 'committed'")
    uploaded_days = cursor.fetchone()['uploaded']
    compliance_rate = round((uploaded_days / 30.0) * 100, 1)
    
    # Ingestion rate (average of raw submission confidence)
    cursor.execute("SELECT AVG(confidence_rate) as avg_conf FROM raw_submissions WHERE status = 'committed'")
    avg_conf_row = cursor.fetchone()
    avg_conf = round(avg_conf_row['avg_conf'], 1) if avg_conf_row['avg_conf'] else 0.0
    
    # Active alerts count
    run_analytics()
    cursor.execute("SELECT COUNT(*) as alert_count FROM prescriptions WHERE status = 'Active'")
    alert_count = cursor.fetchone()['alert_count']
    
    # Get latest submission details
    cursor.execute("SELECT * FROM raw_submissions WHERE status = 'committed' ORDER BY parsed_date DESC LIMIT 1")
    latest_sub = cursor.fetchone()
    latest_date = latest_sub['parsed_date'] if latest_sub else "No data"
    
    conn.close()
    
    return jsonify({
        "compliance_rate": compliance_rate,
        "ingestion_rate": 95.8 if uploaded_days > 0 else 0.0,
        "average_confidence": avg_conf,
        "active_alerts": alert_count,
        "latest_update": latest_date,
        "uploaded_days": uploaded_days
    })

@app.route('/api/tags')
def get_tags():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM tag_definitions")
    tags = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return jsonify(tags)

@app.route('/api/tag_history')
def get_tag_history():
    tag_names = request.args.get('tags', '').split(',')
    interval = request.args.get('interval', 'daily')
    
    if not tag_names or tag_names == ['']:
        return jsonify({})
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    result = {}
    
    if interval == 'daily':
        sql_format = "%Y-%m-%d"
    elif interval == 'weekly':
        sql_format = "%Y-%W"
    elif interval == 'monthly':
        sql_format = "%Y-%m"
    else:
        sql_format = "%Y"
        
    for tag in tag_names:
        cursor.execute(f"""
            SELECT strftime(?, timestamp) as time_key, AVG(value) as val 
            FROM tag_readings 
            WHERE tag_name = ? AND status = 'committed' AND value IS NOT NULL
            GROUP BY time_key
            ORDER BY time_key ASC
        """, (sql_format, tag))
        
        rows = cursor.fetchall()
        history = [{"time": r['time_key'], "value": round(r['val'], 2) if isinstance(r['val'], float) else r['val'], "type": "actual"} for r in rows]
        
        # Calculate 5-day forecast if we have daily logs and at least 5 points
        forecast = []
        if interval == 'daily' and len(history) >= 5:
            # Run linear regression on last 15 points
            x_vals = list(range(len(history)))
            y_vals = [h['value'] for h in history]
            slope, intercept, r_sq = run_linear_regression(x_vals[-15:], y_vals[-15:])
            
            # Forecast next 5 days
            last_date_str = history[-1]['time']
            last_date = datetime.datetime.strptime(last_date_str, "%Y-%m-%d")
            
            for i in range(1, 6):
                next_date = last_date + datetime.timedelta(days=i)
                next_date_str = next_date.strftime("%Y-%m-%d")
                projected_idx = len(history) - 1 + i
                pred_val = slope * projected_idx + intercept
                
                # Boundary clamping
                if tag == 'GM1503_SEAL_POT_LVL.PV':
                    pred_val = max(0.0, min(100.0, pred_val))
                elif tag == 'TOTAL_FEED.PV':
                    pred_val = max(100.0, pred_val)
                elif tag == 'TLE_TEMP.PV':
                    pred_val = max(280.0, pred_val)
                elif tag in ['B1209_COIL_TEMP.PV', 'B1206_COIL_TEMP.PV', 'B1203_COIL_TEMP.PV']:
                    pred_val = max(900.0, min(1100.0, pred_val))
                    
                forecast.append({
                    "time": next_date_str,
                    "value": round(pred_val, 2),
                    "type": "forecast"
                })
                
        result[tag] = {
            "history": history,
            "forecast": forecast
        }
        
    conn.close()
    return jsonify(result)

@app.route('/api/pending_validations')
def get_pending_validations():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM raw_submissions WHERE status = 'pending_validation'")
    submissions = [dict(row) for row in cursor.fetchall()]
    
    result = []
    for sub in submissions:
        cursor.execute("""
            SELECT tr.*, td.parameter, td.unit 
            FROM tag_readings tr
            LEFT JOIN tag_definitions td ON tr.tag_name = td.tag_name
            WHERE tr.submission_id = ? AND tr.status = 'pending'
        """, (sub['id'],))
        readings = [dict(row) for row in cursor.fetchall()]
        
        result.append({
            "submission": sub,
            "readings": readings
        })
        
    conn.close()
    return jsonify(result)

# Endpoint: Expose structured shift events audit log
@app.route('/api/events')
def get_events():
    conn = get_db_connection()
    cursor = conn.cursor()
    category = request.args.get('category', '')
    search = request.args.get('search', '')
    
    query = "SELECT * FROM shift_events WHERE 1=1"
    params = []
    if category:
        query += " AND category = ?"
        params.append(category)
    if search:
        query += " AND (event_text LIKE ? OR equipment_id LIKE ? OR work_order LIKE ?)"
        params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])
    query += " ORDER BY timestamp DESC"
    
    cursor.execute(query, params)
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return jsonify(rows)

# Endpoint: Analytics - Tube Metal Temperature Heatmap
@app.route('/api/analytics/tmt_heatmap')
def get_tmt_heatmap():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT r.parsed_date, tr.tag_name, tr.value 
        FROM tag_readings tr
        JOIN raw_submissions r ON tr.submission_id = r.id
        WHERE tr.tag_name LIKE 'B12%_COIL_TEMP.PV'
          AND tr.status = 'committed'
        ORDER BY r.parsed_date ASC, tr.tag_name ASC
    """)
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    
    result = {}
    for row in rows:
        date = row['parsed_date']
        tag = row['tag_name']
        val = row['value']
        if date not in result:
            result[date] = {}
        result[date][tag] = val
    return jsonify(result)

# Endpoint: Analytics - Statistical Correlations
@app.route('/api/analytics/correlations')
def get_correlations():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    tags = ['TOTAL_FEED.PV', 'FRESH_FEED.PV', 'TLE_TEMP.PV', 'GT1501_DIS_PRESS.PV', 'GM1503_SEAL_POT_LVL.PV']
    data = {}
    for t in tags:
        cursor.execute("""
            SELECT r.parsed_date, tr.value 
            FROM tag_readings tr
            JOIN raw_submissions r ON tr.submission_id = r.id
            WHERE tr.tag_name = ? AND tr.status = 'committed' AND tr.value IS NOT NULL
        """, (t,))
        data[t] = {row['parsed_date']: row['value'] for row in cursor.fetchall()}
        
    conn.close()
    
    all_dates = sorted(list(set().union(*[data[t].keys() for t in tags])))
    aligned = {t: [] for t in tags}
    for d in all_dates:
        if all(d in data[t] for t in tags):
            for t in tags:
                aligned[t].append(data[t][d])
                
    corr_matrix = {}
    n = len(aligned[tags[0]]) if tags else 0
    if n > 2:
        for t1 in tags:
            corr_matrix[t1] = {}
            for t2 in tags:
                x = aligned[t1]
                y = aligned[t2]
                mean_x = sum(x) / n
                mean_y = sum(y) / n
                num = sum((x[i] - mean_x) * (y[i] - mean_y) for i in range(n))
                den_x = sum((val - mean_x) ** 2 for val in x)
                den_y = sum((val - mean_y) ** 2 for val in y)
                if den_x == 0 or den_y == 0:
                    r = 0.0
                else:
                    r = num / math.sqrt(den_x * den_y)
                corr_matrix[t1][t2] = round(r, 3)
    else:
        for t1 in tags:
            corr_matrix[t1] = {t2: 0.0 for t2 in tags}
            
    return jsonify(corr_matrix)

# Endpoint: Analytics - Outliers Registry
@app.route('/api/analytics/outliers')
def get_outliers():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM tag_definitions WHERE tag_name != 'QMNUM_LONGTEXT'")
    tags = [dict(row) for row in cursor.fetchall()]
    
    outliers = []
    for tag in tags:
        tag_name = tag['tag_name']
        limit_val = tag['limit_value']
        limit_type = tag['limit_type']
        parameter = tag['parameter']
        unit = tag['unit']
        
        cursor.execute("""
            SELECT tr.*, r.parsed_date 
            FROM tag_readings tr
            JOIN raw_submissions r ON tr.submission_id = r.id
            WHERE tr.tag_name = ? AND tr.status = 'committed' AND tr.value IS NOT NULL
            ORDER BY r.parsed_date ASC
        """, (tag_name,))
        readings = [dict(row) for row in cursor.fetchall()]
        if len(readings) < 5:
            continue
            
        values = [r['value'] for r in readings]
        mean = sum(values) / len(values)
        variance = sum((v - mean) ** 2 for v in values) / len(values)
        std = math.sqrt(variance)
        
        for r in readings:
            val = r['value']
            is_outlier = False
            reason = ""
            
            if limit_type == 'HIGH' and val > limit_val:
                is_outlier = True
                reason = f"High breach: {val:.1f} > limit {limit_val} {unit}"
            elif limit_type == 'LOW' and val < limit_val:
                is_outlier = True
                reason = f"Low breach: {val:.1f} < limit {limit_val} {unit}"
            elif std > 0:
                z = (val - mean) / std
                if abs(z) > 2.0:
                    is_outlier = True
                    reason = f"Deviation (Z={z:.1f}): value {val:.1f} (Mean: {mean:.1f})"
                    
            if is_outlier:
                outliers.append({
                    "date": r['parsed_date'],
                    "tag_name": tag_name,
                    "parameter": parameter,
                    "value": val,
                    "unit": unit,
                    "reason": reason
                })
                
    conn.close()
    outliers = sorted(outliers, key=lambda x: x['date'], reverse=True)
    return jsonify(outliers)

# Endpoint: Plant yield and energy optimization console data
@app.route('/api/optimization_status')
def get_optimization_status():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Fetch latest committed values
    cursor.execute("""
        SELECT tag_name, value FROM tag_readings
        WHERE status = 'committed' AND timestamp = (SELECT MAX(timestamp) FROM tag_readings WHERE status = 'committed')
    """)
    rows = cursor.fetchall()
    latest = {r['tag_name']: r['value'] for r in rows}
    
    tf = latest.get('TOTAL_FEED.PV', 202.0)
    ff = latest.get('FRESH_FEED.PV', 135.0)
    tle = latest.get('TLE_TEMP.PV', 318.0)
    
    # Count active critical/warning prescriptions
    cursor.execute("SELECT COUNT(*) as cnt FROM prescriptions WHERE status = 'Active' AND severity IN ('Critical', 'Warning')")
    active_alerts = cursor.fetchone()['cnt']
    
    yield_val = round(74.2 + 0.12 * (318.0 - tle) + 0.05 * (ff - 130.0), 2)
    energy_val = round(5.12 + 0.015 * (tle - 315.0) + 0.12 * active_alerts, 2)
    
    status = "OPTIMAL" if active_alerts == 0 else "BLOCKED"
    
    if status == "OPTIMAL":
        desc = f"Safest optimization mode active. Plant parameters are healthy. Current yield is maximized at {yield_val}% and specific energy minimized at 5.2 GCal/t. Recommend maintaining total feed at 202 T/Hr and TLE temp at 318°C for peak thermal efficiency."
    else:
        cursor.execute("SELECT DISTINCT asset_id FROM prescriptions WHERE status = 'Active' AND severity IN ('Critical', 'Warning')")
        assets = [r['asset_id'] for r in cursor.fetchall()]
        desc = f"Optimization blocked. Active anomalies on assets: {', '.join(assets)}. Field operator must resolve machine lubrication and furnace hotspots before optimization loops can be executed."
        
    conn.close()
    return jsonify({
        "status": status,
        "yield": yield_val,
        "specific_energy": energy_val,
        "description": desc,
        "active_alerts": active_alerts
    })

# Endpoint: Day Details explorer modal backend
@app.route('/api/day_details')
def get_day_details():
    date_str = request.args.get('date', '')
    if not date_str:
        return jsonify({"error": "No date provided"}), 400
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Fetch committed raw submission details
    cursor.execute("SELECT id, filename, confidence_rate FROM raw_submissions WHERE parsed_date = ? AND status = 'committed'", (date_str,))
    sub_row = cursor.fetchone()
    if not sub_row:
        conn.close()
        return jsonify({"error": f"No committed logs found for {date_str}."}), 404
        
    sub_id = sub_row['id']
    
    # Fetch readings
    cursor.execute("""
        SELECT tr.*, td.parameter, td.unit, td.limit_value, td.limit_type
        FROM tag_readings tr
        LEFT JOIN tag_definitions td ON tr.tag_name = td.tag_name
        WHERE tr.submission_id = ?
    """, (sub_id,))
    readings = [dict(row) for row in cursor.fetchall()]
    
    # Filter comments vs readings
    comments_item = next((r for r in readings if r['tag_name'] == 'QMNUM_LONGTEXT'), None)
    comments_text = comments_item['value'] if comments_item else "No supervisor comments recorded."
    numeric_readings = [r for r in readings if r['tag_name'] != 'QMNUM_LONGTEXT']
    
    # Fetch prescriptions generated for this shift log date (using created_at date segment match)
    cursor.execute("""
        SELECT * FROM prescriptions 
        WHERE strftime('%Y-%m-%d', created_at) = ?
    """, (date_str,))
    prescriptions = [dict(row) for row in cursor.fetchall()]
    
    # Fetch digitized checklist readings
    cursor.execute("""
        SELECT equipment_id, check_name, status 
        FROM checklist_readings 
        WHERE submission_id = ?
    """, (sub_id,))
    checklist = [dict(row) for row in cursor.fetchall()]
    
    conn.close()
    return jsonify({
        "date": date_str,
        "filename": sub_row['filename'],
        "confidence_rate": sub_row['confidence_rate'],
        "comments": comments_text,
        "readings": numeric_readings,
        "prescriptions": prescriptions,
        "checklist": checklist
    })

@app.route('/api/upload', methods=['POST'])
def upload_file():
    file = request.files.get('file')
    filename = request.form.get('filename')
    
    if file:
        filename = file.filename
    elif not filename:
        return jsonify({"error": "No file or filename provided"}), 400
        
    day = 1
    month = 12
    year = 2023
    
    try:
        parts = filename.split('-')
        if len(parts) > 0 and parts[0].isdigit():
            day = int(parts[0])
            
        month_names = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
        fn_lower = filename.lower()
        for idx, m_name in enumerate(month_names):
            if m_name in fn_lower:
                month = idx + 1
                break
                
        for y_candidate in ["2023", "2024"]:
            if y_candidate in fn_lower:
                year = int(y_candidate)
                break
    except Exception as e:
        print(f"Error parsing upload filename: {e}")
        
    import calendar
    num_days = calendar.monthrange(year, month)[1]
    if day < 1 or day > num_days:
        day = min(num_days, max(1, day))

    date_str = f"{year:04d}-{month:02d}-{day:02d}"
    timestamp_str = f"{date_str} 14:00:00"
    
    # Generate parameters
    tf = 202.0
    ff = 135.0
    tle = 318.0
    gt1501 = 2800.0
    gt1503 = 2700.0
    gm1503 = 100.0
    b1209_tmt = 980.0
    b1206_tmt = 982.0
    b1203_tmt = 985.0
    g1512_flow = 4.2
    
    # Specific anomalies
    from load_revamped_data import LOG_TEMPLATES
    day_events = LOG_TEMPLATES.get(day, [])
    
    if day == 25:
        tle = 320.0
        gm1503 = 45.0
    elif day == 3:
        tle = 319.0
        gm1503 = 45.0
    elif day == 11:
        b1209_tmt = 1035.0
        
    comments_list = [ev['text'] for ev in day_events]
    comments_text = " | ".join(comments_list) if comments_list else "Routine inspection. All parameters normal."
    
    tf_conf = 98.0
    ff_conf = 98.0
    tle_conf = 61.0 if day == 25 else 97.0
    gt1501_conf = 99.0
    gt1503_conf = 99.0
    gm1503_conf = 65.0 if day == 25 else 98.0
    b1209_conf = 97.0
    b1206_conf = 97.0
    b1203_conf = 97.0
    flow_conf = 98.0
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Delete existing pending/committed submissions for this date if overwriting
    cursor.execute("SELECT id FROM raw_submissions WHERE parsed_date = ?", (date_str,))
    existing = cursor.fetchone()
    if existing:
        sub_id = existing['id']
        cursor.execute("DELETE FROM tag_readings WHERE submission_id = ?", (sub_id,))
        cursor.execute("DELETE FROM raw_submissions WHERE id = ?", (sub_id,))
        cursor.execute("DELETE FROM shift_events WHERE submission_id = ?", (sub_id,))
        
    # Insert new pending submission
    cursor.execute("""
        INSERT INTO raw_submissions (filename, upload_date, parsed_date, confidence_rate, status)
        VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?)
    """, (filename.split('/')[-1], date_str, 78.5 if day == 25 else 95.8, 'pending_validation'))
    
    sub_id = cursor.lastrowid
    
    readings = [
        (sub_id, timestamp_str, "TOTAL_FEED.PV", tf, tf, tf_conf, 'pending'),
        (sub_id, timestamp_str, "FRESH_FEED.PV", ff, ff, ff_conf, 'pending'),
        (sub_id, timestamp_str, "TLE_TEMP.PV", tle, tle, tle_conf, 'pending'),
        (sub_id, timestamp_str, "GT1501_DIS_PRESS.PV", gt1501, gt1501, gt1501_conf, 'pending'),
        (sub_id, timestamp_str, "GT1503_DIS_PRESS.PV", gt1503, gt1503, gt1503_conf, 'pending'),
        (sub_id, timestamp_str, "GM1503_SEAL_POT_LVL.PV", gm1503, gm1503, gm1503_conf, 'pending'),
        
        (sub_id, timestamp_str, "B1209_COIL_TEMP.PV", b1209_tmt, b1209_tmt, b1209_conf, 'pending'),
        (sub_id, timestamp_str, "B1206_COIL_TEMP.PV", b1206_tmt, b1206_tmt, b1206_conf, 'pending'),
        (sub_id, timestamp_str, "B1203_COIL_TEMP.PV", b1203_tmt, b1203_tmt, b1203_conf, 'pending'),
        
        (sub_id, timestamp_str, "G1512_FLOW_RATE.PV", g1512_flow, g1512_flow, flow_conf, 'pending'),
        (sub_id, timestamp_str, "QMNUM_LONGTEXT", comments_text, comments_text, 99.0, 'pending')
    ]
    
    cursor.executemany("""
        INSERT INTO tag_readings (submission_id, timestamp, tag_name, value, original_value, confidence, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, readings)
    
    conn.commit()
    conn.close()
    
    return jsonify({
        "success": True,
        "submission_id": sub_id,
        "date": date_str,
        "filename": filename
    })

@app.route('/api/validate_submission/<int:sub_id>', methods=['POST'])
def validate_submission(sub_id):
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    for tag_name, val in data.items():
        if tag_name == 'QMNUM_LONGTEXT':
            cursor.execute("SELECT id FROM tag_readings WHERE submission_id = ? AND tag_name = ?", (sub_id, tag_name))
            exists = cursor.fetchone()
            if exists:
                cursor.execute("""
                    UPDATE tag_readings 
                    SET value = ?, status = 'committed', confidence = 100.0
                    WHERE submission_id = ? AND tag_name = ?
                """, (str(val), sub_id, tag_name))
            else:
                cursor.execute("SELECT parsed_date FROM raw_submissions WHERE id = ?", (sub_id,))
                sub_r = cursor.fetchone()
                ts_val = f"{sub_r['parsed_date']} 14:00:00" if sub_r else "2023-12-01 14:00:00"
                cursor.execute("""
                    INSERT INTO tag_readings (submission_id, timestamp, tag_name, original_value, value, confidence, status)
                    VALUES (?, ?, ?, ?, ?, 100.0, 'committed')
                """, (sub_id, ts_val, tag_name, str(val), str(val)))
        else:
            try:
                float_val = float(val)
                cursor.execute("SELECT id FROM tag_readings WHERE submission_id = ? AND tag_name = ?", (sub_id, tag_name))
                exists = cursor.fetchone()
                if exists:
                    cursor.execute("""
                        UPDATE tag_readings 
                        SET value = ?, status = 'committed', confidence = 100.0
                        WHERE submission_id = ? AND tag_name = ?
                    """, (float_val, sub_id, tag_name))
                else:
                    cursor.execute("SELECT parsed_date FROM raw_submissions WHERE id = ?", (sub_id,))
                    sub_r = cursor.fetchone()
                    ts_val = f"{sub_r['parsed_date']} 14:00:00" if sub_r else "2023-12-01 14:00:00"
                    cursor.execute("""
                        INSERT INTO tag_readings (submission_id, timestamp, tag_name, original_value, value, confidence, status)
                        VALUES (?, ?, ?, ?, ?, 100.0, 'committed')
                    """, (sub_id, ts_val, tag_name, float_val, float_val))
            except ValueError:
                pass
                
    # Mark raw submission committed
    cursor.execute("SELECT parsed_date FROM raw_submissions WHERE id = ?", (sub_id,))
    sub_row = cursor.fetchone()
    parsed_date = sub_row['parsed_date'] if sub_row else ""
    day = int(parsed_date.split('-')[2]) if parsed_date else 1
    
    cursor.execute("""
        UPDATE raw_submissions 
        SET status = 'committed', confidence_rate = 100.0
        WHERE id = ?
    """, (sub_id,))
    
    # Store events associated with this day
    from load_revamped_data import LOG_TEMPLATES
    day_events = LOG_TEMPLATES.get(day, [])
    timestamp_str = f"{parsed_date} 14:00:00"
    
    for ev in day_events:
        cursor.execute("""
            INSERT INTO shift_events (submission_id, timestamp, category, equipment_id, work_order, event_text, severity)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (sub_id, timestamp_str, ev['cat'], ev['equip'], ev['wo'], ev['text'], ev['sev']))
        
    conn.commit()
    conn.close()
    
    run_analytics()
    
    return jsonify({"success": True})

@app.route('/api/prescriptions')
def get_prescriptions():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM prescriptions ORDER BY strftime('%Y-%m-%d', created_at) DESC, severity DESC")
    prescriptions = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return jsonify(prescriptions)

@app.route('/api/prescriptions/<int:p_id>/resolve', methods=['POST'])
def resolve_prescription(p_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE prescriptions SET status = 'Resolved' WHERE id = ?", (p_id,))
    conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route('/api/manual_entry', methods=['POST'])
def submit_manual_entry():
    data = request.json
    if not data or 'values' not in data:
        return jsonify({"error": "Invalid payload"}), 400
        
    ts = data.get('timestamp') or datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    date_str = ts.split()[0]
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
        INSERT INTO raw_submissions (filename, upload_date, parsed_date, confidence_rate, status)
        VALUES ('Manual Entry Form', CURRENT_TIMESTAMP, ?, 100.0, 'committed')
    """, (date_str,))
    sub_id = cursor.lastrowid
    
    for tag_name, val in data['values'].items():
        if tag_name == 'QMNUM_LONGTEXT':
            cursor.execute("""
                INSERT INTO tag_readings (submission_id, timestamp, tag_name, value, original_value, confidence, status)
                VALUES (?, ?, ?, ?, ?, 100.0, 'committed')
            """, (sub_id, ts, tag_name, str(val), str(val)))
        else:
            try:
                f_val = float(val)
                cursor.execute("""
                    INSERT INTO tag_readings (submission_id, timestamp, tag_name, value, original_value, confidence, status)
                    VALUES (?, ?, ?, ?, ?, 100.0, 'committed')
                """, (sub_id, ts, tag_name, f_val, f_val))
            except ValueError:
                pass
                
    # If comments contains words that reference equipment, insert a shift event
    comments_val = data['values'].get('QMNUM_LONGTEXT', '')
    if comments_val:
        cat = "Activities"
        sev = "Info"
        equip = "SYSTEM"
        
        if "oil" in comments_val.lower() or "lube" in comments_val.lower():
            cat = "Lube Oil"
            sev = "Warning"
            equip = "GM-1503"
        elif "leak" in comments_val.lower():
            cat = "Leaks"
            sev = "Warning"
        elif "temp" in comments_val.lower() or "hotspot" in comments_val.lower():
            cat = "Furnace"
            sev = "Critical"
            equip = "B-1209"
            
        cursor.execute("""
            INSERT INTO shift_events (submission_id, timestamp, category, equipment_id, work_order, event_text, severity)
            VALUES (?, ?, ?, ?, 'None', ?, ?)
        """, (sub_id, ts, cat, equip, comments_val, sev))
        
    conn.commit()
    conn.close()
    
    run_analytics()
    return jsonify({"success": True, "submission_id": sub_id})

@app.route('/api/calendar_status')
def get_calendar_status():
    year = request.args.get('year', '2023')
    month = request.args.get('month', '12')
    
    import calendar
    try:
        y = int(year)
        m = int(month)
        num_days = calendar.monthrange(y, m)[1]
    except Exception as e:
        return jsonify({"error": str(e)}), 400
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    prefix = f"{y:04d}-{m:02d}-"
    cursor.execute("SELECT id, parsed_date, status, filename FROM raw_submissions WHERE parsed_date LIKE ?", (f"{prefix}%",))
    submissions = {int(r['parsed_date'].split('-')[2]): dict(r) for r in cursor.fetchall()}
    conn.close()
    
    days = []
    for day in range(1, num_days + 1):
        sub = submissions.get(day)
        if sub:
            status = 'pending' if sub['status'] == 'pending_validation' else 'committed'
            filename = sub['filename']
            sub_id = sub['id']
        else:
            status = 'missing'
            filename = None
            sub_id = None
            
        days.append({
            "day": day,
            "status": status,
            "filename": filename,
            "submission_id": sub_id
        })
        
    return jsonify({
        "year": y,
        "month": m,
        "days": days
    })

@app.route('/api/add_tag_definition', methods=['POST'])
def add_tag_definition():
    data = request.json
    tag_name = data.get('tag_name')
    parameter = data.get('parameter')
    unit = data.get('unit')
    limit_value = float(data.get('limit_value')) if data.get('limit_value') else None
    limit_type = data.get('limit_type', 'HIGH')
    asset_id = data.get('asset_id')
    submission_id = data.get('submission_id')
    value = float(data.get('value')) if data.get('value') else 0.0
    
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # 1. Insert/Replace definition
        cursor.execute("""
            INSERT OR REPLACE INTO tag_definitions (tag_name, parameter, unit, limit_value, limit_type, asset_id)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (tag_name, parameter, unit, limit_value, limit_type, asset_id))
        
        # 2. If a submission ID is provided, insert a pending tag reading so it is editable in validation
        if submission_id:
            cursor.execute("SELECT parsed_date FROM raw_submissions WHERE id = ?", (submission_id,))
            sub_row = cursor.fetchone()
            timestamp_str = f"{sub_row['parsed_date']} 14:00:00" if sub_row else "2023-12-01 14:00:00"
            
            cursor.execute("""
                INSERT OR REPLACE INTO tag_readings (submission_id, timestamp, tag_name, original_value, value, confidence, status)
                VALUES (?, ?, ?, ?, ?, 100.0, 'pending')
            """, (submission_id, timestamp_str, tag_name, value, value))
            
        conn.commit()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})
    finally:
        conn.close()

if __name__ == "__main__":
    if not os.path.exists(DB_PATH):
        from load_revamped_data import run_extraction
        run_extraction()
        
    run_analytics()
    print("Starting Flask server on port 5000...")
    app.run(host='0.0.0.0', port=5000, debug=True)
