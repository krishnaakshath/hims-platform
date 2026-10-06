# Global UI Remodel & RBAC Restructuring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the UI from a soft glassmorphism aesthetic to a strict, high-density utility UI, and restructure RBAC to isolate Billing, restrict Pharmacy and Front Desk, and optimize the Doctor flow.

**Architecture:** We will first update the core domain (database schema and role capabilities) to support the new `billing` role. Then we will tackle each role's dashboard sequentially, applying the new flat UI tokens and enforcing the data/navigation gates. Finally, we will sweep the remaining generic UI components to remove glassmorphism.

**Architecture Diagram:**

```mermaid
graph TD
    subgraph "RBAC Enforcements"
        FD[Front Desk] -->|Check-in Ticket| P[Patient]
        FD -.x|No Access| B[Billing Dashboard]
        
        B -->|Reads| FIN[Financial Data]
        B -.x|No Access| CLIN[Clinical Data / Messages]
        
        DOC[Doctor PI] -->|Writes| RX[Prescriptions]
        DOC -->|Reads| TODAY[Today's Checkups, Labs]
        
        PHARM[Pharmacy] -->|Fulfills| RX
        PHARM -->|Messages| DOC
        PHARM -.x|No Access| CLIN
    end
```

**Tech Stack:** Next.js App Router, Tailwind v4, Drizzle ORM, Neon Postgres

**Spec:** [docs/superpowers/specs/2026-09-29-ui-and-rbac-design.md](file:///Users/k2a/Desktop/clinsync/docs/superpowers/specs/2026-09-29-ui-and-rbac-design.md)

## Global Constraints
- Remove all `backdrop-blur-*`, `bg-card/80`, and extra `rounded-xl` classes globally.
- Front Desk must never see billing links.
- Pharmacy must never see `/patients/[anonId]/medical-record`.
- Billing must never see clinical data (Messages, Labs, Trials, Protocols, Settings).

---

### Task 1: Database & Role Capabilities Update

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/lib/role-capabilities.ts`

**Interfaces:**
- Produces: `billing` role in `roleEnum`.

- [ ] **Step 1: Add `billing` to roleEnum**
In `src/db/schema.ts`:
```diff
-export const roleEnum = pgEnum('role', ['crc', 'pi', 'admin', 'frontdesk', 'pharmacy'])
+export const roleEnum = pgEnum('role', ['crc', 'pi', 'admin', 'frontdesk', 'pharmacy', 'billing'])
```

- [ ] **Step 2: Update Role Capabilities**
In `src/lib/role-capabilities.ts`:
Add the `billing` role definition.
```typescript
  billing: {
    label: 'Billing / Revenue Cycle',
    summary: 'Handles claims, collections, and charges. No clinical access.',
    bullets: [
      'View AR Dashboard',
      'Manage Patient Collections',
      'Manage Insurance Collections',
      'View Charges and Payments'
    ],
  },
```
Also remove billing bullets from `frontdesk`.

- [ ] **Step 3: Update Auth Types**
In `src/lib/auth.ts` (if `Role` is defined as a union type):
```diff
-export type Role = 'crc' | 'pi' | 'admin' | 'frontdesk' | 'pharmacy'
+export type Role = 'crc' | 'pi' | 'admin' | 'frontdesk' | 'pharmacy' | 'billing'
```

- [ ] **Step 4: Commit**
```bash
git add src/db/schema.ts src/lib/role-capabilities.ts src/lib/auth.ts
git commit -m "feat: add billing role and update RBAC definitions"
```

### Task 2: Build Billing Dashboard Layout & Restrict Front Desk

**Files:**
- Modify: `src/components/LeftNav.tsx`
- Modify: `src/components/dashboards/FrontDeskDashboard.tsx`

**Interfaces:**
- Consumes: `billing` role.

- [ ] **Step 1: Update Navigation Gates**
In `src/components/LeftNav.tsx`, ensure the Billing group is only visible to `admin`, `crc`, and `billing`. Remove `frontdesk`.
Ensure clinical groups (Trials, Pipeline, Documents, Labs, Forms, Messages) are NOT visible to `billing`.

- [ ] **Step 2: Flatten LeftNav Design**
In `src/components/LeftNav.tsx`, remove `backdrop-blur-sm` and `bg-card/50`. Use solid background `bg-card` and hard borders `border-r border-border`.

- [ ] **Step 3: Strip Billing from Front Desk Dashboard**
In `src/components/dashboards/FrontDeskDashboard.tsx`, remove the "Billing & Claims" section.

- [ ] **Step 4: Commit**
```bash
git add src/components/LeftNav.tsx src/components/dashboards/FrontDeskDashboard.tsx
git commit -m "feat: enforce billing nav isolation and strip glassmorphism from LeftNav"
```

### Task 3: Front Desk - Check-In Ticket Feature

**Files:**
- Modify: `src/components/CheckInModal.tsx`
- Modify: `src/components/dashboards/FrontDeskDashboard.tsx`

**Interfaces:**
- Produces: Ticket generation on check-in.

- [ ] **Step 1: Flatten Front Desk UI**
In `src/components/dashboards/FrontDeskDashboard.tsx`, replace `rounded-xl border bg-card/80 shadow-sm backdrop-blur-sm` with `rounded-md border bg-card shadow-none`.

- [ ] **Step 2: Add Print Ticket logic to CheckInModal**
In `src/components/CheckInModal.tsx`:
Add a success state that displays the "Check-in Ticket" (Queue Number, Room, Patient Name) and provides a `window.print()` button.

- [ ] **Step 3: Commit**
```bash
git add src/components/CheckInModal.tsx src/components/dashboards/FrontDeskDashboard.tsx
git commit -m "feat: add check-in ticket generation for front desk and flatten UI"
```

### Task 4: Doctor (PI) Dashboard Overhaul

**Files:**
- Modify: `src/components/dashboards/PiDashboard.tsx`
- Modify: `src/app/(dashboard)/doctor/page.tsx`

**Interfaces:**
- Consumes: Doctor assignments.

- [ ] **Step 1: Flatten PI Dashboard UI**
Remove all `backdrop-blur-*` and `bg-*/50` classes in the Doctor dashboard.

- [ ] **Step 2: Add "Today's Checkups" & "Assigned Patients"**
Update the dashboard to fetch and explicitly display patients who have `checkInTime` today, and patients assigned to this `userId`.

- [ ] **Step 3: Add "Client Forms" & "Lab Reports"**
Fetch recent submitted client forms and pending lab results.

- [ ] **Step 4: Commit**
```bash
git add src/components/dashboards/PiDashboard.tsx src/app/(dashboard)/doctor/page.tsx
git commit -m "feat: overhaul doctor dashboard layout for daily workflow"
```

### Task 5: Pharmacy Dashboard & Messaging

**Files:**
- Modify: `src/components/dashboards/PharmacyDashboard.tsx`
- Modify: `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx`

**Interfaces:**
- Consumes: Prescriptions, Messages API.

- [ ] **Step 1: Hard-block Chart Access**
In `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx` or its layout:
Return a generic "Unauthorized" view if session role is pharmacy.

- [ ] **Step 2: Add Messaging to Pharmacy Dashboard**
In `src/components/dashboards/PharmacyDashboard.tsx`:
Add a "Message Doctor" button next to prescriptions.

- [ ] **Step 3: Flatten UI**
Remove glassmorphism from `PharmacyDashboard.tsx`.

- [ ] **Step 4: Commit**
```bash
git add src/components/dashboards/PharmacyDashboard.tsx src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx
git commit -m "feat: restrict pharmacy clinical access and add doctor messaging"
```

### Task 6: Global UI Sweeper

**Files:**
- Modify: `src/components/DashboardHomeClient.tsx`
- Modify: `src/components/TopBanner.tsx`

**Interfaces:**
- Produces: Strict flat utility UI.

- [ ] **Step 1: Rip Glassmorphism**
Remove `backdrop-blur-sm`, `bg-card/80`, `rounded-xl` in favor of flat equivalents (`bg-background`, `bg-card`, `rounded-md`, `border`).

- [ ] **Step 2: Commit**
```bash
git add -u
git commit -m "style: apply mobbin-inspired strict flat utility UI globally"
```
