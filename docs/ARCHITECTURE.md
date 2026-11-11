# BuildTrack Pro — Architecture, Database Schema and Business Rules

## 1. Requirements coverage

| Spec area | Where it lives |
|---|---|
| 1 Multi-project management | `routes_core.js` projects, members, documents; access guard `auth.project()` |
| 2 Baseline | BOQ Excel import + manual entry, dependencies, resources, `baselines` / `baseline_activities` frozen snapshot |
| 3 Daily site reporting | `daily_reports` + labour / materials / equipment / photos, submit → review → approve |
| 4 Requests & inventory | `material_requests` (separate quantity per stage), `purchase_orders`, `deliveries`, `inventory_txns` ledger |
| 5 Automated planning | `engine.js` `forecastSchedule`, `materialShortages`, `proposeRevision`; `schedule_revisions` need approval |
| 6 Cost control & profit | `engine.js` `projectMetrics`; `budget_variations`; `cost_entries` |
| 7 Financial management | `invoices`, `supplier_bills`, `cash_transactions`, cash-flow report |
| 8 Executive dashboard | `GET /api/dashboard`, management reports (daily/weekly/monthly), Excel + PDF export |
| 9 Security & audit | RBAC, project-level access, `audit_log`, lockout, rate limit, helmet, daily backups |
| 10 Technical | Responsive React SPA, SQLite with constraints, REST API, file storage, hourly alert job, i18n (en/rw/fr) |

## 2. System architecture

```
Browser (React SPA, mobile-first)
   │  HTTPS + JWT (Bearer)
   ▼
Express API  ── helmet, rate-limit, JSON validation
   ├─ auth.js        login, lockout, RBAC matrix, project-membership guard
   ├─ routes_core.js users, projects, baseline, variations, schedule, daily reports, documents
   ├─ routes_ops.js  materials, purchasing, inventory, finance, dashboards, exports, backups
   ├─ services.js    gathers DB facts → feeds the pure engine; posts costs; alerts
   └─ engine.js      PURE calculations (no DB) – fully unit-tested
   ▼
SQLite (WAL, foreign keys ON, CHECK constraints)      Uploads folder (DATA_DIR/uploads)
Scheduled jobs (in-process): alerts hourly, backup daily (keeps newest 30)
```

Design choices:
- **Pure engine.** Every financial/schedule figure is computed in `engine.js` from plain objects, so calculations are verifiable by unit tests independent of the database.
- **Derived, not stored.** Progress, actual cost, committed cost, stock and profit are never stored as editable numbers; they are recomputed from source transactions. They cannot drift out of sync.
- **Append-only corrections.** Costs are corrected by a linked negative reversal entry with a reason; cash by a status change to `reversed` with a reason. Nothing is silently edited or deleted.
- **Offline-ready.** The API is stateless and every create endpoint rejects duplicates (unique keys on report date, delivery note, bill/invoice number, payment reference, cost source), so a future offline client can queue and re-send writes safely. An offline sync client is *not* built yet.
- **i18n.** UI strings are keys looked up in `client/src/i18n.js`; add a dictionary to add a language. Server-generated alert messages and validation errors are currently English only.
- **Scale.** SQLite on one server comfortably serves a construction company (tens of users, hundreds of thousands of rows). To move to PostgreSQL, replace `db.js` and the `better-sqlite3` calls (the SQL is standard apart from `datetime('now')`, `INSERT OR IGNORE` and `MAX()` in a few expressions).

## 3. Roles and permissions

| Role | Scope | Can |
|---|---|---|
| owner, admin | all projects | everything; only they approve budget variations, outgoing payments, awaiting-approval costs; manage users, settings |
| project_manager | assigned projects | baseline edit/approve, report approval (not own), request approval, purchase orders, request variations, approve schedule revisions, see finance |
| engineer | assigned | submit reports, request materials, request variations; **no money figures** |
| storekeeper | assigned | confirm deliveries, issue stock, adjust stock (with reason); **no money figures** |
| accountant | assigned | invoices, bills, cash, costs, purchase orders; see finance |
| viewer | assigned | read only, no money figures |

Users who are not assigned to a project get **404** for it (existence is not disclosed). The UI hides buttons by role, but the server enforces every rule.

## 4. Database schema (SQLite) — `server/src/schema.sql`

Key tables and relationships:

- `users`, `projects`, `project_members(project_id,user_id)`, `documents`
- Baseline: `activities` (current plan; `budget_cost` = original cost budget), `activity_deps`, `activity_resources` (qty per unit of activity — the technical specification), `materials`, `suppliers`, `baselines` + `baseline_activities` (frozen snapshot at approval)
- Changes: `budget_variations` (pending/approved/rejected; never overwrite the original), `schedule_revisions` (JSON proposal; applied only on approval)
- Site: `daily_reports` (unique per project+date) → `report_lines`, `report_labour`, `report_materials`, `report_equipment`
- Materials: `material_requests` (requested, approved, from_stock, to_purchase, purchased, delivered, received, issued — each its own column) → `purchase_orders` → `deliveries` (qty_delivered vs qty_received) ; `inventory_txns` ledger (`receive`, `issue`, `consume`, `waste`, `adjust`)
- Money: `cost_entries` (accounting cost; status actual/estimated/awaiting_approval/void; unique per source), `invoices`, `supplier_bills`, `cash_transactions` (direction in/out; pending_approval → approved; unique project+kind+reference)
- Control: `settings` (thresholds), `alerts` (stable `alert_key`), `audit_log`

Integrity enforced by the database: foreign keys, `CHECK` constraints (non-negative quantities/amounts, status enums, `activity_id <> depends_on_id`), `UNIQUE` keys against duplicates.

## 5. Business rules and where they are enforced

| Rule | Enforcement |
|---|---|
| Requested ≠ consumed | Each stage is a separate column; stock is computed only from `inventory_txns`. A request creates no ledger row. |
| Stock changes only on confirmation | `receive` row written when the storekeeper confirms a delivery; `issue` on issue; `consume`/`waste` only when a daily report is **approved**. |
| Cannot consume what is not on site | Report approval fails (409) if consumed + wasted exceeds quantity issued to site. |
| Stock check before purchasing | Approval computes `from_stock` / `to_purchase`; a PO cannot exceed `to_purchase`; stock reserved for approved requests cannot be issued to others. |
| Committed ≠ paid cash | Open POs count as *committed* (estimated). They become actual cost only on received quantity, and are never cash. |
| Costs ≠ cash | `cost_entries` and `cash_transactions` are separate tables. Material cost is booked at receipt; labour/equipment at report approval. Supplier bills create no cost. |
| Profit not from cash | `profit = contract + approved revenue variations − forecast final cost`. Tests prove cash movements leave profit unchanged. |
| Original vs approved budget | `activities.budget_cost` and the baseline snapshot are never changed after approval; only **approved** variations add to the revised budget. |
| Forecast uses progress, remaining qty, current cost, future cost | EAC per activity = actual + max(remaining qty × current unit cost, committed). Below 10 % progress it falls back to the remaining share of budget. |
| Basis labels | Every figure is tagged `actual`, `estimated`, `forecast` or `awaiting_approval` in the API and UI. |
| Human approval | Budget variations (owner/admin), outgoing payments (owner/admin), awaiting-approval costs (owner/admin), schedule revisions (PM+), reports (reviewer ≠ author). |
| No duplicates | Unique constraints + friendly 409s; corrections via traceable reversal. |
| Audit | Every create / update / approve / reject / cancel / reverse / export writes who, when, reason, before/after. |

## 6. Forecast formulas (`engine.js`)

- Progress (activity) = approved completed qty ÷ planned qty (capped at 100 %). Project progress = Σ(progress × revised budget) ÷ Σ budget.
- Revised budget = original + approved cost variations. Remaining budget = revised − actual − committed.
- Cost variance (earned-value) = earned value − actual cost, where earned value = progress × revised budget.
- Schedule: rate = blend of measured pace and approved productivity (weight = days of data ÷ 14, max 1); finish = today + ⌈remaining ÷ rate⌉; successors start after predecessors' forecast finish.
- Shortage = (remaining qty × material qty/unit) − (store + site + open orders).
- Alerts: budget warning/critical, forecast overrun, margin, schedule delay, activity over budget, material shortage — thresholds editable in Settings (audited).

## 7. API overview

All endpoints are under `/api`, JSON, `Authorization: Bearer <token>`.

`POST /auth/login` · `GET /me` · `/users` · `/projects[/:pid]` · `/projects/:pid/{members,documents,activities,baseline,variations,schedule,revisions,reports,requests,purchase-orders,deliveries,issues,stock/adjust,inventory,costs,invoices,bills,cash,cashflow,dashboard,audit,export/excel,export/pdf}` · `/dashboard` · `/alerts` · `/settings` · `/reports/management[/export]` · `/admin/backup`

## 8. Known limitations (honest list)

- Offline data entry/synchronisation is designed for (idempotent keys) but **not implemented**.
- Inventory is tracked per project (no inter-project transfers).
- Payroll is recorded as cash out and as labour cost from reports; there is no payroll calculation module.
- Tax (VAT/withholding) is not modelled; amounts are single-currency.
- Server-side messages (alerts, errors) are English only; UI labels are translated (the Kinyarwanda/French wording should be reviewed by a native construction-industry speaker).
- Single-node SQLite; no built-in high availability.
