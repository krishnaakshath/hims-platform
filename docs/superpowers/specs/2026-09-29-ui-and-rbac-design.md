# Global UI Remodel & RBAC Restructuring Design

## 1. Global UI System (The "Mobbin" Remodel)
**Context:** The current application uses soft UI elements (glassmorphism, `backdrop-blur`, rounded borders, colored shadows) which feel "vibe-coded".
**Goal:** Transition to a strict, professional, high-density utility UI inspired by modern EMRs and platforms (e.g., HubSpot, Heidi Health, Perplexity) pulled from Mobbin design references.

**Visual Constraints & Changes:**
- **Remove:** All `backdrop-blur-*`, soft drop-shadows, excessive border-radius (`rounded-xl`/`2xl`), and gradient background tints.
- **Implement:** Flat design, hard borders (`border-border`), tight semantic padding, and crisp typography.
- **Layouts:** Standardize the Left Navigation panel and Header. Main content areas will use strict CSS grids and dense table designs without enclosing rows in isolated cards.
- **Scope:** This applies globally to all `src/app/(dashboard)/*` pages and `src/components/dashboards/*`.

## 2. RBAC & Workflow Restructuring

### A. Front Desk Role
- **Current State:** Front desk has access to billing and insurance operations.
- **Design Changes:**
  - **Remove Billing:** The front desk will have zero access to billing, collections, or charges.
  - **New Check-in Flow:** Checking a patient in will generate a "Check-in Ticket" (digital/printable token) containing their queue number and appointment details, which is handed to the patient.

### B. Billing Role (New)
- **Current State:** Billing tasks are mixed into CRC/Admin roles and exposed to Front Desk.
- **Design Changes:**
  - **Database Update:** Add `billing` to the `roleEnum` in `src/db/schema.ts`.
  - **Dedicated Dashboard:** A strictly financial workspace.
  - **Visibility:** Has access to registration fees, doctor fees, insurance claims, AR dashboard, and payments.
  - **Hard Restrictions:** The billing role will be explicitly blocked from viewing Messages, Trials, Protocols, Labs, Staff Directory, Settings, and Patient Medical Records.

### C. Doctor (PI) Role
- **Current State:** The dashboard exists but lacks focused daily operational flow.
- **Design Changes:**
  - **Dashboard Redesign:** The Doctor's main dashboard will explicitly surface:
    1. **Today's Checkups:** Patients scheduled or currently checked in today.
    2. **Assigned Patients:** The doctor's active panel.
    3. **Client Forms:** Forms submitted by patients waiting for clinical verification.
    4. **Lab Reports:** Results flagged for review.
  - **Prescription Flow:** Prescriptions written by the doctor will immediately route to the Pharmacy dashboard queue.

### D. Pharmacy Role
- **Current State:** Pharmacy can dispense but lacks communication pathways.
- **Design Changes:**
  - **Scope Limit:** Access is strictly limited to the Medication Catalog ("amount of medics there are") and Patient Lookup (only for prescriptions). They are hard-blocked from viewing full medical records.
  - **Communication:** Introduce a messaging interface allowing Pharmacy to contact Doctors directly for prescription review/clarification.
  - **Fulfillment Sync:** Once Pharmacy dispenses the medication, the record is immediately committed to the database, automatically updating the patient's portal with their active medications.

## 3. Implementation Phasing
1. **Database & Auth Update:** Update `schema.ts`, `role-capabilities.ts`, and navigation gates to support the new `billing` role and front desk restrictions.
2. **Global UI CSS Overhaul:** Rip out glassmorphism classes globally in favor of the new flat UI tokens.
3. **Dashboard-by-Dashboard Refactor:** Rebuild the Admin, Front Desk, Doctor, Billing, and Pharmacy dashboards to match the new Mobbin-inspired grid layouts and specific data requirements.
