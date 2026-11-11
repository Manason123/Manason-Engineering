PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','project_manager','engineer','storekeeper','accountant','viewer')),
  lang TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en','rw','fr')),
  active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  client_name TEXT,
  client_contact TEXT,
  location TEXT,
  contract_value REAL NOT NULL CHECK (contract_value >= 0),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','active','on_hold','completed','cancelled')),
  baseline_approved INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'document',
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  report_id INTEGER,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Activities hold the CURRENT (possibly revised) plan. The approved baseline is frozen in baseline_activities.
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  planned_qty REAL NOT NULL CHECK (planned_qty > 0),
  rate REAL NOT NULL DEFAULT 0 CHECK (rate >= 0),        -- BOQ selling rate
  budget_cost REAL NOT NULL DEFAULT 0 CHECK (budget_cost >= 0), -- ORIGINAL cost budget
  planned_start TEXT NOT NULL,
  planned_end TEXT NOT NULL,
  productivity_per_day REAL NOT NULL DEFAULT 0 CHECK (productivity_per_day >= 0),
  UNIQUE (project_id, code)
);

CREATE TABLE IF NOT EXISTS activity_deps (
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  PRIMARY KEY (activity_id, depends_on_id),
  CHECK (activity_id <> depends_on_id)
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  unit TEXT NOT NULL,
  default_price REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  phone TEXT,
  email TEXT
);

-- Planned resource needs per unit of activity quantity
CREATE TABLE IF NOT EXISTS activity_resources (
  id INTEGER PRIMARY KEY,
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('material','labour','equipment')),
  material_id INTEGER REFERENCES materials(id),
  name TEXT,
  unit TEXT NOT NULL,
  qty_per_unit REAL NOT NULL CHECK (qty_per_unit >= 0),
  unit_cost REAL NOT NULL DEFAULT 0 CHECK (unit_cost >= 0)
);

CREATE TABLE IF NOT EXISTS baselines (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT NOT NULL DEFAULT (datetime('now')),
  total_budget REAL NOT NULL,
  contract_value REAL NOT NULL,
  UNIQUE (project_id, version)
);

CREATE TABLE IF NOT EXISTS baseline_activities (
  baseline_id INTEGER NOT NULL REFERENCES baselines(id) ON DELETE CASCADE,
  activity_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  planned_qty REAL NOT NULL,
  budget_cost REAL NOT NULL,
  planned_start TEXT NOT NULL,
  planned_end TEXT NOT NULL,
  PRIMARY KEY (baseline_id, activity_id)
);

-- Budget variations never overwrite the original budget_cost.
CREATE TABLE IF NOT EXISTS budget_variations (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  activity_id INTEGER REFERENCES activities(id),
  cost_amount REAL NOT NULL,          -- change to cost budget (can be negative)
  revenue_amount REAL NOT NULL DEFAULT 0, -- change to contract value agreed with client
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by INTEGER REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schedule_revisions (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  proposal_json TEXT NOT NULL,  -- [{activity_id, old_start, old_end, new_start, new_end}]
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by INTEGER REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Daily reports
CREATE TABLE IF NOT EXISTS daily_reports (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  report_date TEXT NOT NULL,
  weather TEXT,
  delays TEXT,
  problems TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  submitted_by INTEGER REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, report_date)
);
CREATE TABLE IF NOT EXISTS report_lines (
  id INTEGER PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE,
  activity_id INTEGER NOT NULL REFERENCES activities(id),
  planned_qty REAL NOT NULL DEFAULT 0 CHECK (planned_qty >= 0),
  completed_qty REAL NOT NULL DEFAULT 0 CHECK (completed_qty >= 0)
);
CREATE TABLE IF NOT EXISTS report_labour (
  id INTEGER PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE,
  activity_id INTEGER REFERENCES activities(id),
  trade TEXT NOT NULL,
  workers INTEGER NOT NULL CHECK (workers >= 0),
  hours REAL NOT NULL CHECK (hours >= 0),
  hourly_rate REAL NOT NULL DEFAULT 0 CHECK (hourly_rate >= 0)
);
CREATE TABLE IF NOT EXISTS report_materials (
  id INTEGER PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE,
  activity_id INTEGER REFERENCES activities(id),
  material_id INTEGER NOT NULL REFERENCES materials(id),
  qty_consumed REAL NOT NULL DEFAULT 0 CHECK (qty_consumed >= 0),
  qty_wasted REAL NOT NULL DEFAULT 0 CHECK (qty_wasted >= 0)
);
CREATE TABLE IF NOT EXISTS report_equipment (
  id INTEGER PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE,
  activity_id INTEGER REFERENCES activities(id),
  name TEXT NOT NULL,
  hours REAL NOT NULL CHECK (hours >= 0),
  hourly_rate REAL NOT NULL DEFAULT 0 CHECK (hourly_rate >= 0)
);

-- Material requests: every stage keeps its own quantity. Nothing is consumed by requesting.
CREATE TABLE IF NOT EXISTS material_requests (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  activity_id INTEGER REFERENCES activities(id),
  material_id INTEGER NOT NULL REFERENCES materials(id),
  needed_date TEXT NOT NULL,
  qty_requested REAL NOT NULL CHECK (qty_requested > 0),
  qty_approved REAL NOT NULL DEFAULT 0,
  qty_from_stock REAL NOT NULL DEFAULT 0,   -- covered from available store stock
  qty_to_purchase REAL NOT NULL DEFAULT 0,  -- shortfall after stock check
  qty_purchased REAL NOT NULL DEFAULT 0,    -- on purchase orders
  qty_delivered REAL NOT NULL DEFAULT 0,    -- arrived per delivery notes
  qty_received REAL NOT NULL DEFAULT 0,     -- accepted into store
  qty_issued REAL NOT NULL DEFAULT 0,       -- issued from store to site
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','cancelled','closed')),
  stock_at_request REAL NOT NULL DEFAULT 0,
  requested_by INTEGER REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request_id INTEGER REFERENCES material_requests(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  material_id INTEGER NOT NULL REFERENCES materials(id),
  activity_id INTEGER REFERENCES activities(id),
  qty REAL NOT NULL CHECK (qty > 0),
  unit_price REAL NOT NULL CHECK (unit_price >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  delivery_note_no TEXT NOT NULL,
  qty_delivered REAL NOT NULL CHECK (qty_delivered > 0),
  qty_received REAL,                       -- NULL until storekeeper confirms
  status TEXT NOT NULL DEFAULT 'delivered' CHECK (status IN ('delivered','received','cancelled')),
  delivered_date TEXT NOT NULL,
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  UNIQUE (po_id, delivery_note_no)
);

-- Inventory ledger: stock changes ONLY through confirmed rows here.
CREATE TABLE IF NOT EXISTS inventory_txns (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  type TEXT NOT NULL CHECK (type IN ('receive','issue','consume','waste','adjust')),
  qty REAL NOT NULL,                       -- always positive except adjust
  unit_price REAL NOT NULL DEFAULT 0,
  ref_type TEXT,
  ref_id INTEGER,
  request_id INTEGER REFERENCES material_requests(id),
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Accounting costs (accrual). NOT cash. status: estimated | actual | awaiting_approval
CREATE TABLE IF NOT EXISTS cost_entries (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  activity_id INTEGER REFERENCES activities(id),
  category TEXT NOT NULL CHECK (category IN ('material','labour','equipment','subcontract','overhead','other')),
  description TEXT NOT NULL,
  amount REAL NOT NULL,                    -- negative amounts only for reversals
  status TEXT NOT NULL DEFAULT 'actual' CHECK (status IN ('estimated','actual','awaiting_approval','void')),
  entry_date TEXT NOT NULL,
  source_type TEXT,
  source_id INTEGER,
  reverses_id INTEGER REFERENCES cost_entries(id),
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_type, source_id, category)
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','cancelled')),
  created_by INTEGER REFERENCES users(id),
  UNIQUE (project_id, number)
);

CREATE TABLE IF NOT EXISTS supplier_bills (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  bill_no TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  bill_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','cancelled')),
  created_by INTEGER REFERENCES users(id),
  UNIQUE (supplier_id, bill_no)
);

-- Cash movements, separate from costs. Outgoing payments need approval.
CREATE TABLE IF NOT EXISTS cash_transactions (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  kind TEXT NOT NULL CHECK (kind IN ('client_payment','supplier_payment','payroll','expense','correction')),
  amount REAL NOT NULL CHECK (amount > 0),
  txn_date TEXT NOT NULL,
  reference TEXT NOT NULL,
  invoice_id INTEGER REFERENCES invoices(id),
  bill_id INTEGER REFERENCES supplier_bills(id),
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending_approval','approved','rejected','reversed')),
  reverses_id INTEGER REFERENCES cash_transactions(id),
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, kind, reference)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  message TEXT NOT NULL,
  data_json TEXT,
  alert_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  project_id INTEGER,
  reason TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_act_project ON activities(project_id);
CREATE INDEX IF NOT EXISTS idx_cost_project ON cost_entries(project_id, activity_id);
CREATE INDEX IF NOT EXISTS idx_inv_project ON inventory_txns(project_id, material_id);
CREATE INDEX IF NOT EXISTS idx_cash_project ON cash_transactions(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_report_project ON daily_reports(project_id, report_date);

-- People asking for an account. Nothing is usable until an owner/admin approves and picks a role.
CREATE TABLE IF NOT EXISTS access_requests (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_pending_email ON access_requests(lower(email)) WHERE status = 'pending';
