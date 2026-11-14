# EduOS Integration Examples with SIS & LMS Platforms

One of EduOS's strengths is that it is **not** a closed ecosystem. It is designed to integrate with the tools districts already use.

## Enrollment Integration

### Google Workspace for Education + Clever
- Use the local EduOS Enrollment web UI as the source of truth for device-to-user mapping.
- Export enrollments as JSON/CSV and import into Google Admin or Clever via their APIs or SFTP.
- Recommended flow: Teacher scans student device QR code in EduOS Enrollment → data flows to Google/Clever roster.

### Canvas / Instructure
- EduOS can expose a simple webhook or REST endpoint (future enhancement) that Canvas can call when a new user or course is created.
- Alternatively, poll the local `/var/lib/eduos/enrollments/` directory and sync via Canvas SIS Import API.

### PowerSchool / Skyward / Infinite Campus
- These systems are usually the source of truth for student rosters.
- Best pattern: Nightly export from SIS → transform to EduOS enrollment format → push to district control plane → devices receive updated allowed user lists on next health/enrollment cycle.
- EduOS Enrollment can also act as a "last mile" confirmer (teacher verifies the student is physically present with the device).

## Health & Telemetry Integration

### District Dashboards
- The `eduos-health` service writes structured JSON reports.
- These can be:
  - Pushed to a central EduOS collector
  - Forwarded to existing tools like Grafana, Zabbix, or PRTG
  - Aggregated and sent to state reporting systems in anonymized form

### Compliance Reporting
- Many states require device compliance data (encryption status, OS version, last check-in).
- EduOS health reports already contain the necessary fields. A small transformer script can convert them into the exact format required by your state department of education.

## Update & Policy Integration

### Existing MDM / RMM Tools
- EduOS is **not** trying to replace Jamf, Intune, or ManageEngine for organizations that already have them.
- Instead, treat EduOS as the **immutable base OS layer**. Use your existing MDM to manage applications and policies *on top of* the EduOS foundation.
- The `eduos-update` service can be configured to respect maintenance windows defined in your current RMM tool.

### Staged Rollouts
- EduOS update policy (`update-policy.toml`) supports canary percentages and health-check gates.
- You can integrate this with your existing change management / CAB process by having the district control plane only promote canaries after human approval.

## Example: Minimal SIS Sync Script (Conceptual)

```python
# Simple example: Sync PowerSchool export into EduOS enrollments
import json
import csv
from datetime import datetime

def sync_powerschool_to_eduos(csv_path, output_dir):
    with open(csv_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            enrollment = {
                "timestamp": datetime.now().isoformat(),
                "student_id": row["student_id"],
                "name": row["full_name"],
                "grade": row["grade"],
                "homeroom": row["homeroom"],
                "source": "powerschool"
            }
            filename = f"enroll-{row['student_id']}.json"
            with open(f"{output_dir}/{filename}", "w") as out:
                json.dump(enrollment, out, indent=2)

# Run this nightly via cron or systemd timer on the district control plane
```

## Recommended Integration Architecture

```
SIS / LMS (Source of Truth)
        ↓ (nightly export or webhook)
District EduOS Control Plane
        ↓ (policy + roster sync)
Edge Nodes (local cache + enrollment UI)
        ↓ (local web UI or API)
Student / Teacher Devices
```

This keeps the source of truth where it belongs while giving teachers fast local enrollment capability even when the WAN is down.

## Want More?

If your district uses a specific platform not listed here (Schoology, Blackbaud, ClassLink, etc.), open an issue or pull request with details. We are happy to add concrete integration examples.
