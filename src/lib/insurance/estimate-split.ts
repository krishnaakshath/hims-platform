// WS12 R8: the indicative insurer/patient split of an estimate. Pure. Applies, in order:
// room-rent (or ICU) excess per day x days to the patient, then the co-pay share of the rest,
// then anything over the remaining cover (balance, else sum insured). No proportionate
// deduction: the insurer's adjudication remains the truth, so the UI labels this "Indicative".
import { formatPaise } from '@/lib/money'
import { ICU_ROOM_CATEGORY_CODES, type CoverageLimits } from './coverage'

export const ESTIMATE_SPLIT_LABEL = 'Indicative'

/** The service category of per-day room charges (service_catalog.category). */
const ROOM_RENT_CATEGORY = 'room_rent'

function isIcuRoom(code: string | null): boolean {
  return code !== null && (ICU_ROOM_CATEGORY_CODES as readonly string[]).includes(code.trim().toUpperCase())
}

export function applyCoverageToEstimate(i: {
  lines: { amountPaise: number; category: string | null; unitPricePaise: number; quantity: number }[]
  limits: CoverageLimits
  roomCategoryCode: string | null
  lengthOfStayDays: number
}): { totalPaise: number; insurerPaise: number; patientPaise: number; warnings: string[] } {
  const warnings: string[] = []
  const totalPaise = i.lines.reduce((s, l) => s + Math.round(l.amountPaise), 0)
  const icu = isIcuRoom(i.roomCategoryCode)
  const dayLimit = icu ? i.limits.icuLimitPaise : i.limits.roomRentLimitPaise
  const limitName = icu ? 'ICU limit' : 'room rent limit'

  // 1. Room rent (or ICU) above the per-day limit: the excess for every day is the patient's.
  let roomExcess = 0
  let roomDays = 0
  let roomRate = 0
  if (dayLimit !== null) {
    for (const l of i.lines) {
      if (l.category !== ROOM_RENT_CATEGORY || l.unitPricePaise <= dayLimit) continue
      roomExcess += Math.round((l.unitPricePaise - dayLimit) * l.quantity)
      roomDays += l.quantity
      roomRate = Math.max(roomRate, l.unitPricePaise)
    }
    if (roomExcess > 0) {
      warnings.push(`Room charge of ${formatPaise(roomRate)} a day is over the policy ${limitName} of ${formatPaise(dayLimit)} a day: ${formatPaise(roomExcess)} for ${roomDays} day${roomDays === 1 ? '' : 's'} is payable by the patient.`)
    } else if (!i.lines.some((l) => l.category === ROOM_RENT_CATEGORY) && i.lengthOfStayDays > 0) {
      warnings.push(`The estimate has no room charge; the policy ${limitName} of ${formatPaise(dayLimit)} a day applies to the ${i.lengthOfStayDays}-day stay.`)
    }
  }

  // 2. Co-pay on what remains.
  const afterRoom = totalPaise - roomExcess
  const copayPaise = i.limits.copayBp !== null && afterRoom > 0 ? Math.round((afterRoom * i.limits.copayBp) / 10_000) : 0
  if (copayPaise > 0) {
    warnings.push(`Co-pay of ${(i.limits.copayBp! / 100).toString()}% on ${formatPaise(afterRoom)}: ${formatPaise(copayPaise)} is payable by the patient.`)
  }

  // 3. Anything over the remaining cover.
  let insurerPaise = Math.max(0, afterRoom - copayPaise)
  const cap = i.limits.balancePaise ?? i.limits.sumInsuredPaise
  if (cap !== null && insurerPaise > cap) {
    const over = insurerPaise - cap
    const capName = i.limits.balancePaise !== null ? 'remaining balance' : 'sum insured'
    warnings.push(`The estimate is over the policy's ${capName} of ${formatPaise(cap)}: ${formatPaise(over)} is payable by the patient.`)
    insurerPaise = cap
  }

  return { totalPaise, insurerPaise, patientPaise: totalPaise - insurerPaise, warnings }
}
