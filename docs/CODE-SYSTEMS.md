# Code systems: licensing and loading

Clinical coding uses versioned code sets: ICD-10 (diagnoses), ICD-10-PCS
(procedures), SNOMED CT (diagnoses and procedures), LOINC (lab tests) and the
PM-JAY Health Benefit Package (HBP) master (procedures and packages). This
document explains what the repository ships, how the owner obtains each set,
and how to load it.

## Licensing ruling

This is ruling 1 of the SP6 plan (`docs/superpowers/plans/2026-10-07-sp6-clinical-coding.md`), quoted verbatim:

> **Licensing and shipping.** The repository ships **no** code-system content — not WHO ICD-10, not ICD-10-PCS (even though CMS publishes it in the public domain), not SNOMED CT, LOINC or the PM-JAY HBP master. Reasons: the repo is public, WHO ICD-10 and SNOMED CT/LOINC carry licence terms that forbid or condition redistribution, and the owner must choose the edition (WHO ICD-10 as adopted in India vs. ICD-10-CM) and version. The repo ships the importer, three tiny **fictional** fixtures whose versions start `SAMPLE-` and whose every display starts `SAMPLE fictional`, and `docs/CODE-SYSTEMS.md` explaining where the owner obtains each set and how to load it. Non-sample imports require a licence note, which is stored with the version. Sample versions never emit a FHIR `system` and never displace a licensed current version.

Do not commit a real code-set file, or any converted extract of one, to this
repository. Keep the files on the machine that runs the import.

## What ships

- The importer: the validator in `src/lib/coding/import.ts`, the CLI
  `npm run codes:import` (`scripts/import-code-system.ts`), and the web importer
  on **Coding → Code Systems** (`/coding/code-systems`, admin only).
- Three fictional fixtures for development and demos, in
  `scripts/code-systems/samples/`:
  - `SAMPLE-icd10.csv`
  - `SAMPLE-icd10pcs.csv`
  - `SAMPLE-hbp.csv`

  Every code in them is invented, and every display starts `SAMPLE fictional`.
  Load them with a version that starts `SAMPLE-`. The app flags such a version
  as a sample and shows a "Sample" badge. A sample never gets a FHIR `system`
  URI, and it can never become current while a licensed version of the same
  kind is loaded.
- Nothing else. No ICD, PCS, SNOMED, LOINC or HBP content is in the repository.

## The CSV format

Both the CLI and the web importer read one CSV shape: UTF-8, comma-separated,
with an optional BOM and CRLF or LF line endings. Excel's "CSV UTF-8" output
works. The header row must be exactly:

```
code,display,parent_code,selectable,active,effective_from,effective_to,sex,age_min_years,age_max_years,excludes
```

| Column | Rules |
|---|---|
| `code` | Required. Trimmed and upper-cased. Must match the kind's format: ICD-10 `A00`–`Z99` with an optional `.` and 1–4 characters (WHO and CM styles both fit); ICD-10-PCS 7 characters (digits and letters except I and O); SNOMED CT a 6–18 digit concept id; LOINC `nnnnn-n`; HBP 1–4 letters, 1–4 digits, then up to 4 letters or digits. Unique within the file. |
| `display` | Required, 1–500 characters, no control characters. Must not start with `=`, `+`, `-` or `@`, so it cannot act as a spreadsheet formula. In a `SAMPLE-` version it must start `SAMPLE`. |
| `parent_code` | Optional. Must be another code in the same file, not the code itself, and must not form a loop. Used for display grouping. |
| `selectable` | `yes`/`no`, `true`/`false` or `1`/`0`. An empty value means yes. Use `no` for headers and categories that should not be assigned. |
| `active` | Same values as `selectable`; an empty value means yes. Inactive codes are kept but are never offered in search. |
| `effective_from`, `effective_to` | Optional real dates as `YYYY-MM-DD`, inclusive. `effective_to` must not be before `effective_from`. A code is offered only on dates inside the range. |
| `sex` | Empty, `m`/`male` or `f`/`female`. Restricts the code to that sex. |
| `age_min_years`, `age_max_years` | Optional whole years, 0–150, inclusive; the minimum may not exceed the maximum. |
| `excludes` | Optional `;`-separated list of up to 50 codes or code prefixes that may not be coded on the same encounter (`E10` also excludes `E10.9`). |

A single bad row blocks the whole import. The report lists each problem with
its line number and column, up to 200 problems. Messages never repeat cell
contents. An import is all-or-nothing: either every code is loaded in one
transaction, or none is.

## Loading each code set

Every set is loaded the same way once it is in the CSV shape above:

```bash
npm run codes:import -- --file /path/to/file.csv --kind <kind> --version <version> \
  --name "<name>" --licence "<licence ref>" --by "<your name>" --make-current
```

- `--kind` is one of `icd10`, `icd10pcs`, `snomed`, `loinc` or `hbp`.
- `--version` is 1–40 letters, digits, `.`, `_` or `-`, for example `2019-WHO` or `2026`. Versions starting `SAMPLE-` are samples.
- `--licence` is required for every non-sample set. Record where the licence comes from, for example `WHO ICD-10 licence ref …` or `NRCeS SNOMED CT affiliate licence …`. It is stored with the version.
- `--by` is your name. The import is audited as role admin with user `CLI: <your name>`.
- `--make-current` makes this version the one coders search. Without it, the version becomes current only when the kind has no current version yet.
- Run with `--dry-run` first. It validates the file, prints the issue count and any line-numbered issues, and loads nothing.

The command reads `DATABASE_URL` from `.env.local`. Point that file at the
client's database, for example with `vercel env pull .env.local`.

Converters from the publishers' release formats are not built yet. Prepare
the CSV with a spreadsheet or a short script, using the column mapping below.

### ICD-10 (`icd10`)

- **Source:** WHO ICD-10 as adopted in India. Ministry of Health and Family
  Welfare guidance names WHO ICD-10, not ICD-10-CM. Obtain the classification
  files under the WHO licence that covers your use. Confirm which edition your
  payers and TPAs expect before loading (see the open question in the plan).
- **Mapping:**
  - `code`: the category or subcategory code, with the dot (`E11.9`).
  - `display`: the title.
  - `parent_code`: the category (for `E11.9`, `E11`). Leave it blank for chapters and blocks, or omit those rows.
  - `selectable`: `no` for three-character categories that have subcategories, `yes` otherwise.
  - `sex`, `age_min_years`, `age_max_years`: from the classification's sex and age edits, where your edition provides them.
  - `excludes`: Excludes1-style entries, as codes or prefixes.
  - `active`: `yes`.

### ICD-10-PCS (`icd10pcs`)

- **Source:** the CMS ICD-10-PCS release files, published yearly. Use the
  "order" file (`icd10pcs_order_<year>.txt`). Although CMS puts it in the public
  domain, the repository still does not ship it (ruling 1).
- **Mapping:** the order file is fixed-width.
  - `code`: the 7-character code.
  - `display`: the long description.
  - `selectable`: `yes` when the header flag is `1` (a valid code), `no` when it is `0` (a header).
  - `parent_code`: optional (for example, the 3-character table). It must appear in the file.
  - `active`: `yes`.
  - `effective_from`: the fiscal year start (`<year-1>-10-01`), if you want date checks.

### SNOMED CT (`snomed`)

- **Source:** India is a SNOMED International member. Obtain the International
  Edition, plus any Indian extension, from NRCeS (the National Release Centre)
  under its affiliate licence. Use the RF2 Snapshot.
- **Mapping:**
  - `code`: `sct2_Concept_Snapshot.id`.
  - `active`: the concept's `active` flag (`1`/`0`).
  - `display`: the preferred term from `sct2_Description_Snapshot` (or the FSN), in the language reference set you use.
  - `parent_code`: one `116680003 |Is a|` parent from `sct2_Relationship_Snapshot`. The importer stores a single parent. It is used only for display, so it may be left blank.
  - `selectable`: `yes`.
  - `effective_from`: the concept's `effectiveTime` as `YYYY-MM-DD`, if wanted.

  A full SNOMED release is large. Load the subsets you need (clinical findings
  and procedures), or load the whole set with the CLI. The web importer is too
  small for it.

### LOINC (`loinc`)

- **Source:** `Loinc.csv` from loinc.org, downloaded under the LOINC licence
  (free; needs an account). The licence requires the LOINC copyright notice and
  attribution wherever LOINC codes are shown to users or sent in documents.
- **Mapping:**
  - `code`: `LOINC_NUM`.
  - `display`: `LONG_COMMON_NAME`.
  - `active`: `yes` for `STATUS` `ACTIVE` or `TRIAL`; `no` for `DEPRECATED` or `DISCOURAGED`.
  - `selectable`: `yes`.
  - `parent_code`: blank.

  Only lab tests whose code matches a loaded, current, non-sample LOINC
  version get a LOINC `system` in FHIR exports.

### PM-JAY HBP (`hbp`)

- **Source:** the Health Benefit Package master published by the National
  Health Authority (NHA) for Ayushman Bharat PM-JAY, for the HBP version your
  empanelment uses.
- **Mapping:**
  - `code`: the procedure or package code.
  - `display`: the procedure name.
  - `parent_code`: optional (for example, a specialty code, if you also add it as a row).
  - `sex`, `age_min_years`, `age_max_years`: from any gender or age restriction column.
  - `selectable`: `yes`.
  - `active`: `yes`.

  Package rates are **not** imported; prices live in the tariff module. HBP
  codes carry no FHIR `system` until the NHCX canonical URI is confirmed (SP8).

## Versions

- A loaded version is never deleted or changed in place. To correct a set, load
  it again under a new version.
- Each kind has at most one **current** version. Code search and new coding use
  it. An admin can switch the current version on **Code Systems** ("Make
  current"); the CLI does it with `--make-current`.
- A coded diagnosis or procedure keeps the code and version it was coded
  against. Switching the current version does not change earlier coding.
- A `SAMPLE-` version cannot be made current while a licensed version of the
  same kind is loaded.
- Every import and every change of current version is in the audit log
  (`coding: imported code system`, `coding: set current code system`).

## Web import

Admins can load small files on **Coding → Code Systems**. The file is read in
the browser and sent as JSON. **Check file** validates it without loading
anything, and **Load** commits it. The web importer is capped at **4 MB and
60,000 rows**. Anything bigger is refused with a message pointing here. Use
the CLI for full releases (ICD-10, PCS, SNOMED CT, LOINC); its limits are
300 MB and 2,000,000 rows.
