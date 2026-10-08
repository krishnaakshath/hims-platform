import type { Role } from '@/lib/auth'

/**
 * Sourced only from role-gated behavior that actually exists in the code
 * today (auto-classify toggle, practice info, and provider name edits are
 * all admin-only — see settings/page.tsx and its API routes). Not
 * aspirational, doesn't describe a permission the app doesn't enforce.
 */
export const ROLE_CAPABILITIES: Record<Role, { label: string; summary: string; bullets: string[] }> = {
  crc: {
    label: 'Clinical Research Coordinator',
    summary: 'Runs day-to-day pre-screening and practice operations: reviews patients, manages intake forms, and handles billing.',
    bullets: [
      'View and search the Patients workbook across all trials',
      'Send and track intake forms via Form Templates and Client Forms',
      'Manage Calendar, Billing, Broadcasts, Experience Surveys, and the Pipeline Dashboard',
      'View Reports and Documents, and receive, file, and re-file incoming documents to a patient',
      'View and manage the live bed/ward status board, including marking rooms clean',
      'View the Lab worklist across all patients',
      'View the Staff Directory and credential expiry status',
      'Confirm or decline public booking requests into real appointments',
      'Confirm a green trial-eligibility verdict, which automatically notifies the patient',
      'Log and manage a trial\'s adverse events, drug accountability entries, and regulatory binder documents',
      'Transfer an admitted patient between rooms',
      'Record or update a patient\'s Aadhaar with consent, seeing only its last 4 digits',
      'Look up the current price of a service',
      'View follow-ups and the follow-up recall list (read-only)',
      // SP4
      'Capture charges and build invoices',
      // end SP4
      // Wave F
      'View the OPD register and export it as CSV',
      'Print discharge summaries and prescription slips',
      // end Wave F
      // SP7
      'Pick an approved pre-authorisation when capturing a charge billed to an insurer',
      // end SP7
    ],
  },
  pi: {
    label: 'Principal Investigator',
    summary: 'A focused, clinical-only view for making eligibility calls from the evidence the system surfaces — practice operations (billing, forms administration, broadcasts, reports) are the coordinator\'s and admin\'s tools, not shown here.',
    bullets: [
      'View "My Patients" — the panel of patients currently assigned to them',
      'Review screening evidence to confirm or overturn an eligibility verdict',
      'View the Patients workbook, Trials & Protocols, and Calendar',
      'Review a patient\'s actual submitted answers in Client Forms',
      'View and download filed documents (read-only -- receiving and filing is a coordinator/front-desk action)',
      'Message patients directly',
      'View the live bed/ward status board',
      'Dispense medications from the Pharmacy dashboard',
      // SP5: pi no longer enters results (labs enters, pi verifies).
      'Order lab tests and manage the Lab worklist: mark samples collected, attach imaging results, and cancel orders',
      'View the Staff Directory and credential expiry status',
      'View the public booking requests queue (read-only -- confirming/declining is a registration-staff action)',
      'Confirm a green trial-eligibility verdict, which automatically notifies the patient',
      'Log and manage a trial\'s adverse events, drug accountability entries, and regulatory binder documents',
      'Write and sign encounter notes (SOAP) on a patient\'s chart',
      'Create and manage care plans and care-plan goals',
      'Order inpatient medications and record administrations on the MAR',
      'Transfer an admitted patient between rooms',
      'Discharge an admitted patient and sign the discharge summary',
      'Set and change a patient\'s follow-up plan (due date or interval, window, reason and plan notes), and start or complete a visit',
      // SP5
      'Order several lab tests at once and ask for a follow-up visit once the report is released',
      'Verify lab results before they are reported to the patient',
      // SP6
      'Propose diagnosis and procedure codes for a visit on the chart, and answer coding queries',
      // Wave F
      'View the OPD register (no export)',
      'Print discharge summaries and prescription slips with their NMC/SMC registration number',
      // end Wave F
    ],
  },
  admin: {
    label: 'Administrator',
    summary: 'Full operational access plus practice-level configuration that affects every user.',
    bullets: [
      'Everything a Research Coordinator can do',
      'Edit Practice Information',
      'Toggle auto-classification on form completion',
      'Rename entries in the Provider Profiles roster',
      'Issue and revoke Patient Portal access credentials',
      'View and manage the live bed/ward status board, including blocking and unblocking rooms',
      'Dispense medications from the Pharmacy dashboard',
      'Order lab tests and manage the Lab worklist: mark samples collected, attach imaging results, enter results, and cancel orders',
      'Add and edit staff members and credentials in the Staff Directory',
      'Confirm or decline public booking requests into real appointments',
      'Permanently delete a received document',
      'Look up a patient at the pharmacy counter, dispense, and log a dispense bill.',
      'Confirm a green trial-eligibility verdict, which automatically notifies the patient',
      'Log and manage a trial\'s adverse events, drug accountability entries, and regulatory binder documents',
      'Register a new patient',
      'Write and sign encounter notes (SOAP) on a patient\'s chart',
      'Create and manage care plans and care-plan goals',
      'Order inpatient medications and record administrations on the MAR',
      'Transfer an admitted patient between rooms',
      'Discharge an admitted patient and sign the discharge summary',
      'Set and change a patient\'s follow-up plan (due date or interval, window, reason and plan notes), and start or complete a visit',
      'Book, reschedule or cancel follow-up appointments and log patient contact attempts from the follow-up recall list',
      'Manage the department master and the UHID prefix',
      'Manage the service catalogue, tariffs, packages and room categories, including CSV tariff import',
      // SP4
      'Configure billing rules and GST settings',
      // end SP4
      // SP5
      'Book and dispatch home sample collection visits and assign collectors',
      'Receive samples by sample ID, enter results and release lab reports',
      'Order several lab tests at once and ask for a follow-up visit once the report is released',
      'Verify lab results before they are reported to the patient',
      'Manage the home-collection service area, collection windows and lab test sample setup',
      // SP6
      'Load licensed code sets (ICD-10, ICD-10-PCS, SNOMED CT, LOINC, HBP packages) and choose the current version',
      'Assign coding work to a coder',
      'Correct a patient\'s name or date of birth after registration (with a recorded reason), and clear a medico-legal (MLC) flag',
      // Wave F
      'View the OPD register (every visit by date, department, doctor and status) and export it as CSV',
      'Print discharge summaries and Indian prescription slips',
      // end Wave F
      // SP7
      'Approve or reject claim write-offs',
      'Set the hospital ROHINI and HFR identifiers',
      // end SP7
    ],
  },
  frontdesk: {
    label: 'Front Desk / Reception',
    summary: 'Owns patient registration and check-in, for both inpatient and outpatient visits -- rooming and doctor assignment, not the clinical evidence-review, lab, or insurance tools used by other roles (insurance is billing\'s domain end-to-end).',
    bullets: [
      'Register a new patient -- inpatient and outpatient -- exclusively',
      'Check patients in and assign rooms',
      'Route patients to a provider for inpatient or outpatient visits',
      'Receive, file, and re-file incoming documents (including insurance cards, EOBs, and authorizations) to a patient',
      'View and manage the live bed/ward status board',
      'Confirm or decline public booking requests into real appointments',
      'Transfer an admitted patient between rooms',
      'Record a patient\'s Aadhaar with consent or the reason it was declined (the number is never shown back)',
      'Look up the current price of a service',
      'View every follow-up and work the follow-up recall list: book, reschedule or cancel the follow-up appointment and log contact attempts (the clinical plan stays with the doctor)',
      'Check a patient in against a booked follow-up appointment, which issues the OPD token',
      // SP4
      'Take advances and receipts at the cash desk',
      // end SP4
      // SP5
      'Book, reschedule or cancel a home sample collection for a patient in the service area',
      'Find a patient by name, UHID, mobile number or chart ID, and print the OPD token slip and the registration slip / UHID card',
      // Wave F
      'View the OPD register (no export)',
      'Print the administrative copy of a discharge summary (no clinical details)',
      // end Wave F
      // SP7
      'Record a patient\'s insurance policy and card at registration or admission',
      // end SP7
    ],
  },
  pharmacy: {
    label: 'Pharmacy',
    summary: 'Works the dispensing counter: looks a patient up by ID, reads what their doctor prescribed, dispenses from practice stock, and logs the bill — never prescribes, never edits a prescription, and never approves a charge.',
    bullets: [
      'Look up any patient by name, UHID, mobile number or chart ID to see their prescribed medications',
      'View a patient\'s active medication episodes as the prescriber entered them (read-only)',
      'Dispense a medication from practice stock against a specific prescription',
      'Log a bill for a dispense as a draft charge for the billing team to review',
      'View the medication catalog, stock levels, and what the practice is currently prescribing',
      'Add a medication to the practice catalog',
    ],
  },
  billing: {
    label: 'Billing / Revenue Cycle',
    summary: 'Handles claims, collections, charges, and insurance verification end-to-end. No clinical access.',
    bullets: [
      'View AR Dashboard',
      'Manage Patient Collections',
      'Manage Insurance Collections',
      'Verify patient insurance eligibility',
      'View Charges and Payments',
      'Manage the service catalogue, tariffs, packages and room categories, including CSV tariff import',
      // SP4
      'Capture charges and build invoices',
      'Override prices, finalise and cancel invoices, issue refunds',
      // end SP4
      // SP7
      'Pick an approved pre-authorisation when capturing a charge billed to an insurer',
      // end SP7
    ],
  },
  labs: {
    label: 'Laboratory',
    summary: 'Runs the lab bench: works the collection-to-result pipeline for every ordered test, but never orders a test or cancels one — that stays a clinical (PI/Admin) decision.',
    bullets: [
      'View the Lab worklist across all patients',
      'Mark an ordered sample as collected',
      'Enter results and flag them normal, abnormal, or critical',
      'Attach imaging results to an order',
      'View lab results and imaging for every ordered test from the Lab worklist (no chart access)',
      // SP5
      'Book and dispatch home sample collection visits and assign collectors',
      'Receive samples by sample ID, enter results and release lab reports',
    ],
  },
  // SP5
  collector: {
    label: 'Home Sample Collector',
    summary: 'Visits patients at home to collect lab samples on the visits assigned to them.',
    bullets: [
      "See today's assigned home-collection visits: patient, phone, address and the tubes to collect",
      'Mark a visit collected by entering each tube\'s sample ID, or record why it could not be collected',
    ],
  },
  // end SP5
  // SP6
  coder: {
    label: 'Clinical Coder',
    summary: 'Codes finished visits and discharges: assigns ICD-10 diagnosis and procedure/package codes, queries the treating doctor, and finalises coding for billing and claims. Sees only what coding needs; never edits clinical notes and has no chart or patient-directory access.',
    bullets: [
      'Work the coding worklist: claim finished visits and discharges awaiting coding',
      'Assign and correct diagnosis codes (primary, secondary, provisional) and procedure or package codes from the loaded code sets',
      'Read the signed clinical notes of the visit being coded (read-only)',
      'Send a coding query to the treating doctor and log the replies',
      'Mark a visit coded, finalise it, or reopen a finalised visit with a reason',
      'Map service-catalogue procedures and packages to procedure codes',
      'View the coding productivity and backlog report',
    ],
  },
  // end SP6
  // SP7
  rcm: {
    label: 'Revenue Cycle (Insurance Desk)',
    summary: 'Runs cashless insurance: keeps insurer and TPA details, records patient policies, requests pre-authorisations, builds claims from finalised bills, keeps the hospital copy of every submission, and records what the insurer decides and pays. Sees only what claims need.',
    bullets: [
      'Maintain insurers and TPAs: empanelment, contacts, submission channel, turnaround times and required documents',
      'Record patient policies and policy cards',
      'Request pre-authorisations with an estimate, and record queries, approvals, enhancements and rejections',
      'Build claims from finalised bills with coded diagnoses and procedures, and check them for missing documents',
      'Submit a claim: the hospital copy is kept and fingerprinted, and the insurer copy is generated and its dispatch recorded',
      'Record insurer portal updates: queries, approvals, deductions, rejections, appeals and settlements with TDS',
      'Reconcile settlements with the bank and request write-offs',
      'View the RCM dashboard, worklists, ageing and denial reports',
    ],
  },
  // end SP7
}
