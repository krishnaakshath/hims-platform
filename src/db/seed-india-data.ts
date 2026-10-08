// Wave D: Indian-hospital demo reference data for src/db/seed.ts. Pure (no DB access), so the
// shape of the demo can be unit-tested without a database.
//
// Everything here is SYNTHETIC. Names, addresses and phone numbers are made up; PIN codes and
// districts are real places so the address forms validate. Identifiers are valid in format but
// deliberately recognisable as fake:
//   - Aadhaar test values all start 9999 0000 and carry a valid Verhoeff check digit. They are
//     only ever written through the encrypted patient_aadhaar path and recorded as synthetic.
//   - ABHA numbers all start 99-9999-0000; ABHA addresses use the @sbx (sandbox) domain.
//   - Mobile numbers all start +91 90000; emails use the reserved example.com domain.
//   - Medical council registration numbers start DEMO/.
//   - GSTINs use the PAN-like block ZZZ?D9999Z with a valid check character.
import { verhoeffCheckDigit } from '../lib/india/verhoeff'
import { isValidGstin } from '../lib/billing/gst'

// ---------------------------------------------------------------------------
// Synthetic identifiers
// ---------------------------------------------------------------------------

export const SYNTHETIC_AADHAAR_PREFIX = '99990000'
export const SYNTHETIC_ABHA_PREFIX = '9999990000'
export const SYNTHETIC_MOBILE_PREFIX = '+9190000'
/** Recorded as patient_aadhaar.recorded_by_name so a synthetic value is never mistaken for a real one. */
export const SYNTHETIC_AADHAAR_RECORDED_BY = 'Demo seed (synthetic test Aadhaar, not a real number)'

/** A 12-digit, Verhoeff-valid synthetic Aadhaar number (n in 1..999). Never print it. */
export function syntheticAadhaar(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new Error('syntheticAadhaar: n must be 1..999')
  const body = `${SYNTHETIC_AADHAAR_PREFIX}${String(n).padStart(3, '0')}`
  return `${body}${verhoeffCheckDigit(body)}`
}

/** A 14-digit synthetic ABHA number (n in 1..9999). */
export function syntheticAbhaNumber(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 9999) throw new Error('syntheticAbhaNumber: n must be 1..9999')
  return `${SYNTHETIC_ABHA_PREFIX}${String(n).padStart(4, '0')}`
}

/** A synthetic +91 mobile number (n in 0..99999), normalised the way registration stores it. */
export function syntheticMobile(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 99999) throw new Error('syntheticMobile: n must be 0..99999')
  return `${SYNTHETIC_MOBILE_PREFIX}${String(n).padStart(5, '0')}`
}

/** Completes a 14-character GSTIN body with its check character. */
export function gstinWithCheck(body14: string): string {
  for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (isValidGstin(`${body14}${ch}`)) return `${body14}${ch}`
  }
  throw new Error('gstinWithCheck: no valid check character')
}

// ---------------------------------------------------------------------------
// Hospital, departments, doctors
// ---------------------------------------------------------------------------

export const DEMO_HOSPITAL = {
  legalName: 'Demo Multispeciality Hospital (synthetic data)',
  stateCode: 'IN-KA',
  // 29 = Karnataka.
  gstin: gstinWithCheck('29ZZZTD9999Z1Z'),
  address: '#45, 80 Feet Road, Koramangala 4th Block, Bengaluru, Karnataka 560034',
  /** IPD deposit below which a procedure charge warns/blocks (₹10,000). */
  ipdDepositThresholdPaise: 10_000_00,
} as const

export type DepartmentKind = 'clinical' | 'diagnostic' | 'support' | 'administrative'

export const DEPARTMENT_SEED: { code: string; name: string; kind: DepartmentKind }[] = [
  { code: 'GEN_MED', name: 'General Medicine', kind: 'clinical' },
  { code: 'GEN_SURG', name: 'General Surgery', kind: 'clinical' },
  { code: 'PAED', name: 'Paediatrics', kind: 'clinical' },
  { code: 'OBG', name: 'Obstetrics & Gynaecology', kind: 'clinical' },
  { code: 'ORTHO', name: 'Orthopaedics', kind: 'clinical' },
  { code: 'CARDIO', name: 'Cardiology', kind: 'clinical' },
  { code: 'EMERG', name: 'Emergency', kind: 'clinical' },
  { code: 'PSYCH', name: 'Psychiatry', kind: 'clinical' },
  { code: 'LAB', name: 'Laboratory', kind: 'diagnostic' },
  { code: 'RADIO', name: 'Radiology', kind: 'diagnostic' },
  { code: 'PHARM', name: 'Pharmacy', kind: 'support' },
  { code: 'ADMIN', name: 'Administration', kind: 'administrative' },
]

export type DoctorSeed = {
  name: string
  credentials: string
  specialty: string
  colorTag: 'chart-1' | 'chart-2' | 'chart-3' | 'chart-4' | 'chart-5'
  departmentCode: string
  registrationCouncil: 'nmc' | 'smc'
  registrationStateCode: string | null
  registrationNumber: string
  consultationFeePaise: number
}

// Dr. Rajiv Kunam is the demo `pi` login (users/staff rows link to him by name) and keeps his
// psychiatry profile; the clinical-research trials run out of the Psychiatry department.
export const DOCTOR_ROSTER: DoctorSeed[] = [
  { name: 'Dr. Rajiv Kunam', credentials: 'MD', specialty: 'Psychiatry', colorTag: 'chart-1', departmentCode: 'PSYCH', registrationCouncil: 'smc', registrationStateCode: 'IN-KA', registrationNumber: 'DEMO/2008/41207', consultationFeePaise: 800_00 },
  { name: 'Dr. Ananya Rao', credentials: 'MD', specialty: 'General Medicine', colorTag: 'chart-2', departmentCode: 'GEN_MED', registrationCouncil: 'nmc', registrationStateCode: null, registrationNumber: 'DEMO/NMC/2014/1188', consultationFeePaise: 600_00 },
  { name: 'Dr. Vikram Shetty', credentials: 'MS', specialty: 'General Surgery', colorTag: 'chart-3', departmentCode: 'GEN_SURG', registrationCouncil: 'smc', registrationStateCode: 'IN-KA', registrationNumber: 'DEMO/2010/52931', consultationFeePaise: 700_00 },
  { name: 'Dr. Meera Iyer', credentials: 'MD, DCH', specialty: 'Paediatrics', colorTag: 'chart-4', departmentCode: 'PAED', registrationCouncil: 'smc', registrationStateCode: 'IN-TN', registrationNumber: 'DEMO/2012/77310', consultationFeePaise: 600_00 },
  { name: 'Dr. Farhan Qureshi', credentials: 'MD, DM', specialty: 'Cardiology', colorTag: 'chart-5', departmentCode: 'CARDIO', registrationCouncil: 'nmc', registrationStateCode: null, registrationNumber: 'DEMO/NMC/2009/0642', consultationFeePaise: 1_000_00 },
  { name: 'Dr. Lakshmi Narayanan', credentials: 'MS, DGO', specialty: 'Obstetrics & Gynaecology', colorTag: 'chart-1', departmentCode: 'OBG', registrationCouncil: 'smc', registrationStateCode: 'IN-KA', registrationNumber: 'DEMO/2006/30418', consultationFeePaise: 700_00 },
  { name: 'Dr. Arjun Reddy', credentials: 'MS', specialty: 'Orthopaedics', colorTag: 'chart-2', departmentCode: 'ORTHO', registrationCouncil: 'smc', registrationStateCode: 'IN-TS', registrationNumber: 'DEMO/2013/68022', consultationFeePaise: 700_00 },
  { name: 'Dr. Kavya Hegde', credentials: 'MD', specialty: 'Emergency Medicine', colorTag: 'chart-3', departmentCode: 'EMERG', registrationCouncil: 'smc', registrationStateCode: 'IN-KA', registrationNumber: 'DEMO/2016/90155', consultationFeePaise: 500_00 },
  { name: 'Dr. Suresh Babu', credentials: 'MD', specialty: 'Pathology', colorTag: 'chart-4', departmentCode: 'LAB', registrationCouncil: 'smc', registrationStateCode: 'IN-KA', registrationNumber: 'DEMO/2005/22874', consultationFeePaise: 0 },
]

// ---------------------------------------------------------------------------
// Payers: insurers, TPAs and government schemes
// ---------------------------------------------------------------------------

export type PayerSeed = {
  name: string
  payerId: string
  payerType: 'commercial' | 'other'
  requiresPreauth: boolean
  stateCode: string | null
  gstin: string | null
}

// payer_type is a legacy enum (commercial/medicare/medicaid/tricare/other): insurers are
// 'commercial'; TPAs and government schemes are 'other'.
export const PAYERS_SEED: PayerSeed[] = [
  { name: 'Star Health and Allied Insurance', payerId: 'STARHEALTH', payerType: 'commercial', requiresPreauth: true, stateCode: 'IN-TN', gstin: gstinWithCheck('33ZZZSH9999Z1Z') },
  { name: 'ICICI Lombard General Insurance', payerId: 'ICICILOMBARD', payerType: 'commercial', requiresPreauth: true, stateCode: 'IN-MH', gstin: null },
  { name: 'HDFC ERGO General Insurance', payerId: 'HDFCERGO', payerType: 'commercial', requiresPreauth: true, stateCode: 'IN-MH', gstin: null },
  { name: 'Niva Bupa Health Insurance', payerId: 'NIVABUPA', payerType: 'commercial', requiresPreauth: true, stateCode: 'IN-DL', gstin: null },
  { name: 'Medi Assist TPA', payerId: 'MEDIASSIST', payerType: 'other', requiresPreauth: true, stateCode: 'IN-KA', gstin: gstinWithCheck('29ZZZMA9999Z1Z') },
  { name: 'Paramount Health Services TPA', payerId: 'PARAMOUNT', payerType: 'other', requiresPreauth: true, stateCode: 'IN-MH', gstin: null },
  { name: 'MD India Health Insurance TPA', payerId: 'MDINDIA', payerType: 'other', requiresPreauth: true, stateCode: 'IN-MH', gstin: null },
  { name: 'Ayushman Bharat PM-JAY', payerId: 'PMJAY', payerType: 'other', requiresPreauth: true, stateCode: null, gstin: null },
  { name: 'CGHS (Central Government Health Scheme)', payerId: 'CGHS', payerType: 'other', requiresPreauth: false, stateCode: null, gstin: null },
  { name: 'ECHS (Ex-Servicemen Contributory Health Scheme)', payerId: 'ECHS', payerType: 'other', requiresPreauth: false, stateCode: null, gstin: null },
]

/** The US payer directory earlier seeds created; a reset removes any that nothing references. */
export const LEGACY_US_PAYER_NAMES = [
  'Aetna', 'UnitedHealthcare', 'Cigna', 'Humana', 'Anthem Blue Cross of California', 'Blue Shield of California',
  'Kaiser Permanente', 'Molina Healthcare', 'Ambetter (Centene)', 'Oscar Health', 'Health Net', 'Medicare (Noridian, CA)',
  'Medi-Cal', 'TRICARE',
]

// ---------------------------------------------------------------------------
// Rooms and wards with tariff room categories
// ---------------------------------------------------------------------------

export const ROOM_CATEGORY_SEED = [
  { code: 'GEN_WARD', name: 'General ward' },
  { code: 'SEMI_PVT', name: 'Semi-private' },
  { code: 'PRIVATE', name: 'Private' },
  { code: 'ICU', name: 'ICU' },
] as const

export type RoomCategoryCode = (typeof ROOM_CATEGORY_SEED)[number]['code']

export const ROOM_SEED: { ward: string; roomNumber: string; bedNumber: string; category: RoomCategoryCode }[] = [
  ...['A', 'B', 'C', 'D'].map((bed) => ({ ward: 'General Ward (Male)', roomNumber: '101', bedNumber: bed, category: 'GEN_WARD' as const })),
  ...['A', 'B', 'C', 'D'].map((bed) => ({ ward: 'General Ward (Female)', roomNumber: '102', bedNumber: bed, category: 'GEN_WARD' as const })),
  ...['201', '202'].flatMap((room) => ['A', 'B'].map((bed) => ({ ward: 'Semi-Private', roomNumber: room, bedNumber: bed, category: 'SEMI_PVT' as const }))),
  ...['301', '302', '303'].map((room) => ({ ward: 'Private', roomNumber: room, bedNumber: 'A', category: 'PRIVATE' as const })),
  ...['1', '2', '3', '4'].map((bed) => ({ ward: 'ICU', roomNumber: 'ICU-1', bedNumber: bed, category: 'ICU' as const })),
]

// ---------------------------------------------------------------------------
// Service master and tariffs (all money is integer paise)
// ---------------------------------------------------------------------------

export type ServiceCategory = 'consultation' | 'procedure' | 'investigation_lab' | 'investigation_imaging' | 'room_rent'
  | 'nursing' | 'pharmacy' | 'consumable' | 'package' | 'other'

export type ServiceSeed = {
  code: string
  name: string
  departmentCode: string
  category: ServiceCategory
  hsnSac: string
  gstRateBp: number
  /** Base rate (paise). Room-category services instead use `byRoomCategory`. */
  basePaise?: number
  byRoomCategory?: Record<RoomCategoryCode, number>
  requiresPreauth?: boolean
  maxQuantity?: number
}

// SAC 9993 (human health services) is GST-exempt for clinical care; a certificate or a
// consumable is not, so the demo has both taxable and exempt lines.
export const SERVICE_SEED: ServiceSeed[] = [
  { code: 'REG_FEE', name: 'Registration and UHID card', departmentCode: 'ADMIN', category: 'other', hsnSac: '999312', gstRateBp: 0, basePaise: 100_00 },
  { code: 'CONS_GENMED', name: 'Consultation - General Medicine', departmentCode: 'GEN_MED', category: 'consultation', hsnSac: '999312', gstRateBp: 0, basePaise: 600_00 },
  { code: 'CONS_SURG', name: 'Consultation - General Surgery', departmentCode: 'GEN_SURG', category: 'consultation', hsnSac: '999312', gstRateBp: 0, basePaise: 700_00 },
  { code: 'CONS_PAED', name: 'Consultation - Paediatrics', departmentCode: 'PAED', category: 'consultation', hsnSac: '999312', gstRateBp: 0, basePaise: 600_00 },
  { code: 'CONS_OBG', name: 'Consultation - Obstetrics & Gynaecology', departmentCode: 'OBG', category: 'consultation', hsnSac: '999312', gstRateBp: 0, basePaise: 700_00 },
  { code: 'CONS_ORTHO', name: 'Consultation - Orthopaedics', departmentCode: 'ORTHO', category: 'consultation', hsnSac: '999312', gstRateBp: 0, basePaise: 700_00 },
  { code: 'CONS_CARDIO', name: 'Consultation - Cardiology', departmentCode: 'CARDIO', category: 'consultation', hsnSac: '999312', gstRateBp: 0, basePaise: 1_000_00 },
  { code: 'CONS_PSYCH', name: 'Consultation - Psychiatry', departmentCode: 'PSYCH', category: 'consultation', hsnSac: '999312', gstRateBp: 0, basePaise: 800_00 },
  { code: 'CONS_EMERG', name: 'Emergency consultation', departmentCode: 'EMERG', category: 'consultation', hsnSac: '999312', gstRateBp: 0, basePaise: 500_00 },
  { code: 'LAB_CBC', name: 'Complete blood count (CBC)', departmentCode: 'LAB', category: 'investigation_lab', hsnSac: '999316', gstRateBp: 0, basePaise: 350_00 },
  { code: 'LAB_LFT', name: 'Liver function test (LFT)', departmentCode: 'LAB', category: 'investigation_lab', hsnSac: '999316', gstRateBp: 0, basePaise: 650_00 },
  { code: 'LAB_KFT', name: 'Kidney function test (KFT)', departmentCode: 'LAB', category: 'investigation_lab', hsnSac: '999316', gstRateBp: 0, basePaise: 600_00 },
  { code: 'LAB_HBA1C', name: 'Glycated haemoglobin (HbA1c)', departmentCode: 'LAB', category: 'investigation_lab', hsnSac: '999316', gstRateBp: 0, basePaise: 450_00 },
  { code: 'LAB_TSH', name: 'Thyroid stimulating hormone (TSH)', departmentCode: 'LAB', category: 'investigation_lab', hsnSac: '999316', gstRateBp: 0, basePaise: 400_00 },
  { code: 'LAB_LIPID', name: 'Lipid profile', departmentCode: 'LAB', category: 'investigation_lab', hsnSac: '999316', gstRateBp: 0, basePaise: 550_00 },
  { code: 'LAB_DENGUE', name: 'Dengue NS1 antigen', departmentCode: 'LAB', category: 'investigation_lab', hsnSac: '999316', gstRateBp: 0, basePaise: 600_00 },
  { code: 'LAB_MALARIA', name: 'Malaria antigen (rapid)', departmentCode: 'LAB', category: 'investigation_lab', hsnSac: '999316', gstRateBp: 0, basePaise: 300_00 },
  { code: 'LAB_URINE_RM', name: 'Urine routine and microscopy', departmentCode: 'LAB', category: 'investigation_lab', hsnSac: '999316', gstRateBp: 0, basePaise: 150_00 },
  { code: 'LAB_FBS', name: 'Fasting blood sugar', departmentCode: 'LAB', category: 'investigation_lab', hsnSac: '999316', gstRateBp: 0, basePaise: 80_00 },
  { code: 'LAB_CRP', name: 'C-reactive protein (CRP)', departmentCode: 'LAB', category: 'investigation_lab', hsnSac: '999316', gstRateBp: 0, basePaise: 450_00 },
  { code: 'IMG_XR_CHEST', name: 'X-ray chest PA view', departmentCode: 'RADIO', category: 'investigation_imaging', hsnSac: '999316', gstRateBp: 0, basePaise: 400_00 },
  { code: 'IMG_USG_ABD', name: 'Ultrasound abdomen and pelvis', departmentCode: 'RADIO', category: 'investigation_imaging', hsnSac: '999316', gstRateBp: 0, basePaise: 1_200_00 },
  { code: 'IMG_CT_HEAD', name: 'CT head (plain)', departmentCode: 'RADIO', category: 'investigation_imaging', hsnSac: '999316', gstRateBp: 0, basePaise: 3_500_00, requiresPreauth: true },
  { code: 'IMG_ECHO', name: '2D echocardiography', departmentCode: 'CARDIO', category: 'investigation_imaging', hsnSac: '999316', gstRateBp: 0, basePaise: 2_000_00 },
  { code: 'PROC_ECG', name: 'ECG (12-lead)', departmentCode: 'CARDIO', category: 'procedure', hsnSac: '999312', gstRateBp: 0, basePaise: 250_00 },
  { code: 'PROC_DRESSING', name: 'Wound dressing (minor)', departmentCode: 'GEN_SURG', category: 'procedure', hsnSac: '999312', gstRateBp: 0, basePaise: 300_00, maxQuantity: 3 },
  { code: 'PROC_NEBULISE', name: 'Nebulisation', departmentCode: 'GEN_MED', category: 'procedure', hsnSac: '999312', gstRateBp: 0, basePaise: 200_00, maxQuantity: 6 },
  { code: 'PROC_SUTURE', name: 'Suturing of laceration', departmentCode: 'EMERG', category: 'procedure', hsnSac: '999312', gstRateBp: 0, basePaise: 1_500_00 },
  { code: 'PROC_PLASTER', name: 'Plaster of Paris cast application', departmentCode: 'ORTHO', category: 'procedure', hsnSac: '999312', gstRateBp: 0, basePaise: 2_000_00 },
  { code: 'ROOM_RENT', name: 'Room rent (per day)', departmentCode: 'ADMIN', category: 'room_rent', hsnSac: '999311', gstRateBp: 0, byRoomCategory: { GEN_WARD: 1_500_00, SEMI_PVT: 3_000_00, PRIVATE: 5_000_00, ICU: 9_000_00 } },
  { code: 'NURSING_DAY', name: 'Nursing charges (per day)', departmentCode: 'ADMIN', category: 'nursing', hsnSac: '999311', gstRateBp: 0, byRoomCategory: { GEN_WARD: 500_00, SEMI_PVT: 700_00, PRIVATE: 900_00, ICU: 2_500_00 } },
  { code: 'CONSUM_IV_SET', name: 'IV cannula and infusion set', departmentCode: 'PHARM', category: 'consumable', hsnSac: '9018', gstRateBp: 1200, basePaise: 350_00, maxQuantity: 10 },
  { code: 'MED_CERT', name: 'Medical fitness certificate', departmentCode: 'ADMIN', category: 'other', hsnSac: '998599', gstRateBp: 1800, basePaise: 200_00 },
  { code: 'PKG_NORMAL_DEL', name: 'Normal delivery package (2 days, general ward)', departmentCode: 'OBG', category: 'package', hsnSac: '999311', gstRateBp: 0, basePaise: 25_000_00, requiresPreauth: true },
]

export const PACKAGE_ITEMS_SEED: { packageCode: string; itemCode: string; quantity: number }[] = [
  { packageCode: 'PKG_NORMAL_DEL', itemCode: 'CONS_OBG', quantity: 2 },
  { packageCode: 'PKG_NORMAL_DEL', itemCode: 'ROOM_RENT', quantity: 2 },
  { packageCode: 'PKG_NORMAL_DEL', itemCode: 'NURSING_DAY', quantity: 2 },
  { packageCode: 'PKG_NORMAL_DEL', itemCode: 'LAB_CBC', quantity: 1 },
]

/** First day of the current financial year's rate card, and the previous card's window. */
export const TARIFF_VALID_FROM = '2026-04-01'
export const PREVIOUS_TARIFF = { validFrom: '2025-04-01', validTo: '2026-03-31' }

/** Department-scoped rates: the ordering department pays a different rate. */
export const DEPARTMENT_TARIFFS: { serviceCode: string; departmentCode: string; amountPaise: number }[] = [
  { serviceCode: 'LAB_CBC', departmentCode: 'EMERG', amountPaise: 450_00 },
  { serviceCode: 'PROC_ECG', departmentCode: 'EMERG', amountPaise: 350_00 },
]

/** Payer-scoped (insurer / scheme) rates; a room category narrows a room-rent rate. */
export const PAYER_TARIFFS: { serviceCode: string; payerName: string; amountPaise: number; roomCategory?: RoomCategoryCode }[] = [
  { serviceCode: 'CONS_CARDIO', payerName: 'Star Health and Allied Insurance', amountPaise: 900_00 },
  { serviceCode: 'ROOM_RENT', payerName: 'Star Health and Allied Insurance', amountPaise: 4_500_00, roomCategory: 'PRIVATE' },
  { serviceCode: 'ROOM_RENT', payerName: 'Star Health and Allied Insurance', amountPaise: 2_700_00, roomCategory: 'SEMI_PVT' },
  { serviceCode: 'LAB_CBC', payerName: 'Ayushman Bharat PM-JAY', amountPaise: 200_00 },
  { serviceCode: 'CONS_GENMED', payerName: 'CGHS (Central Government Health Scheme)', amountPaise: 350_00 },
  { serviceCode: 'PKG_NORMAL_DEL', payerName: 'Ayushman Bharat PM-JAY', amountPaise: 9_000_00 },
]

// ---------------------------------------------------------------------------
// Lab tests (added to the existing catalogue), linked to the service master
// ---------------------------------------------------------------------------

export type LabTestSeed = {
  name: string
  code: string
  category: 'lab' | 'imaging'
  defaultUnit: string | null
  referenceRange: string | null
  sampleType: 'blood' | 'serum' | 'plasma' | 'urine' | null
  container: 'edta_lavender' | 'plain_red' | 'sst_gold' | 'fluoride_grey' | 'urine_container' | null
  serviceCode: string | null
}

export const INDIA_LAB_TESTS: LabTestSeed[] = [
  { name: 'Liver function test', code: 'LFT', category: 'lab', defaultUnit: null, referenceRange: 'See individual analytes', sampleType: 'serum', container: 'sst_gold', serviceCode: 'LAB_LFT' },
  { name: 'Kidney function test', code: 'KFT', category: 'lab', defaultUnit: null, referenceRange: 'See individual analytes', sampleType: 'serum', container: 'sst_gold', serviceCode: 'LAB_KFT' },
  { name: 'Dengue NS1 antigen', code: 'DENGUE-NS1', category: 'lab', defaultUnit: null, referenceRange: 'Negative', sampleType: 'serum', container: 'plain_red', serviceCode: 'LAB_DENGUE' },
  { name: 'Malaria antigen (rapid)', code: 'MAL-AG', category: 'lab', defaultUnit: null, referenceRange: 'Negative', sampleType: 'blood', container: 'edta_lavender', serviceCode: 'LAB_MALARIA' },
  { name: 'Urine routine and microscopy', code: 'URINE-RM', category: 'lab', defaultUnit: null, referenceRange: 'See report', sampleType: 'urine', container: 'urine_container', serviceCode: 'LAB_URINE_RM' },
  { name: 'Fasting blood sugar', code: 'FBS', category: 'lab', defaultUnit: 'mg/dL', referenceRange: '70-100', sampleType: 'plasma', container: 'fluoride_grey', serviceCode: 'LAB_FBS' },
  { name: 'C-reactive protein', code: 'CRP', category: 'lab', defaultUnit: 'mg/L', referenceRange: '<6', sampleType: 'serum', container: 'plain_red', serviceCode: 'LAB_CRP' },
]

/** Existing catalogue codes that map onto a service-master item. */
export const EXISTING_LAB_TEST_SERVICE_MAP: Record<string, { serviceCode: string; sampleType: LabTestSeed['sampleType']; container: LabTestSeed['container'] }> = {
  'CBC-DIFF': { serviceCode: 'LAB_CBC', sampleType: 'blood', container: 'edta_lavender' },
  TSH: { serviceCode: 'LAB_TSH', sampleType: 'serum', container: 'sst_gold' },
  LIPID: { serviceCode: 'LAB_LIPID', sampleType: 'serum', container: 'sst_gold' },
  HBA1C: { serviceCode: 'LAB_HBA1C', sampleType: 'blood', container: 'edta_lavender' },
  'XR-CHEST-1V': { serviceCode: 'IMG_XR_CHEST', sampleType: null, container: null },
  'US-ABD': { serviceCode: 'IMG_USG_ABD', sampleType: null, container: null },
  'CT-HEAD-NC': { serviceCode: 'IMG_CT_HEAD', sampleType: null, container: null },
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

export type PlaceSeed = { city: string; district: string; stateCode: string; pinCode: string; local: boolean }

// Real places and PIN codes. `local` = inside the demo lab's home-collection service area.
export const PLACES: PlaceSeed[] = [
  { city: 'Bengaluru', district: 'Bengaluru Urban', stateCode: 'IN-KA', pinCode: '560034', local: true },
  { city: 'Bengaluru', district: 'Bengaluru Urban', stateCode: 'IN-KA', pinCode: '560011', local: true },
  { city: 'Bengaluru', district: 'Bengaluru Urban', stateCode: 'IN-KA', pinCode: '560038', local: true },
  { city: 'Bengaluru', district: 'Bengaluru Urban', stateCode: 'IN-KA', pinCode: '560066', local: true },
  { city: 'Bengaluru', district: 'Bengaluru Urban', stateCode: 'IN-KA', pinCode: '560076', local: true },
  { city: 'Bengaluru', district: 'Bengaluru Urban', stateCode: 'IN-KA', pinCode: '560078', local: true },
  { city: 'Mysuru', district: 'Mysuru', stateCode: 'IN-KA', pinCode: '570017', local: false },
  { city: 'Tumakuru', district: 'Tumakuru', stateCode: 'IN-KA', pinCode: '572101', local: false },
  { city: 'Mangaluru', district: 'Dakshina Kannada', stateCode: 'IN-KA', pinCode: '575001', local: false },
  { city: 'Hosur', district: 'Krishnagiri', stateCode: 'IN-TN', pinCode: '635109', local: false },
  { city: 'Chennai', district: 'Chennai', stateCode: 'IN-TN', pinCode: '600040', local: false },
  { city: 'Kochi', district: 'Ernakulam', stateCode: 'IN-KL', pinCode: '682016', local: false },
  { city: 'Hyderabad', district: 'Hyderabad', stateCode: 'IN-TS', pinCode: '500034', local: false },
  { city: 'Anantapur', district: 'Anantapur', stateCode: 'IN-AP', pinCode: '515001', local: false },
  { city: 'Pune', district: 'Pune', stateCode: 'IN-MH', pinCode: '411038', local: false },
]

export const SERVICE_AREA_PINS = PLACES.filter((p) => p.local).map((p) => ({ pinCode: p.pinCode, areaLabel: `Demo service area ${p.pinCode}` }))

const STREETS = [
  '#12, 4th Cross, 6th Main', '#221, 2nd Floor, 9th A Main', 'No. 7, Temple Street', 'Flat 304, Sai Residency, 1st Stage',
  '#58, Gandhi Bazaar Road', 'No. 19, 3rd Block, Ward 8', '#3/1, Lakeview Layout', 'Door No. 11-4-22, Station Road',
]

export type PatientProfileSeed = {
  name: string
  gender: 'male' | 'female'
  maritalStatus: 'single' | 'married' | 'widowed'
  bloodGroup: 'A+' | 'B+' | 'O+' | 'AB+' | 'O-' | 'A-'
  occupation: string
  preferredLanguage: string
}

export type HeroIdentity = PatientProfileSeed & { id: string; dob: string; placeIndex: number; email: string; phoneIndex: number }

// The six hand-authored clinical-research patients (ids, DOBs, trials and verdicts unchanged).
export const HERO_IDENTITIES: HeroIdentity[] = [
  { id: 'RD-0001', name: 'Meera Krishnan', gender: 'female', maritalStatus: 'married', bloodGroup: 'B+', occupation: 'School teacher', preferredLanguage: 'kn', dob: '1985-03-12', placeIndex: 0, email: 'meera.krishnan.demo@example.com', phoneIndex: 142 },
  { id: 'RD-0002', name: 'Rahul Verma', gender: 'male', maritalStatus: 'single', bloodGroup: 'O+', occupation: 'Software engineer', preferredLanguage: 'hi', dob: '1990-11-02', placeIndex: 2, email: 'rahul.verma.demo@example.com', phoneIndex: 198 },
  { id: 'RD-0003', name: 'Kavya Shetty', gender: 'female', maritalStatus: 'married', bloodGroup: 'A+', occupation: 'Accountant', preferredLanguage: 'kn', dob: '1978-06-30', placeIndex: 8, email: 'kavya.shetty.demo@example.com', phoneIndex: 177 },
  { id: 'RD-0004', name: 'Ananya Iyer', gender: 'female', maritalStatus: 'single', bloodGroup: 'O+', occupation: 'Graduate student', preferredLanguage: 'ta', dob: '1994-02-18', placeIndex: 1, email: 'ananya.iyer.demo@example.com', phoneIndex: 133 },
  { id: 'RD-0005', name: 'Arjun Nair', gender: 'male', maritalStatus: 'married', bloodGroup: 'AB+', occupation: 'Sales manager', preferredLanguage: 'ml', dob: '1988-09-09', placeIndex: 11, email: 'arjun.nair.demo@example.com', phoneIndex: 161 },
  { id: 'RD-0006', name: 'Farah Khan', gender: 'female', maritalStatus: 'married', bloodGroup: 'B+', occupation: 'Pharmacist', preferredLanguage: 'ur', dob: '1982-12-05', placeIndex: 3, email: 'farah.khan.old@example.com', phoneIndex: 188 },
]

export const FILLER_PROFILES: PatientProfileSeed[] = [
  { name: 'Ramesh Gowda', gender: 'male', maritalStatus: 'married', bloodGroup: 'O+', occupation: 'Farmer', preferredLanguage: 'kn' },
  { name: 'Lakshmi Devi', gender: 'female', maritalStatus: 'widowed', bloodGroup: 'B+', occupation: 'Homemaker', preferredLanguage: 'te' },
  { name: 'Mohammed Irfan', gender: 'male', maritalStatus: 'married', bloodGroup: 'A+', occupation: 'Auto-rickshaw driver', preferredLanguage: 'ur' },
  { name: 'Sunita Sharma', gender: 'female', maritalStatus: 'married', bloodGroup: 'O+', occupation: 'Bank clerk', preferredLanguage: 'hi' },
  { name: 'Venkatesh Murthy', gender: 'male', maritalStatus: 'married', bloodGroup: 'B+', occupation: 'Retired government employee', preferredLanguage: 'kn' },
  { name: 'Kavitha Reddy', gender: 'female', maritalStatus: 'married', bloodGroup: 'AB+', occupation: 'Nurse', preferredLanguage: 'te' },
  { name: 'Abdul Rahman', gender: 'male', maritalStatus: 'married', bloodGroup: 'O-', occupation: 'Shopkeeper', preferredLanguage: 'ur' },
  { name: 'Deepa Nair', gender: 'female', maritalStatus: 'single', bloodGroup: 'A+', occupation: 'Graphic designer', preferredLanguage: 'ml' },
  { name: 'Suresh Patil', gender: 'male', maritalStatus: 'married', bloodGroup: 'B+', occupation: 'Civil contractor', preferredLanguage: 'mr' },
  { name: 'Ayesha Siddiqui', gender: 'female', maritalStatus: 'single', bloodGroup: 'O+', occupation: 'College student', preferredLanguage: 'ur' },
  { name: 'Prakash Hegde', gender: 'male', maritalStatus: 'married', bloodGroup: 'A+', occupation: 'Hotel owner', preferredLanguage: 'kn' },
  { name: 'Geetha Krishnan', gender: 'female', maritalStatus: 'married', bloodGroup: 'B+', occupation: 'Tailor', preferredLanguage: 'ta' },
  { name: 'Harish Kumar', gender: 'male', maritalStatus: 'single', bloodGroup: 'O+', occupation: 'Delivery executive', preferredLanguage: 'kn' },
  { name: 'Fathima Beevi', gender: 'female', maritalStatus: 'widowed', bloodGroup: 'A-', occupation: 'Homemaker', preferredLanguage: 'ml' },
  { name: 'Manjunath Shetty', gender: 'male', maritalStatus: 'married', bloodGroup: 'B+', occupation: 'Bus conductor', preferredLanguage: 'kn' },
  { name: 'Shalini Joshi', gender: 'female', maritalStatus: 'married', bloodGroup: 'O+', occupation: 'Chartered accountant', preferredLanguage: 'mr' },
  { name: 'Rajendra Prasad', gender: 'male', maritalStatus: 'married', bloodGroup: 'AB+', occupation: 'Retired teacher', preferredLanguage: 'hi' },
  { name: 'Sneha Kulkarni', gender: 'female', maritalStatus: 'single', bloodGroup: 'A+', occupation: 'Software tester', preferredLanguage: 'mr' },
  { name: 'Imran Khan', gender: 'male', maritalStatus: 'married', bloodGroup: 'O+', occupation: 'Electrician', preferredLanguage: 'ur' },
  { name: 'Pavithra Rao', gender: 'female', maritalStatus: 'married', bloodGroup: 'B+', occupation: 'Lecturer', preferredLanguage: 'kn' },
  { name: 'Ganesh Bhat', gender: 'male', maritalStatus: 'married', bloodGroup: 'A+', occupation: 'Priest', preferredLanguage: 'kn' },
  { name: 'Nirmala Iyengar', gender: 'female', maritalStatus: 'widowed', bloodGroup: 'O+', occupation: 'Retired', preferredLanguage: 'ta' },
  { name: 'Sandeep Yadav', gender: 'male', maritalStatus: 'single', bloodGroup: 'B+', occupation: 'Security guard', preferredLanguage: 'hi' },
  { name: 'Roopa Shenoy', gender: 'female', maritalStatus: 'married', bloodGroup: 'A+', occupation: 'Boutique owner', preferredLanguage: 'kn' },
  { name: 'Arvind Menon', gender: 'male', maritalStatus: 'married', bloodGroup: 'O+', occupation: 'Marketing manager', preferredLanguage: 'ml' },
  { name: 'Divya Pillai', gender: 'female', maritalStatus: 'single', bloodGroup: 'AB+', occupation: 'Physiotherapist', preferredLanguage: 'ml' },
  { name: 'Basavaraj Hiremath', gender: 'male', maritalStatus: 'married', bloodGroup: 'B+', occupation: 'Agricultural officer', preferredLanguage: 'kn' },
  { name: 'Shabana Begum', gender: 'female', maritalStatus: 'married', bloodGroup: 'O+', occupation: 'Homemaker', preferredLanguage: 'ur' },
  { name: 'Naveen Raju', gender: 'male', maritalStatus: 'single', bloodGroup: 'A+', occupation: 'Cab driver', preferredLanguage: 'te' },
  { name: 'Anitha George', gender: 'female', maritalStatus: 'married', bloodGroup: 'O-', occupation: 'Nursing supervisor', preferredLanguage: 'ml' },
  { name: 'Thomas Varghese', gender: 'male', maritalStatus: 'married', bloodGroup: 'B+', occupation: 'Retired army officer', preferredLanguage: 'ml' },
  { name: 'Bhavana Desai', gender: 'female', maritalStatus: 'married', bloodGroup: 'A+', occupation: 'Architect', preferredLanguage: 'gu' },
  { name: 'Kiran Naik', gender: 'male', maritalStatus: 'single', bloodGroup: 'O+', occupation: 'Mechanic', preferredLanguage: 'kn' },
  { name: 'Sarojamma K', gender: 'female', maritalStatus: 'widowed', bloodGroup: 'B+', occupation: 'Vegetable vendor', preferredLanguage: 'kn' },
  { name: 'Vijay Anand', gender: 'male', maritalStatus: 'married', bloodGroup: 'AB+', occupation: 'Photographer', preferredLanguage: 'ta' },
  { name: 'Rekha Gupta', gender: 'female', maritalStatus: 'married', bloodGroup: 'O+', occupation: 'Homemaker', preferredLanguage: 'hi' },
  { name: 'Siddharth Jain', gender: 'male', maritalStatus: 'single', bloodGroup: 'A+', occupation: 'Jeweller', preferredLanguage: 'hi' },
  { name: 'Meenakshi Sundaram', gender: 'female', maritalStatus: 'married', bloodGroup: 'B+', occupation: 'Postal assistant', preferredLanguage: 'ta' },
  { name: 'Raghavendra Acharya', gender: 'male', maritalStatus: 'married', bloodGroup: 'O+', occupation: 'Cook', preferredLanguage: 'kn' },
  { name: 'Zainab Fatima', gender: 'female', maritalStatus: 'single', bloodGroup: 'A-', occupation: 'Data entry operator', preferredLanguage: 'ur' },
  { name: 'Mahesh Kamath', gender: 'male', maritalStatus: 'married', bloodGroup: 'B+', occupation: 'Insurance agent', preferredLanguage: 'kn' },
  { name: 'Usha Rani', gender: 'female', maritalStatus: 'married', bloodGroup: 'O+', occupation: 'Anganwadi worker', preferredLanguage: 'te' },
  { name: 'Gurpreet Singh', gender: 'male', maritalStatus: 'married', bloodGroup: 'A+', occupation: 'Transport business', preferredLanguage: 'pa' },
  { name: "Joseph D'Souza", gender: 'male', maritalStatus: 'married', bloodGroup: 'B+', occupation: 'Retired bank manager', preferredLanguage: 'en' },
]

/** Address block for a patient: a street line plus a real city/district/state/PIN. */
export function addressFor(placeIndex: number, streetIndex: number): { addressLine1: string } & PlaceSeed {
  const place = PLACES[((placeIndex % PLACES.length) + PLACES.length) % PLACES.length]
  return { addressLine1: STREETS[streetIndex % STREETS.length], ...place }
}

/** A plausible email local part from a name (ASCII letters only). */
export function demoEmail(name: string): string {
  const parts = name.toLowerCase().replace(/[^a-z ]/g, '').split(' ').filter(Boolean)
  return `${parts.join('.')}.demo@example.com`
}

// ---------------------------------------------------------------------------
// Staff demo logins (local part of the email -> display name)
// ---------------------------------------------------------------------------

export const DEMO_USERS: { local: string; name: string; role: 'admin' | 'crc' | 'pi' | 'frontdesk' | 'pharmacy' | 'billing' | 'labs' | 'collector' | 'coder' }[] = [
  { local: 'admin', name: 'Sanjay Patil', role: 'admin' },
  { local: 'crc', name: 'Jaya Raman', role: 'crc' },
  { local: 'pi', name: 'Dr. R. Kunam', role: 'pi' },
  { local: 'frontdesk', name: 'Pooja Nair', role: 'frontdesk' },
  { local: 'pharmacy', name: 'Rohit Shah', role: 'pharmacy' },
  { local: 'billing', name: 'Alok Bansal', role: 'billing' },
  { local: 'labs', name: 'Meenakshi Sundar', role: 'labs' },
  { local: 'pathologist', name: 'Dr. Suresh Babu', role: 'labs' },
  { local: 'collector', name: 'Ravi Kumar', role: 'collector' },
  { local: 'coder', name: 'Asha Menon', role: 'coder' },
]
