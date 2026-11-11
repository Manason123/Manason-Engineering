# BuildTrack Pro — User Training Guide

Sign in with the email and password given to you. Choose your language (English / Kinyarwanda / Français) at the top; it is remembered. Change your password on first use (ask the owner/admin to reset it if you forget).

**Golden rules** (the system enforces these):
1. *Requested* material is not *received*, *issued* or *consumed*. Each step is recorded separately.
2. A cost is not the same as cash paid. Profit is calculated from costs, never from cash received.
3. The original budget never changes. Extra money is added only through an **approved variation**.
4. Every figure shows a label: **actual**, **estimated**, **forecast** or **awaiting approval**.
5. Nothing important is deleted. Mistakes are corrected with a **reversal** and a reason, and are recorded in the audit log.

## Getting an account
Ask your administrator, or open the sign-in page → **Request access**, fill in your details and wait for approval (you will be able to sign in once an admin approves and assigns you to your projects). Use **My profile** (your name in the top bar) to change your password or language.

## Site Engineer
**Daily report (use your phone)** — Project → *Daily reports* → *New report*.
1. Date (one report per day), weather, delays, problems.
2. *Activities*: for each activity worked on, planned and **completed quantity today**.
3. *Labour*: trade, workers, hours. *Equipment*: name, hours. *Materials*: quantity consumed and wasted (only material already issued to site).
4. Add photos (the camera opens on phones). Press **Save (Draft)** to continue later or **Submit**.
5. If the manager rejects it, read the reason, correct it and submit again.
Progress and costs update only after your manager **approves** the report.

**Request materials** — *Materials* → *Material requests* → *New request*: material, activity, date needed, quantity. The screen tells you how much can come from store stock and how much must be bought. You can cancel until buying/issuing starts.

## Storekeeper
- *Materials → Deliveries*: when goods arrive the purchasing officer records the delivery note; you press **Confirm receipt** and enter the quantity you actually **accepted** (damaged/short goods are not added to stock). Stock and cost update at that moment.
- *Materials → Inventory*: **Issue to site** moves stock from store to site (cannot exceed the store balance or stock reserved for other approved requests). **±** adjusts stock for counts or losses — a reason is mandatory.
- You do not see prices or profit.

## Project Manager
- *Baseline*: enter or **Import BOQ from Excel** (columns Code, Description, Unit, Quantity, Rate; optional Budget, Start, End, Productivity). Add dependencies (+dep) and the material rates per unit of work. When complete press **Approve baseline** — budget and schedule are then frozen for comparison.
- *Daily reports*: **Approve** or **Reject** (reason required). You cannot approve your own report.
- *Materials*: approve/reject requests (you may approve a smaller quantity); create purchase orders (supplier, quantity, price). A purchase order is a **commitment**, not a cost and not cash.
- *Schedule*: the system forecasts finish dates from real progress. **Propose revised schedule** and approve it; the original baseline dates stay on record.
- *Variations*: request extra budget with a reason; the owner decides.
- Overview tab: progress, budget used, forecast final cost, forecast profit, alerts, material shortages.

## Accountant
- *Finance → Costs*: add subcontract/overhead/other costs (materials, labour and equipment post automatically). Use **Reverse** with a reason to correct.
- *Invoices*: raise invoices to the client (cannot exceed contract value). *Bills*: record supplier bills.
- *Cash book*: record client payments (against an invoice), supplier payments (against a bill), payroll, expenses. The **reference must be unique** (bank/receipt number) — duplicates are refused. Outgoing payments wait for the owner’s approval and do not count as paid until approved.
- *Cash flow*: monthly cash in/out versus accounting cost.
- *Export Excel / PDF* from the project header.

## Owner / Admin
- **Dashboard**: all active projects, progress, budget used, forecast final cost, forecast profit and margin, delays, overruns, shortages, cash received/paid, receivables.
- **Approve** budget variations, outgoing payments and awaiting-approval costs (always with a note when rejecting).
- **Users**: approve or reject **access requests** (gold badge), choosing role and projects; create users, set roles, disable accounts (a reason is required). **Projects → Members**: assign people to projects; users see only their projects.
- **Settings**: alert thresholds (budget %, days late, margin %); Backups; global audit log.
- **Reports**: daily / weekly / monthly management report with Excel and PDF export.

## Reading the numbers
| Term | Meaning |
|---|---|
| Original budget | Approved baseline cost budget, never changed |
| Revised budget | Original + approved variations |
| Actual cost | Posted costs: material received, approved labour/equipment, other costs |
| Committed cost | Open purchase orders not yet received (estimated) |
| Remaining budget | Revised − actual − committed |
| Forecast final cost | Actual + expected cost of the remaining work at current unit costs |
| Forecast profit / margin | Contract value (+ approved revenue variations) − forecast final cost |
| Cash received / paid | Money actually moved (approved only) |
| Receivable | Invoiced − received |

## Troubleshooting
- *“Cannot approve: … exceeds quantity issued to site”* — the report consumes more material than the storekeeper issued. Issue stock, or correct the report.
- *“Duplicate …”* — the same reference/note/number was already recorded; check before re-entering.
- *“Baseline is approved”* — use a variation (money) or a schedule revision (dates).
- *Account locked* — wait 15 minutes or ask the admin.
