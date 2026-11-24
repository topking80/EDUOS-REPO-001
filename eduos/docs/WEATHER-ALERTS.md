# National Weather Service prompts (SAFE-04)

EduOS can watch the National Weather Service (api.weather.gov) for each
school's location and prompt the school's leaders when a warning covers it.
**It never starts an alert on its own.** A leader starts the shelter or hold
(with the usual two-step confirm) or dismisses the prompt with a reason.

## Turning it on

1. District IT sets `WEATHER_ALERTS_USER_AGENT` on the API, with a contact,
   e.g. `EduOS (it@district.org)`. NWS requires every client to identify
   itself; without it the sweep doesn't run. `WEATHER_ALERTS_INTERVAL_SECONDS`
   (default 120, minimum 60, 0 to stop) sets how often it checks.
2. The superintendent turns on "Check the National Weather Service" under
   Safety → Weather alerts.
3. Each principal (or vice principal), or the superintendent, enters the
   school's latitude and longitude there (four decimals).

## What is sent

Only the school's coordinates, as `GET /alerts/active?point=lat,lon`. No
student, staff or school data leaves EduOS. One request per distinct location
per sweep.

## What happens

| NWS alert | EduOS |
| --- | --- |
| Tornado, Severe Thunderstorm, Hurricane / Tropical Storm / Extreme Wind, Flash Flood / Flood, Winter Storm / Blizzard / Ice Storm, Excessive / Extreme Heat, Hazardous Materials / Shelter In Place **Warning** | The school's principal, vice principals and the superintendent get an in-app alert (and push/SMS/email where set up), and Safety shows a prompt: **Start shelter** (or hold) with the hazard chosen, or **Dismiss** with a reason. |
| Watches, advisories, statements | Listed under Weather alerts for information; no prompt. |
| Tests, exercises, cancellations | Ignored. |

An alert NWS stops listing ends; everything is kept with who decided what.
If NWS can't be reached, the sweep tries again next time and nothing changes.
