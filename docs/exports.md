# CSV exports

Two places export CSV, and both give you every row that matches your current filters — not just the
page on screen.

## Jobs

`GET /api/admin/jobs/export`, 20 columns:

- `company`
- `title`
- `location`
- `state`
- `remote`
- `status`
- `source`
- `domain`
- `matches`
- `clients`
- `technologies`
- `posted_at`
- `first_seen_at`
- `url`
- `description`
- `seniority`
- `commitment`
- `workplace_type`
- `max_salary`
- `salary_currency`

## Companies

`GET /api/companies/export` — one row per company in the current scope, with its domains, how many
roles it has open, when it was first and last seen, and which of your monitors matched it.
