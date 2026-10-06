# How EHR / Health-IT Actually Works in the US — Regulatory & Standards Landscape

**Status:** research digest, current as of September 2026, four parallel research passes with cited
sources. Written because the client is US-based and every buildable item in
`docs/product-review-and-gap-analysis.md` needs to be scoped against real US rules, not assumed
best practice.

**Read this first:** Clinsync is not a general EHR. It's a **clinical-trial pre-screening and
identity-reconciliation tool** for a research pilot (IPMG), being measured against a general
EHR blueprint (Tebra+IntakeQ) it was never trying to be. That distinction turns out to matter a
lot — Part D below is where "how a real EHR works" and "how a real clinical-trial system works"
diverge, and several of the earlier gap-analysis doc's roadmap items need to be re-scoped in
light of it (see Part E).

---

## Part A — HIPAA: the floor everything else sits on

### A1. Privacy Rule (45 CFR §160, §164 Subpart E)
- **Minimum necessary standard** — limit PHI use/disclosure to what's needed for the purpose.
  Does **not** apply to a patient accessing their own record. Clinsync's role-based access
  (PI scoped to "My Patients"; admin/CRC seeing every patient) is exactly this standard —
  and the existing gap-analysis doc already correctly flags admin/CRC as *not* minimum-necessary
  scoped today.
- **Right of Access** — patients get a copy of their PHI within **30 days** (one extension
  allowed with written explanation), in the format requested if reasonably producible, at a
  cost-based fee disclosed in advance. Clinsync's portal shows records in-page; there's no
  export/download path today — that's a real gap this rule creates, independent of the
  gap-analysis doc's own list.
- **Right to request restriction/amendment, accounting of disclosures** — providers aren't
  always obligated to agree to a restriction, except: anything paid out-of-pocket in full must
  be restricted from insurer disclosure if the patient asks.
- **Notice of Privacy Practices (NPP)** — plain-language, describes permitted uses/disclosures
  and patient rights, must be given at first encounter, posted publicly (including on any
  website), with good-faith effort to get written acknowledgment.
  [HHS: Right of Access](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/access/index.html)

### A2. Security Rule (45 CFR §164.312) — current rule, and a pending rewrite
Current rule, three safeguard categories; the technical ones:
- **Access Control** — unique user ID and emergency access are **required**; automatic logoff
  and encryption are currently **addressable** (do it, use an equivalent, or document why not).
- **Audit Controls, Integrity, Person/Entity Authentication, Transmission Security.**
  [HHS Technical Safeguards guide (PDF)](https://www.hhs.gov/sites/default/files/ocr/privacy/hipaa/administrative/securityrule/techsafeguards.pdf)

**Not yet final — watch this:** a 2025 NPRM (comments closed March 2025) would remove the
required/addressable split entirely, make **MFA and encryption-at-rest/in-transit mandatory**
with only narrow exceptions. As of September 2026 it's **still not finalized** — a May 2026
target slipped, OMB's Unified Agenda now shows **July 2027**. Practical read for Clinsync: the
MFA work already underway (`docs/superpowers/specs/2026-09-23-patient-portal-security-mfa-design.md`)
is ahead of a real, credible compliance deadline, not solving a hypothetical problem.
[Accountable: NPRM explainer](https://www.accountablehq.com/post/hipaa-security-rule-nprm-explained-what-s-changing-and-how-to-prepare)

### A3. Breach Notification Rule
- Individual notice: within **60 days** of discovery.
- HHS OCR: **500+ affected** → notify within 60 days (same as individuals). **Under 500** →
  still required, but only **annually**.
- Media notice: required only when **500+ residents of one state/jurisdiction** are affected —
  counted by residence, per state, so a breach spread thin across many states can dodge this.
  [HHS: Breach Notification Rule](https://www.hhs.gov/hipaa/for-professionals/breach-notification/index.html)

A real breach runbook depends on being able to quickly determine affected-individual count and
state of residence, and a trustworthy discovery-date timestamp — both lean on the audit log
being complete, which the gap-analysis doc already noted is a genuine strength here.

### A4. HITECH — penalties and BAAs (with this project's actual stack priced out)
Penalty tiers run from ~$145 to **$2.19M per violation category per year** at the top
(willful neglect, uncorrected), inflation-adjusted annually.
[HIPAA Journal: penalty tiers](https://www.hipaajournal.com/what-are-the-penalties-for-hipaa-violations-7096/)

BAAs are required with every subcontractor touching PHI, **including downstream ones** — a
business associate's own cloud host needs its own BAA. Checked against this repo's actual stack:
- **Vercel**: BAA is self-serve on **Pro plans**, no Enterprise contract needed, **$350/month**
  add-on, signed from the dashboard.
  [Vercel: HIPAA BAAs for Pro teams](https://vercel.com/changelog/hipaa-baas-are-now-available-to-pro-teams)
- **Neon** (this project's Postgres): HIPAA/BAA support on the **Scale plan**, **no additional
  cost**, audited for HIPAA/SOC 2/ISO 27001/27701/GDPR/CCPA.
  [Neon: HIPAA compliance](https://neon.com/docs/security/hipaa)
- Neither BAA makes the *application* compliant by itself — both are explicit shared-
  responsibility arrangements. This matches the gap-analysis doc's "BAAs — a legal/business
  action, not something to build" line, just with real prices attached now.
- **Tebra and IntakeQ** each need their own signed BAA the moment real (non-mock) API
  credentials exist — a prerequisite gate for `ehr-sync.ts` going live, not an implementation
  detail to handle later.

### A5. 42 CFR Part 2 — substance use disorder records
Applies only to a program that **holds itself out** as providing SUD diagnosis/treatment/
referral (or has an identified unit doing so) — a psychiatric trial site isn't automatically in
scope just because a trial condition (MDD, ADHD) sometimes co-occurs with SUD. Worth a direct
legal check for IPMG's actual site structure rather than assuming either way.

The **2024 Final Rule is now in force** (compliance required by Feb 16, 2026) and substantially
harmonized Part 2 with HIPAA: single consent covering all future treatment/payment/operations
use (replacing per-disclosure consent), HIPAA breach notification now applies, penalties aligned
with HIPAA. What's **still stricter** than plain HIPAA: non-HIPAA-covered recipients of Part 2
data still need patient consent — HIPAA's routine-TPO exception doesn't extend to them.
[HHS: Part 2 overview](https://www.hhs.gov/hipaa/part-2/index.html)

### A6. State law can be stricter than HIPAA
HIPAA is a floor, not a ceiling. Two concrete examples: **California's CMIA** requires breach
notice within 15 days (not 60) and written authorization for most disclosures beyond standard
treatment/payment/operations; **Texas HB 300** requires electronic records within 15 business
days where feasible and a separate state AG breach-notice trigger at 250+ affected Texas
residents (below HIPAA's 500). Engineering implication: any hardcoded "30 days"/"60 days"
deadline in workflow logic should be a configurable-per-jurisdiction value the moment Clinsync
serves patients from a stricter state, not a literal constant.
[HIPAA Journal: Texas HB 300](https://www.hipaajournal.com/what-is-texas-hb-300/)

---

## Part B — Interoperability, certification, and the standards a US EHR speaks

### B1. HL7 FHIR / US Core
Production standard is **FHIR R4**, constrained for US use by the **US Core Implementation
Guide**, currently **v9.0.0** (v10.0.0 in ballot). This is what ONC certification and
patient/provider-access APIs are built on.
[US Core IG v9](https://hl7.org/fhir/us/core/STU9/)

### B2. USCDI — genuinely in flux
**USCDI v3 is the current mandatory certification baseline** (via the HTI-1 rule, effective Jan
1 2026). Separately, **v7 was published in July 2026** (voluntary) and **v5 has been available
for early voluntary adoption since Aug 2025**. Nothing past v3 is actually *required* yet.
[ONC Standards Bulletin 2026-1](https://healthit.gov/standards-and-technology/onc-standards-bulletin/onc-standards-bulletin-2026-1/)

### B3. C-CDA
Document-based exchange (discharge summaries, referrals, transitions of care) — a different tool
from FHIR's live API access, not a competing one. Both are still used industry-wide for
different purposes; a product doesn't need to pick one over the other.

### B4. ONC Certification (CEHRT) — actively being *deregulated*, not expanded
The most important finding in this section: **HTI-2's proposed rule was largely withdrawn on
Dec 29, 2025.** Only its privacy/security and TEFCA-exception pieces survived (effective Jan 15,
2025); the parts that would have required USCDI v4 and sunset USCDI v3 were pulled. ASTP/ONC
(ONC has been folded into "ASTP" — Assistant Secretary for Technology Policy) is now pursuing a
lighter-touch **"FHIR Forward"** agenda via a new **HTI-5** proposed rule, explicitly framed in
trade press as a deregulatory pivot.
[AHA: ASTP/ONC withdraws HTI-2](https://www.aha.org/news/headline/2025-12-23-atsponc-proposes-deregulatory-actions-withdraws-hti-2-proposals)

**Why certification matters commercially, not just legally:** it's the gate for **MIPS
Promoting Interoperability**, worth **25% of a Traditional MIPS score in 2026**. To claim that
category at all, a practice's EHR must hold ONC certification (45 CFR §170.315) in place for the
full performance period, and the practice must submit a **CMS EHR Certification ID from the
CHPL** with their MIPS filing — a hard gate. A US client asking "is this certified" isn't asking
a compliance-theater question; certification status directly gates their Medicare payment
adjustment. [2026 PI Quick Start Guide (PDF)](https://qpp-cm-prod-content.s3.amazonaws.com/uploads/3599/2026-Promoting-Interoperability-Quick-Start-Guide.pdf)

### B5. Information blocking (Cures Act Final Rule)
Still in force. Eight exceptions unchanged: Preventing Harm, Privacy, Security, Infeasibility,
Health IT Performance, Content & Manner, Fees, Licensing. Applies to "actors" — providers,
certified-health-IT developers, HINs/HIEs. A non-certified, pilot-stage tool used internally by
one practice is lower-risk than a certified vendor selling broadly, but the *provider* using it
is still bound by the general non-interference obligation for their own patients' EHI. The
Privacy and Security exceptions are the two most relevant here — they permit withholding access
only when it's a documented, reasonable, necessary practice, not an open-ended excuse.
[ONC: Cures Act Final Rule](https://healthit.gov/regulations/cures-act-final-rule/)

### B6. CMS Interoperability and Patient Access Final Rule — payer-side, not provider-side
Obligates Medicaid/CHIP FFS and managed-care payers to expose Patient Access, Provider Access,
Payer-to-Payer, and Provider Directory APIs — operational provisions begin **Jan 1 2026**, full
build-out required by **Jan 1 2027**. Doesn't directly bind Clinsync, but it's exactly the kind
of API the gap-analysis doc's flagged "real-time insurance eligibility check" gap would
eventually consume. [CMS fact sheet](https://www.cms.gov/newsroom/fact-sheets/cms-interoperability-prior-authorization-final-rule-cms-0057-f)

### B7. TEFCA / QHINs
Real and accelerating — **11 designated QHINs**, 10,600+ organizations live, 71,000+
participating sites as of late 2025. Still voluntary. For a pilot-stage tool: **not a near-term
requirement** — this is a large-health-system concern, not something to build toward yet.

### B8. Core terminologies (stable)
**ICD-10-CM** (diagnoses, still mandatory, no real US ICD-11 date before 2028–2030+) · **CPT/
HCPCS** (procedure billing codes) · **SNOMED CT** (clinical concepts, richer than ICD-10-CM,
what USCDI expects "Problems" to be coded in) · **LOINC** (lab/observation identifiers) ·
**RxNorm** (normalized medication naming — directly relevant, since Clinsync's
`medicationEpisodes` currently stores free-text names/classes from two dual-sourced systems with
no shared vocabulary layer).

---

## Part C — Billing, claims, e-prescribing: the practice-management side

### C1. X12 EDI transactions (the backbone, current version 5010)
| Transaction | Purpose |
|---|---|
| 837P/I/D | Claim submission (Professional/Institutional/Dental) |
| 835 | Electronic remittance advice — what was paid/denied and why |
| 270/271 | Eligibility inquiry/response |
| 276/277 | Claim status inquiry/response |
| 278 | Prior authorization |

### C2. Clearinghouses — more achievable than the earlier gap-analysis doc assumed
Almost no small/mid practice connects directly to payers — they go through a clearinghouse
(Availity, Change Healthcare/Optum, Waystar, Office Ally). Concretely:
- **Integration timeline**: 2–4 weeks via API/EHR connector, validated against ~100 sample
  claims for a 98% first-pass rate before going live.
- **Cost**: Availity Essentials is free for participating-payer transactions; Office Ally has a
  free tier; Waystar mid-sized-group pricing runs roughly $200–800/month.
- The industry is actively moving toward **API-based** exchange, not just SFTP/batch.

**This changes the framing from the original gap-analysis doc.** Real eligibility checks and
real claim submission are a **business step (clearinghouse account + credentials) plus a
bounded, several-weeks engineering project** against Clinsync's existing `charges`/
`insuranceClaims` model — not the same category of "out of reach" as e-prescribing.
[Top clearinghouses 2026](https://oneosevenrcm.com/top-10-clearinghouses-in-medical-billing/)

### C3. E-prescribing: NCPDP SCRIPT + Surescripts — genuinely out of reach for pure engineering
NCPDP SCRIPT is the US e-prescribing standard (mid-migration from 2017071 to 2023011, full
transition expected before 2028); **Surescripts** is the dominant network. Becoming a
Surescripts-certified participant is reported as a **12–18 month process costing hundreds of
thousands of dollars**; even a scoped conformance cycle (SCRIPT/RTPB/CancelRx) runs 8–16 weeks
of formal testing. This confirms the original gap-analysis doc's framing — e-prescribing is not
a code problem.

### C4. EPCS (controlled substances) — a *stricter*, separate MFA requirement
Governed by **21 CFR §1311**, and meaningfully stricter than generic login MFA:
- **§1311.115**: requires **two of three factors** (knowledge/possession/biometric) at the
  moment of **signing each individual controlled-substance prescription** — a per-prescription
  signing event, not a per-session login.
- **§1311.110**: identity proofing before issuing an EPCS credential must meet **NIST SP
  800-63-1 Assurance Level 3**, via a Credential Service Provider, in-person or remote with
  government-ID verification.
- EPCS-capable software itself needs **third-party audit/certification** — no self-attestation.
- A growing number of states now **mandate** EPCS for controlled-substance prescribing.

**Important for the MFA work already in progress:** the generic TOTP-at-login MFA being spec'd
does **not** satisfy EPCS's per-prescription signing requirement. If e-prescribing is ever
built, EPCS signing MFA is its own dedicated feature, not a byproduct of the login MFA project.
[21 CFR Part 1311](https://www.ecfr.gov/current/title-21/chapter-II/part-1311)

### C5. CPOE for labs/imaging
**HL7v2 ORM/ORU** messages are the standard bidirectional lab interface (order out, result back)
— LOINC codes standardize *what test* was ordered, DICOM standardizes imaging data. Real lab
connectivity (e.g., LabCorp/Quest) is typically brokered through a dedicated HL7 interface
engine (Mirth/NextGen Connect-class tooling), a distinct integration project from FHIR/USCDI
work — the traditional, still-dominant way lab connectivity is done industry-wide.

### C6. MIPS / Promoting Interoperability, 2026 performance year
25% of Traditional MIPS score; requires CEHRT certified for the full performance period, a CMS
EHR Certification ID from the CHPL submitted with the filing, 180+ continuous days of data
collection. The resulting score drives a real Medicare payment adjustment — the concrete
financial reason a US practice client would ever ask about certification.

---

## Part D — Clinical trials specifically (the part that actually applies to Clinsync)

This is the section that should most directly reshape the roadmap, because Clinsync is a trial
pre-screening tool, not a general EHR, and several rules here are meaningfully different from
— and stricter than — the general-EHR rules in Parts A–C.

### D1. 21 CFR Part 11 — electronic records/signatures for FDA-regulated data
Trial screening/eligibility data is FDA-regulated data. Part 11 requires:
- **Audit trails** that are secure, computer-generated, time-stamped, automatic, and
  **tamper-evident to everyone including admins** — capturing who/what/when and old-vs-new
  values.
- **Signature-to-record binding** — an e-signature must be system-bound to the *exact version*
  of the record it signs, not a detachable image or a boolean flag.
- **System validation** — the FDA's Sept 2025 Computer Software Assurance (CSA) guidance moved
  this to a risk-based approach, replacing the older GPSV framework.
- **Unique-login access control** — the most consistently FDA-enforced provision in practice.

**This is the single most consequential finding for the roadmap.** A generic UETA/ESIGN
checkbox-plus-signature-image flow — what most SaaS products mean by "e-signature" — does **not**
meet Part 11. Clinsync's existing `auditLog` table is a reasonable start but is not itself the
signature-binding mechanism Part 11 requires; "e-signature capture" as a roadmap item needs to
be scoped as a Part 11-aware feature from the start, not retrofitted later.
[eCFR Part 11](https://www.ecfr.gov/current/title-21/chapter-I/subchapter-A/part-11)

### D2. ICH E6(R3) Good Clinical Practice / ALCOA++ — current, not draft
**E6(R3) is finalized and live now** — finalized Jan 2025, FDA issued final US guidance Sept
2025. Source data must be **ALCOA+** (Attributable, Legible, Contemporaneous, Original,
Accurate + Complete, Consistent, Enduring, Available), and R3 extends this to **ALCOA++** by
adding **Traceable**, explicitly covering metadata and audit trails, not just the record.
Practical implication: **no silent overwrites of trial data anywhere in the system** — every
change needs a real audit trail, which is directly relevant to how a future "questionnaire
auto-scoring" feature stores both the raw answers and the computed score, and to how any future
edit to a patient's screening data is recorded.
[FDA final US guidance / IntuitionLabs summary](https://intuitionlabs.ai/articles/ich-e6-r3-gcp-guidelines-2026)

### D3. Three legally distinct consent documents — corrects the original gap-analysis framing
This is the clearest, most actionable finding of the whole research pass. The earlier
gap-analysis doc's "e-signatures + ToS/NPP acceptance flow" item bundles together three things
that are **legally separate documents with separate governing rules**:

1. **Trial informed consent** (21 CFR Part 50 / 45 CFR 46 Common Rule) — a subject's right to
   know about and agree to research participation: risks, procedures, voluntariness, right to
   withdraw. Governed by FDA/OHRP, enforced through **IRB approval**.
2. **HIPAA research authorization** (45 CFR §164.508) — a separate document governing use/
   disclosure of PHI specifically for the study. HHS explicitly permits **combining** this with
   (1) into one signed document/workflow — but it must still exist as its own compliant artifact,
   not be implied by (1).
3. **NPP acknowledgment** — general, portal-account-level, not research-specific at all. Nothing
   about research participation.

**What this means concretely:** Clinsync needs three distinct, separately versioned consent
records (or two, if (1)+(2) are combined per HHS guidance) — not one generic "consent = true"
checkbox. [HHS: Research Uses and Disclosures](https://www.hhs.gov/hipaa/for-professionals/faq/research-uses-and-disclosures/index.html)

### D4. IRB oversight and consent-form versioning
IRB approval is required before any consent-form text change takes effect. FDA audit guidance
states plainly: **"using outdated forms or collecting signatures on unapproved versions is one
of the most common FDA audit findings."** Concrete engineering requirement: any consent/
e-signature feature must record **which exact IRB-approved version of the text** a given patient
signed — not just that they signed something.
[FDA Informed Consent Guidance for IRBs (PDF)](https://www.fda.gov/media/88915/download)

### D5. ClinicalTrials.gov registration (FDAAA 801)
A sponsor/PI-level obligation tied to the trial protocol itself — not something a pre-screening
tool operationally touches. Context only; no build requirement follows.

### D6. EDC systems / CDISC (SDTM, CDASH) — clarifies what Clinsync actually is
A real EDC system (Medidata Rave, REDCap, Veeva) captures **on-study** case report form data
validated against CDISC SDTM/CDASH, feeding FDA submissions. **Clinsync is not this** — it's
**pre-EDC**: identity reconciliation, eligibility pre-screening, inclusion/exclusion
classification *before* enrollment. It doesn't need CDISC conformance (that's the eventual real
EDC/CTMS system's job once someone is actually enrolled) — but its pre-screening decisions
(auto-scored rating scales, exclusion-criteria verdicts) are exactly the kind of data an IRB or
sponsor would expect the same ALCOA++ traceability on, since they gate who *enters* the trial in
the first place.

### D7. Rating-scale licensing — directly actionable for the questionnaire auto-scoring item
- **PHQ-9 and GAD-7**: copyright Pfizer, but Pfizer's explicit public policy is that **no
  permission is required** to reproduce, translate, display, or distribute — free for clinical
  *and commercial* use with attribution. No licensing blocker.
  [Pfizer press release](https://www.pfizer.com/news/press-release/press-release-detail/pfizer_to_offer_free_public_access_to_mental_health_assessment_tools_to_improve_diagnosis_and_patient_care)
- **ASRS v1.1**: copyright **World Health Organization**, **not public domain**. Free for
  clinical/research use, but reproducing full item text in a commercial product may need WHO
  acknowledgment/permission — verify current terms against Harvard's ASRS distribution page
  before shipping ASRS auto-scoring commercially. This is a real, if likely minor/
  administrative, step the other two scales don't require.
- Engineering note that applies to all three: correct auto-scoring requires modeling each
  scale's **reverse-scored items** (where present), **subscale groupings**, and **validated
  cutoff thresholds** as scale-specific metadata — never a generic "sum the answers" function,
  since scoring rules differ per instrument.

---

## Part E — What this changes about the roadmap

Direct implications for the 8-item buildable-now decomposition from
`docs/product-review-and-gap-analysis.md`:

1. **Patient-portal security (MFA + auto-logoff)** — already in progress
   (`docs/superpowers/specs/2026-09-23-patient-portal-security-mfa-design.md`). Confirmed
   good timing: ahead of the pending (not-yet-final, ~2027) HIPAA Security Rule rewrite that
   would make MFA mandatory. No change needed from this research.

2. **Questionnaire auto-scoring** — PHQ-9/GAD-7 have no licensing blocker; ASRS needs a WHO
   terms check before commercial use. Scoring logic must be modeled per-scale (reverse-scored
   items, subscales, validated cutoffs), never a generic sum. Given ALCOA++ traceability
   expectations (D2), store the raw answers *and* the computed score, never overwrite one with
   the other.

3. **Scheduled appointment reminders** — no new regulatory finding; general TCPA/consent-for-
   automated-contact rules apply (not researched in depth here — flag if this becomes the
   next sub-project, since SMS reminders specifically implicate TCPA consent, separate from
   HIPAA).

4. **Public self-service booking widget** — no clinical-trial-specific issue; general web
   product concern.

5. **e-Signature capture — needs to be rescoped, not just built.** The original framing ("the
   mechanism — capture, hash, audit trail") undersells what's actually needed. Per D1+D3+D4:
   this isn't one generic e-signature feature, it's (a) a Part 11-compliant signature-binding
   mechanism (audit trail + record-version binding, not a signature image), applied to (b)
   **up to three separately versioned consent artifacts** (trial informed consent, HIPAA
   research authorization — combinable per HHS guidance — and NPP acknowledgment), with (c) a
   way to record which IRB-approved version of the text was signed. This is a meaningfully
   bigger scope than the original gap-analysis doc implied, and should get its own design pass
   that starts from Part D rather than from generic e-signature SaaS patterns.

6. **Care plans + lab results** — no new regulatory finding beyond USCDI's data classes (Part
   B2) shaping what fields these need if certification is ever pursued.

7. **ToS/NPP acceptance flow** — per D3, this is genuinely just the NPP piece; trial informed
   consent and HIPAA research authorization are separate artifacts covered under item 5, not
   this one. Keep this item scoped narrowly to the general NPP acknowledgment.

8. **AI-assisted charting** — no new regulatory finding from this pass; would need its own
   research (FDA's evolving stance on AI/ML-based clinical documentation tools) if it becomes
   the active sub-project.

**Also newly relevant, not on the original list:**
- **Real eligibility checks / real claim submission** are more achievable than the original
  gap-analysis doc suggested — a clearinghouse relationship (business step) plus a bounded
  engineering project (C2), not the same "out of reach" category as e-prescribing.
- **Patient record export** (HIPAA Right of Access, A1) — not previously flagged, but a real
  gap: patients can view records in the portal today with no path to actually receive a copy.
- **RxNorm-coding `medicationEpisodes`** (B8) would be needed before any real interoperability/
  certification push, though not urgent for the pilot as-is.
