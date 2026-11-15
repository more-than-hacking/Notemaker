# Notemaker data format v2

Both the web app and the macOS app read and write this format. A backup exported
from one imports into the other. All dates are local calendar days `YYYY-MM-DD`;
all timestamps are ISO-8601 UTC strings; times of day are `HH:MM` (24 h).

```jsonc
{
  "app": "notemaker",
  "version": 2,
  "exportedAt": "2026-11-15T10:00:00Z",
  "tasks": [Task],
  "notes": { "YYYY-MM-DD": Note },
  "habits": [Habit],
  "templates": [Template],
  "focusSessions": [FocusSession],
  "settings": Settings
}
```

## Task
| field | type | notes |
|---|---|---|
| `id` | string (UUID) | |
| `title` | string | quick-add tokens already removed |
| `date` | `YYYY-MM-DD` | the day it belongs to; for recurring tasks, the first day of the series |
| `done` | bool | non-recurring only |
| `completedAt` | ISO or null | non-recurring only |
| `createdAt` | ISO | |
| `priority` | `"none" \| "low" \| "medium" \| "high"` | |
| `tags` | string[] | lower-case, no `#` |
| `subtasks` | `[{ "id", "title", "done" }]` | |
| `status` | `"todo" \| "doing" \| "done"` | Kanban column; `done` ⇔ `done == true` (recurring: ⇔ date in `doneDates`) |
| `order` | number | sort order within a day (ascending) |
| `recurrence` | null or `{ "freq": "daily" \| "weekdays" \| "weekly" \| "monthly", "interval": 1, "byWeekday": [1..7], "until": "YYYY-MM-DD" \| null }` | `byWeekday` (1 = Monday … 7 = Sunday) only for `weekly`; empty ⇒ weekday of `date` |
| `doneDates` | `{ "YYYY-MM-DD": true }` | completions of a recurring task |
| `skipDates` | `{ "YYYY-MM-DD": true }` | occurrences deleted for one day only |
| `reminder` | `"HH:MM"` or null | notification on the task's day (each occurrence for recurring) |
| `timeBlock` | null or `{ "start": "HH:MM", "end": "HH:MM" }` | planner slot |
| `pomodoros` | `{ "estimate": int, "done": int }` | |
| `rolledFrom` | `YYYY-MM-DD` or null | original day if auto-rolled over; "overdue N days" = today − rolledFrom |
| `notes` | string | optional free text |

**Occurrence rule** (task appears on day `D`):
- no recurrence: `D == date`
- recurrence: `D >= date`, `D <= until` (if set), `D` not in `skipDates`, and
  - `daily`: (D − date) days % interval == 0
  - `weekdays`: D is Mon–Fri
  - `weekly`: weekday(D) ∈ (byWeekday or [weekday(date)]) and (weeks between the Mondays of `date` and `D`) % interval == 0
  - `monthly`: day-of-month(D) == day-of-month(date) (if the month is shorter, the last day) and (months between) % interval == 0

**Rollover** (when `settings.autoRollover` is true, on app start and at midnight): every
non-recurring task with `done == false` and `date < today` gets `rolledFrom = rolledFrom ?? date`,
`date = today`. **Snooze** sets `date` to the chosen day and clears `rolledFrom`.

## Note
`{ "markdown": string, "updatedAt": ISO, "locked": bool, "cipher": null | Cipher }`

When `locked` is true, `markdown` is `""` and the content lives in `cipher`:
`{ "alg": "AES-GCM-256", "kdf": "PBKDF2-SHA256", "iterations": 210000, "salt": base64(16 bytes), "iv": base64(12 bytes), "ct": base64(ciphertext ‖ 16-byte tag) }`.
The key is PBKDF2-SHA256(passcode UTF-8, salt, iterations, 32 bytes). Plaintext is the UTF-8 markdown.

**Wiki links**: `[[YYYY-MM-DD]]` inside markdown links to that day's note. Backlinks of day X are
all days whose (unlocked) markdown contains `[[X]]`.

## Habit
`{ "id", "name", "color": "#RRGGBB", "days": [1..7] (scheduled weekdays; empty = every day), "createdAt": ISO, "log": { "YYYY-MM-DD": true } }`
Streak = consecutive scheduled days ending today (or yesterday if today isn't logged yet) present in `log`.

## Template
`{ "id", "name", "markdown" }` — `{{date}}` is replaced with the long date, `{{weekday}}` with the weekday name.
Built-in (created on first run): **Daily journal**, **Meeting notes**, **Weekly review**.

## FocusSession
`{ "id", "taskId": string \| null, "start": ISO, "end": ISO, "minutes": int, "kind": "focus" \| "break" }`

## Settings
`{ "theme": "light" \| "dark" \| "system", "autoRollover": true, "focusMinutes": 25, "breakMinutes": 5, "reviewTime": "18:00" \| null, "weekStartsOn": 1, "dayStart": "07:00", "dayEnd": "21:00", "lockHash": null \| { "salt", "iterations", "hash" } }`
`lockHash` verifies the notes passcode: PBKDF2-SHA256(passcode, salt, iterations, 32) base64.

## Quick add grammar
Typed into the task box; recognised tokens are removed from the title (case-insensitive, any order):
| token | effect |
|---|---|
| `#word` | tag `word` |
| `!high` `!h` `!1` / `!medium` `!med` `!m` `!2` / `!low` `!l` `!3` | priority |
| `today`, `tomorrow`, `tmr` | date |
| `mon` … `sun`, `monday` … `sunday` | next occurrence (today counts if it matches) |
| `next week` | next Monday |
| `in N days` / `in N weeks` | date + N |
| `YYYY-MM-DD` | that date |
| `at 3pm`, `3pm`, `3:30pm`, `15:30`, `at 9` | reminder time (bare number needs `at`) |
| `every day` / `daily` | recurrence daily |
| `every weekday` / `weekdays` | recurrence weekdays |
| `every week` / `weekly` / `every mon` / `every monday` | recurrence weekly (weekday from the token or the task date) |
| `every month` / `monthly` | recurrence monthly |
| `~N` | pomodoro estimate N |

Test vectors (today = 2026-11-15, a Sunday):
| input | title | date | priority | tags | reminder | recurrence |
|---|---|---|---|---|---|---|
| `Call Raj tomorrow 3pm #work !high` | Call Raj | 2026-11-16 | high | work | 15:00 | – |
| `Standup every weekday at 9:30` | Standup | 2026-11-15 | none | – | 09:30 | weekdays |
| `Pay rent every month #home !2` | Pay rent | 2026-11-15 | medium | home | – | monthly |
| `Gym every mon #health` | Gym | 2026-11-16 | none | health | – | weekly [1] |
| `Write report in 3 days ~4` | Write report | 2026-11-18 | none | – | – | – (estimate 4) |
| `Plan sprint next week !low` | Plan sprint | 2026-11-16 | low | – | – | – |
| `Review 2026-12-01 at 14` | Review | 2026-12-01 | none | – | 14:00 | – |
| `Read #book #fun` | Read | 2026-11-15 | none | book, fun | – | – |

## Migration from v1
Web v1 (localStorage `notemaker_tasks` = array of `{id, title, date, completed, createdAt, subtasks:[{id, title, completed}]}`, `notemaker_notes` = array of `{date, content, createdAt}`) and macOS v1 (UserDefaults keys `saved_tasks` / `saved_notes`: JSON arrays of `{id, title, isCompleted, date (Date), createdAt}` / `{id, content, date (Date), createdAt}`) are converted on first start; nothing is deleted until the conversion succeeds.
