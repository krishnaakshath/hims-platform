// The hospital form pack (WS7 T4): the consent, admission, discharge,
// medico-legal and vaccination forms an Indian hospital needs on day one,
// in English, Hindi and Kannada.
//
// Spec D10: translations are human-entered. The Hindi and Kannada strings here
// are drafts for the hospital to review; every translated consent body starts
// with DRAFT_TRANSLATION_MARKER, and every consent document is inserted with
// legal_review_status = 'draft'. Question labels fall back to English string by
// string wherever a translation is missing (localiseQuestion).
//
// Answers stay language-neutral: a select answer is always the English option.
//
// Installed by the demo seed and by POST /api/form-templates/hospital-pack;
// both are idempotent by template name and consent document name.

import { eq } from 'drizzle-orm'
import { consentDocuments, formTemplateConsents, formTemplates } from './schema'
import type { FormQuestion, QuestionType } from '../lib/forms/question-model'
import type { WriteExecutor } from '../lib/queries/executor'

export const DRAFT_TRANSLATION_MARKER = '[DRAFT TRANSLATION]'
export const HOSPITAL_FORM_LANGUAGES = ['en', 'hi', 'kn'] as const

export type HospitalFormKey =
  | 'general_consent' | 'surgical_anaesthesia_consent' | 'admission_form'
  | 'discharge_consent' | 'mlc_intimation' | 'vaccination_record'

export interface HospitalPackConsent {
  name: string
  bodyText: string
  translations: { hi?: string; kn?: string }
}

export interface HospitalPackForm {
  key: HospitalFormKey
  name: string
  category: 'Consent Forms' | 'Admission' | 'Medico-legal' | 'Clinical records'
  questions: FormQuestion[]
  consents: HospitalPackConsent[]
}

// ---------------------------------------------------------------------------
// Question builders. A label or option is [English, Hindi, Kannada].

type Tri = readonly [en: string, hi: string, kn: string]

interface QOpts {
  required?: boolean
  sensitive?: boolean
  options?: readonly Tri[]
  /** Options shown in English in every language (e.g. vaccine names). */
  englishOptions?: readonly string[]
  autofillField?: FormQuestion['autofillField']
  min?: number
  max?: number
  visibleIf?: { questionId: string; equals: string }
}

function q(id: string, type: QuestionType, label: Tri, o: QOpts = {}): FormQuestion {
  const out: FormQuestion = {
    id,
    label: label[0],
    type,
    hipaaSensitive: o.sensitive ?? false,
    required: type === 'section' ? false : (o.required ?? false),
    i18n: {
      hi: { label: label[1], ...(o.options ? { options: o.options.map((x) => x[1]) } : {}) },
      kn: { label: label[2], ...(o.options ? { options: o.options.map((x) => x[2]) } : {}) },
    },
  }
  if (o.options) out.options = o.options.map((x) => x[0])
  else if (o.englishOptions) out.options = [...o.englishOptions]
  if (o.autofillField) out.autofillField = o.autofillField
  if (o.min !== undefined) out.min = o.min
  if (o.max !== undefined) out.max = o.max
  if (o.visibleIf) out.visibleIf = o.visibleIf
  return out
}

const section = (id: string, label: Tri, sensitive = false) => q(id, 'section', label, { sensitive })

const YES: Tri = ['Yes', 'हाँ', 'ಹೌದು']
const NO: Tri = ['No', 'नहीं', 'ಇಲ್ಲ']
const SEX: readonly Tri[] = [['Female', 'महिला', 'ಮಹಿಳೆ'], ['Male', 'पुरुष', 'ಪುರುಷ'], ['Other', 'अन्य', 'ಇತರೆ']]

const PATIENT_DETAILS: Tri = ['Patient details', 'रोगी का विवरण', 'ರೋಗಿಯ ವಿವರಗಳು']
const PATIENT_NAME: Tri = ["Patient's full name", 'रोगी का पूरा नाम', 'ರೋಗಿಯ ಪೂರ್ಣ ಹೆಸರು']
const DATE_OF_BIRTH: Tri = ['Date of birth', 'जन्म तिथि', 'ಹುಟ್ಟಿದ ದಿನಾಂಕ']
const SIGNATURE: Tri = ['Signature (type your full name)', 'हस्ताक्षर (अपना पूरा नाम टाइप करें)', 'ಸಹಿ (ನಿಮ್ಮ ಪೂರ್ಣ ಹೆಸರನ್ನು ಟೈಪ್ ಮಾಡಿ)']
const DATE: Tri = ['Date', 'तारीख', 'ದಿನಾಂಕ']
const WITNESS: Tri = ['Name of witness', 'गवाह का नाम', 'ಸಾಕ್ಷಿಯ ಹೆಸರು']

const patientName = () => q('full_name', 'text', PATIENT_NAME, { required: true, sensitive: true, autofillField: 'name' })
const dateOfBirth = (required = true) => q('dob', 'date', DATE_OF_BIRTH, { required, sensitive: true, autofillField: 'dob' })

/** Who is signing, and the name / relationship / reason when it is not the patient. */
function signerQuestions(withGuardian: boolean): FormQuestion[] {
  const PATIENT: Tri = ['Patient', 'रोगी', 'ರೋಗಿ']
  const GUARDIAN: Tri = ['Parent or guardian', 'माता-पिता या अभिभावक', 'ತಂದೆ-ತಾಯಿ ಅಥವಾ ಪೋಷಕರು']
  const RELATIVE: Tri = ['Relative or attendant', 'रिश्तेदार या परिचारक', 'ಸಂಬಂಧಿಕರು ಅಥವಾ ಸಹಾಯಕರು']
  const options = withGuardian ? [PATIENT, GUARDIAN, RELATIVE] : [PATIENT, RELATIVE]
  const out: FormQuestion[] = [
    q('signed_by', 'select', ['Who is signing this form?', 'इस फ़ॉर्म पर कौन हस्ताक्षर कर रहा है?', 'ಈ ಫಾರ್ಮ್‌ಗೆ ಯಾರು ಸಹಿ ಮಾಡುತ್ತಿದ್ದಾರೆ?'], { required: true, options }),
  ]
  if (withGuardian) {
    out.push(q('guardian_name', 'text', ['Name of parent or guardian', 'माता-पिता या अभिभावक का नाम', 'ತಂದೆ-ತಾಯಿ ಅಥವಾ ಪೋಷಕರ ಹೆಸರು'], { required: true, sensitive: true, visibleIf: { questionId: 'signed_by', equals: GUARDIAN[0] } }))
  }
  out.push(
    q('attendant_name', 'text', ['Name of relative or attendant', 'रिश्तेदार या परिचारक का नाम', 'ಸಂಬಂಧಿಕರ ಅಥವಾ ಸಹಾಯಕರ ಹೆಸರು'], { required: true, sensitive: true, visibleIf: { questionId: 'signed_by', equals: RELATIVE[0] } }),
    q('attendant_relation', 'text', ['Relationship to the patient', 'रोगी से संबंध', 'ರೋಗಿಯೊಂದಿಗಿನ ಸಂಬಂಧ'], { required: true, visibleIf: { questionId: 'signed_by', equals: RELATIVE[0] } }),
    q('attendant_reason', 'text', [
      'Why is the patient not signing? (for example, unconscious or too unwell)',
      'रोगी स्वयं हस्ताक्षर क्यों नहीं कर रहा है? (जैसे बेहोश या बहुत अस्वस्थ)',
      'ರೋಗಿ ಸ್ವತಃ ಏಕೆ ಸಹಿ ಮಾಡುತ್ತಿಲ್ಲ? (ಉದಾಹರಣೆಗೆ, ಪ್ರಜ್ಞೆ ಇಲ್ಲ ಅಥವಾ ತೀವ್ರ ಅಸ್ವಸ್ಥತೆ)',
    ], { required: true, sensitive: true, visibleIf: { questionId: 'signed_by', equals: RELATIVE[0] } }),
  )
  return out
}

// ---------------------------------------------------------------------------
// Consent documents (English source; Hindi and Kannada are drafts for review).

const draft = (text: string) => `${DRAFT_TRANSLATION_MARKER} ${text}`

const GENERAL_CONSENT: HospitalPackConsent = {
  name: 'Consent for Admission and Treatment',
  bodyText: `I, the undersigned, consent to my admission to, or treatment at, this hospital, or to the admission or treatment of the patient for whom I am responsible.

1. I agree to the routine examination, investigations (such as blood tests and X-rays), nursing care and medicines that the treating doctors consider necessary.
2. I understand that any surgery, procedure, anaesthesia or blood transfusion needs my separate written consent, except in an emergency where a delay could endanger life.
3. I understand that medicine is not an exact science and that no guarantee has been given to me about the result of any treatment.
4. I agree that my medical records may be seen by the doctors, nurses and staff involved in my care, and shared with my insurer, a government health scheme or the authorities when this is needed for my care, for payment or by law. Otherwise my records will be kept confidential.
5. I have been told about the hospital's charges, and I accept responsibility for paying the hospital bill, except for any amount paid by an insurer or a scheme.
6. I may withdraw this consent at any time by telling the treating doctor. This does not affect treatment already given.

This consent has been explained to me in a language I understand, and I have had the chance to ask questions.`,
  translations: {
    hi: draft(`मैं, नीचे हस्ताक्षर करने वाला/वाली, इस अस्पताल में अपनी भर्ती या उपचार के लिए, अथवा उस रोगी की भर्ती या उपचार के लिए सहमति देता/देती हूँ जिसकी ज़िम्मेदारी मुझ पर है।

1. उपचार करने वाले डॉक्टर जिन सामान्य जाँचों, परीक्षणों (जैसे रक्त जाँच और एक्स-रे), नर्सिंग देखभाल और दवाओं को आवश्यक समझें, उनके लिए मैं सहमत हूँ।
2. मैं समझता/समझती हूँ कि किसी भी शल्य-क्रिया (सर्जरी), प्रक्रिया, एनेस्थीसिया या रक्त चढ़ाने के लिए मेरी अलग से लिखित सहमति ली जाएगी, सिवाय ऐसी आपात स्थिति के जिसमें देरी से जान को ख़तरा हो सकता है।
3. मैं समझता/समझती हूँ कि चिकित्सा एक सटीक विज्ञान नहीं है और मुझे किसी भी उपचार के परिणाम की कोई गारंटी नहीं दी गई है।
4. मैं सहमत हूँ कि मेरी देखभाल से जुड़े डॉक्टर, नर्स और कर्मचारी मेरे चिकित्सा रिकॉर्ड देख सकते हैं, और मेरी देखभाल, भुगतान या कानून के लिए आवश्यक होने पर इन्हें मेरी बीमा कंपनी, सरकारी स्वास्थ्य योजना या अधिकारियों के साथ साझा किया जा सकता है। अन्यथा मेरे रिकॉर्ड गोपनीय रखे जाएँगे।
5. मुझे अस्पताल के शुल्क के बारे में बताया गया है। बीमा कंपनी या योजना द्वारा चुकाई जाने वाली राशि को छोड़कर, अस्पताल के बिल के भुगतान की ज़िम्मेदारी मैं स्वीकार करता/करती हूँ।
6. उपचार करने वाले डॉक्टर को बताकर मैं किसी भी समय यह सहमति वापस ले सकता/सकती हूँ। इसका पहले से दिए गए उपचार पर कोई प्रभाव नहीं पड़ेगा।

यह सहमति मुझे ऐसी भाषा में समझाई गई है जिसे मैं समझता/समझती हूँ, और मुझे प्रश्न पूछने का अवसर दिया गया है।`),
    kn: draft(`ಕೆಳಗೆ ಸಹಿ ಮಾಡಿರುವ ನಾನು, ಈ ಆಸ್ಪತ್ರೆಯಲ್ಲಿ ನನ್ನ ದಾಖಲಾತಿ ಅಥವಾ ಚಿಕಿತ್ಸೆಗೆ, ಅಥವಾ ನನ್ನ ಜವಾಬ್ದಾರಿಯಲ್ಲಿರುವ ರೋಗಿಯ ದಾಖಲಾತಿ ಅಥವಾ ಚಿಕಿತ್ಸೆಗೆ ಸಮ್ಮತಿ ನೀಡುತ್ತೇನೆ.

1. ಚಿಕಿತ್ಸೆ ನೀಡುವ ವೈದ್ಯರು ಅಗತ್ಯವೆಂದು ಪರಿಗಣಿಸುವ ಸಾಮಾನ್ಯ ತಪಾಸಣೆ, ಪರೀಕ್ಷೆಗಳು (ರಕ್ತ ಪರೀಕ್ಷೆ ಮತ್ತು ಎಕ್ಸ್-ರೇ ಮುಂತಾದವು), ಶುಶ್ರೂಷೆ ಮತ್ತು ಔಷಧಿಗಳಿಗೆ ನಾನು ಒಪ್ಪುತ್ತೇನೆ.
2. ಯಾವುದೇ ಶಸ್ತ್ರಚಿಕಿತ್ಸೆ, ಪ್ರಕ್ರಿಯೆ, ಅರಿವಳಿಕೆ ಅಥವಾ ರಕ್ತ ವರ್ಗಾವಣೆಗೆ ನನ್ನ ಪ್ರತ್ಯೇಕ ಲಿಖಿತ ಸಮ್ಮತಿ ಬೇಕು ಎಂದು ನಾನು ಅರ್ಥಮಾಡಿಕೊಂಡಿದ್ದೇನೆ. ವಿಳಂಬದಿಂದ ಜೀವಕ್ಕೆ ಅಪಾಯವಾಗಬಹುದಾದ ತುರ್ತು ಪರಿಸ್ಥಿತಿ ಮಾತ್ರ ಇದಕ್ಕೆ ಹೊರತು.
3. ವೈದ್ಯಶಾಸ್ತ್ರವು ನಿಖರವಾದ ವಿಜ್ಞಾನವಲ್ಲ ಮತ್ತು ಯಾವುದೇ ಚಿಕಿತ್ಸೆಯ ಫಲಿತಾಂಶದ ಬಗ್ಗೆ ನನಗೆ ಯಾವುದೇ ಖಾತರಿ ನೀಡಲಾಗಿಲ್ಲ ಎಂದು ನಾನು ಅರ್ಥಮಾಡಿಕೊಂಡಿದ್ದೇನೆ.
4. ನನ್ನ ಆರೈಕೆಯಲ್ಲಿ ತೊಡಗಿರುವ ವೈದ್ಯರು, ದಾದಿಯರು ಮತ್ತು ಸಿಬ್ಬಂದಿ ನನ್ನ ವೈದ್ಯಕೀಯ ದಾಖಲೆಗಳನ್ನು ನೋಡಬಹುದು ಎಂದು, ಮತ್ತು ನನ್ನ ಆರೈಕೆ, ಪಾವತಿ ಅಥವಾ ಕಾನೂನಿನ ಅಗತ್ಯಕ್ಕಾಗಿ ಅವುಗಳನ್ನು ನನ್ನ ವಿಮಾ ಕಂಪನಿ, ಸರ್ಕಾರಿ ಆರೋಗ್ಯ ಯೋಜನೆ ಅಥವಾ ಅಧಿಕಾರಿಗಳೊಂದಿಗೆ ಹಂಚಿಕೊಳ್ಳಬಹುದು ಎಂದು ನಾನು ಒಪ್ಪುತ್ತೇನೆ. ಇಲ್ಲದಿದ್ದರೆ ನನ್ನ ದಾಖಲೆಗಳನ್ನು ಗೋಪ್ಯವಾಗಿ ಇಡಲಾಗುತ್ತದೆ.
5. ಆಸ್ಪತ್ರೆಯ ಶುಲ್ಕಗಳ ಬಗ್ಗೆ ನನಗೆ ತಿಳಿಸಲಾಗಿದೆ. ವಿಮಾ ಕಂಪನಿ ಅಥವಾ ಯೋಜನೆಯು ಪಾವತಿಸುವ ಮೊತ್ತವನ್ನು ಹೊರತುಪಡಿಸಿ, ಆಸ್ಪತ್ರೆಯ ಬಿಲ್ ಪಾವತಿಸುವ ಜವಾಬ್ದಾರಿಯನ್ನು ನಾನು ಒಪ್ಪಿಕೊಳ್ಳುತ್ತೇನೆ.
6. ಚಿಕಿತ್ಸೆ ನೀಡುವ ವೈದ್ಯರಿಗೆ ತಿಳಿಸುವ ಮೂಲಕ ನಾನು ಯಾವಾಗ ಬೇಕಾದರೂ ಈ ಸಮ್ಮತಿಯನ್ನು ಹಿಂಪಡೆಯಬಹುದು. ಇದು ಈಗಾಗಲೇ ನೀಡಿದ ಚಿಕಿತ್ಸೆಯ ಮೇಲೆ ಪರಿಣಾಮ ಬೀರುವುದಿಲ್ಲ.

ಈ ಸಮ್ಮತಿಯನ್ನು ನನಗೆ ಅರ್ಥವಾಗುವ ಭಾಷೆಯಲ್ಲಿ ವಿವರಿಸಲಾಗಿದೆ ಮತ್ತು ಪ್ರಶ್ನೆಗಳನ್ನು ಕೇಳಲು ನನಗೆ ಅವಕಾಶ ನೀಡಲಾಗಿದೆ.`),
  },
}

const SURGERY_CONSENT: HospitalPackConsent = {
  name: 'Consent for Surgery or Procedure',
  bodyText: `1. The treating doctor has explained to me, in a language I understand, my condition, the surgery or procedure proposed, its expected benefits, its common and serious risks and possible complications, the alternatives available (including not having it), and what may happen if I do not have it.
2. I understand that complications can occur even when the procedure is done with due care, and that no guarantee has been given to me about the result.
3. I agree that if an unexpected condition is found during the procedure, the doctors may carry out any additional procedure that is immediately necessary to save life or prevent serious harm.
4. I agree that tissue or organs removed during the procedure may be sent for examination and then disposed of by the hospital in accordance with the biomedical waste rules.
5. I understand that the procedure will be carried out by the named surgeon together with the surgical team, under the surgeon's supervision.
6. I have had the chance to ask questions, and they have been answered. I give this consent freely.`,
  translations: {
    hi: draft(`1. उपचार करने वाले डॉक्टर ने मुझे ऐसी भाषा में, जिसे मैं समझता/समझती हूँ, मेरी स्थिति, प्रस्तावित शल्य-क्रिया या प्रक्रिया, उसके अपेक्षित लाभ, उसके सामान्य और गंभीर जोखिम तथा संभावित जटिलताएँ, उपलब्ध विकल्प (इसे न कराने सहित), और इसे न कराने पर क्या हो सकता है, यह सब समझाया है।
2. मैं समझता/समझती हूँ कि पूरी सावधानी से की गई प्रक्रिया में भी जटिलताएँ हो सकती हैं, और मुझे परिणाम की कोई गारंटी नहीं दी गई है।
3. मैं सहमत हूँ कि यदि प्रक्रिया के दौरान कोई अप्रत्याशित स्थिति मिलती है, तो डॉक्टर जान बचाने या गंभीर हानि रोकने के लिए तुरंत आवश्यक कोई भी अतिरिक्त प्रक्रिया कर सकते हैं।
4. मैं सहमत हूँ कि प्रक्रिया के दौरान निकाले गए ऊतक या अंग जाँच के लिए भेजे जा सकते हैं और फिर अस्पताल द्वारा जैव-चिकित्सा अपशिष्ट नियमों के अनुसार नष्ट किए जा सकते हैं।
5. मैं समझता/समझती हूँ कि यह प्रक्रिया नामित सर्जन द्वारा, सर्जिकल टीम के साथ, सर्जन की देखरेख में की जाएगी।
6. मुझे प्रश्न पूछने का अवसर मिला है और मेरे प्रश्नों के उत्तर दिए गए हैं। मैं यह सहमति अपनी इच्छा से दे रहा/रही हूँ।`),
    kn: draft(`1. ಚಿಕಿತ್ಸೆ ನೀಡುವ ವೈದ್ಯರು ನನಗೆ ಅರ್ಥವಾಗುವ ಭಾಷೆಯಲ್ಲಿ ನನ್ನ ಸ್ಥಿತಿ, ಉದ್ದೇಶಿತ ಶಸ್ತ್ರಚಿಕಿತ್ಸೆ ಅಥವಾ ಪ್ರಕ್ರಿಯೆ, ಅದರ ನಿರೀಕ್ಷಿತ ಪ್ರಯೋಜನಗಳು, ಅದರ ಸಾಮಾನ್ಯ ಮತ್ತು ಗಂಭೀರ ಅಪಾಯಗಳು ಹಾಗೂ ಸಂಭವನೀಯ ತೊಡಕುಗಳು, ಲಭ್ಯವಿರುವ ಪರ್ಯಾಯಗಳು (ಇದನ್ನು ಮಾಡಿಸಿಕೊಳ್ಳದಿರುವುದೂ ಸೇರಿದಂತೆ), ಮತ್ತು ಇದನ್ನು ಮಾಡಿಸಿಕೊಳ್ಳದಿದ್ದರೆ ಏನಾಗಬಹುದು ಎಂಬುದನ್ನು ವಿವರಿಸಿದ್ದಾರೆ.
2. ಎಚ್ಚರಿಕೆಯಿಂದ ಮಾಡಿದ ಪ್ರಕ್ರಿಯೆಯಲ್ಲೂ ತೊಡಕುಗಳು ಉಂಟಾಗಬಹುದು ಮತ್ತು ಫಲಿತಾಂಶದ ಬಗ್ಗೆ ನನಗೆ ಯಾವುದೇ ಖಾತರಿ ನೀಡಲಾಗಿಲ್ಲ ಎಂದು ನಾನು ಅರ್ಥಮಾಡಿಕೊಂಡಿದ್ದೇನೆ.
3. ಪ್ರಕ್ರಿಯೆಯ ಸಮಯದಲ್ಲಿ ಅನಿರೀಕ್ಷಿತ ಸ್ಥಿತಿ ಕಂಡುಬಂದರೆ, ಜೀವ ಉಳಿಸಲು ಅಥವಾ ಗಂಭೀರ ಹಾನಿಯನ್ನು ತಡೆಯಲು ತಕ್ಷಣ ಅಗತ್ಯವಿರುವ ಯಾವುದೇ ಹೆಚ್ಚುವರಿ ಪ್ರಕ್ರಿಯೆಯನ್ನು ವೈದ್ಯರು ಮಾಡಬಹುದು ಎಂದು ನಾನು ಒಪ್ಪುತ್ತೇನೆ.
4. ಪ್ರಕ್ರಿಯೆಯ ಸಮಯದಲ್ಲಿ ತೆಗೆದ ಅಂಗಾಂಶ ಅಥವಾ ಅಂಗಗಳನ್ನು ಪರೀಕ್ಷೆಗೆ ಕಳುಹಿಸಬಹುದು ಮತ್ತು ನಂತರ ಜೈವಿಕ-ವೈದ್ಯಕೀಯ ತ್ಯಾಜ್ಯ ನಿಯಮಗಳ ಪ್ರಕಾರ ಆಸ್ಪತ್ರೆಯು ವಿಲೇವಾರಿ ಮಾಡಬಹುದು ಎಂದು ನಾನು ಒಪ್ಪುತ್ತೇನೆ.
5. ಈ ಪ್ರಕ್ರಿಯೆಯನ್ನು ಹೆಸರಿಸಲಾದ ಶಸ್ತ್ರಚಿಕಿತ್ಸಕರು ಶಸ್ತ್ರಚಿಕಿತ್ಸಾ ತಂಡದೊಂದಿಗೆ, ಅವರ ಮೇಲ್ವಿಚಾರಣೆಯಲ್ಲಿ ನಡೆಸುತ್ತಾರೆ ಎಂದು ನಾನು ಅರ್ಥಮಾಡಿಕೊಂಡಿದ್ದೇನೆ.
6. ಪ್ರಶ್ನೆಗಳನ್ನು ಕೇಳಲು ನನಗೆ ಅವಕಾಶ ಸಿಕ್ಕಿದೆ ಮತ್ತು ಅವುಗಳಿಗೆ ಉತ್ತರ ನೀಡಲಾಗಿದೆ. ನಾನು ಈ ಸಮ್ಮತಿಯನ್ನು ಸ್ವಇಚ್ಛೆಯಿಂದ ನೀಡುತ್ತಿದ್ದೇನೆ.`),
  },
}

const ANAESTHESIA_CONSENT: HospitalPackConsent = {
  name: 'Consent for Anaesthesia',
  bodyText: `1. The anaesthetist has explained to me the type of anaesthesia planned, the reasons for it, and the alternatives.
2. I understand that anaesthesia carries risks, which include nausea, sore throat, headache, damage to teeth, allergic reactions, breathing or heart problems and, rarely, serious complications that can be life-threatening.
3. I agree that the anaesthetist may change the type of anaesthesia, or give additional medicines, fluids or blood, if this becomes necessary for my safety during the procedure.
4. I have told the doctors, as far as I know them, about my illnesses, allergies and medicines, and when I last ate or drank.
5. I have had the chance to ask questions, and they have been answered. I give this consent freely.`,
  translations: {
    hi: draft(`1. एनेस्थेटिस्ट (निश्चेतना विशेषज्ञ) ने मुझे नियोजित एनेस्थीसिया का प्रकार, उसके कारण और उसके विकल्प समझाए हैं।
2. मैं समझता/समझती हूँ कि एनेस्थीसिया में जोखिम होते हैं, जिनमें जी मिचलाना, गले में खराश, सिरदर्द, दाँतों को नुकसान, एलर्जी, साँस या हृदय से जुड़ी समस्याएँ, और कभी-कभार जानलेवा गंभीर जटिलताएँ शामिल हैं।
3. मैं सहमत हूँ कि प्रक्रिया के दौरान मेरी सुरक्षा के लिए आवश्यक होने पर एनेस्थेटिस्ट एनेस्थीसिया का प्रकार बदल सकते हैं, या अतिरिक्त दवाएँ, तरल पदार्थ या रक्त दे सकते हैं।
4. जहाँ तक मुझे जानकारी है, मैंने डॉक्टरों को अपनी बीमारियों, एलर्जी और दवाओं के बारे में, और मैंने आख़िरी बार कब खाया या पिया, यह बता दिया है।
5. मुझे प्रश्न पूछने का अवसर मिला है और मेरे प्रश्नों के उत्तर दिए गए हैं। मैं यह सहमति अपनी इच्छा से दे रहा/रही हूँ।`),
    kn: draft(`1. ಅರಿವಳಿಕೆ ತಜ್ಞರು ಯೋಜಿತ ಅರಿವಳಿಕೆಯ ಪ್ರಕಾರ, ಅದರ ಕಾರಣಗಳು ಮತ್ತು ಪರ್ಯಾಯಗಳನ್ನು ನನಗೆ ವಿವರಿಸಿದ್ದಾರೆ.
2. ಅರಿವಳಿಕೆಯಲ್ಲಿ ಅಪಾಯಗಳಿವೆ ಎಂದು ನಾನು ಅರ್ಥಮಾಡಿಕೊಂಡಿದ್ದೇನೆ. ಅವುಗಳಲ್ಲಿ ವಾಕರಿಕೆ, ಗಂಟಲು ನೋವು, ತಲೆನೋವು, ಹಲ್ಲುಗಳಿಗೆ ಹಾನಿ, ಅಲರ್ಜಿ, ಉಸಿರಾಟ ಅಥವಾ ಹೃದಯದ ತೊಂದರೆಗಳು, ಮತ್ತು ಅಪರೂಪವಾಗಿ ಜೀವಕ್ಕೆ ಅಪಾಯಕಾರಿಯಾದ ಗಂಭೀರ ತೊಡಕುಗಳು ಸೇರಿವೆ.
3. ಪ್ರಕ್ರಿಯೆಯ ಸಮಯದಲ್ಲಿ ನನ್ನ ಸುರಕ್ಷತೆಗೆ ಅಗತ್ಯವಾದರೆ, ಅರಿವಳಿಕೆ ತಜ್ಞರು ಅರಿವಳಿಕೆಯ ಪ್ರಕಾರವನ್ನು ಬದಲಾಯಿಸಬಹುದು ಅಥವಾ ಹೆಚ್ಚುವರಿ ಔಷಧಿಗಳು, ದ್ರವಗಳು ಅಥವಾ ರಕ್ತವನ್ನು ನೀಡಬಹುದು ಎಂದು ನಾನು ಒಪ್ಪುತ್ತೇನೆ.
4. ನನಗೆ ತಿಳಿದಿರುವಷ್ಟು ಮಟ್ಟಿಗೆ, ನನ್ನ ಕಾಯಿಲೆಗಳು, ಅಲರ್ಜಿಗಳು, ಔಷಧಿಗಳು ಮತ್ತು ನಾನು ಕೊನೆಯದಾಗಿ ಯಾವಾಗ ತಿಂದೆ ಅಥವಾ ಕುಡಿದೆ ಎಂಬುದನ್ನು ವೈದ್ಯರಿಗೆ ತಿಳಿಸಿದ್ದೇನೆ.
5. ಪ್ರಶ್ನೆಗಳನ್ನು ಕೇಳಲು ನನಗೆ ಅವಕಾಶ ಸಿಕ್ಕಿದೆ ಮತ್ತು ಅವುಗಳಿಗೆ ಉತ್ತರ ನೀಡಲಾಗಿದೆ. ನಾನು ಈ ಸಮ್ಮತಿಯನ್ನು ಸ್ವಇಚ್ಛೆಯಿಂದ ನೀಡುತ್ತಿದ್ದೇನೆ.`),
  },
}

const DISCHARGE_CONSENT: HospitalPackConsent = {
  name: 'Consent and Acknowledgement at Discharge',
  bodyText: `If I am discharged on medical advice:
1. I have received my discharge summary, and my medicines, diet, warning signs and follow-up visits have been explained to me.
2. I will contact the hospital or return at once if any of the warning signs explained to me appear.

If I am leaving against medical advice:
3. The treating doctor has explained my present condition, the treatment still advised, and the risks of leaving before it is complete, which may include worsening of my condition, permanent harm or death.
4. I am leaving of my own free will, against the advice of the treating doctor, and I take full responsibility for this decision and its consequences.
5. I understand that I may return to this hospital for treatment at any time.

In either case, I confirm that I have received my belongings and my documents.`,
  translations: {
    hi: draft(`यदि मुझे डॉक्टर की सलाह पर छुट्टी दी जा रही है:
1. मुझे मेरा डिस्चार्ज सारांश मिल गया है, और मेरी दवाएँ, आहार, ख़तरे के लक्षण और आगे की जाँच (फ़ॉलो-अप) के बारे में मुझे समझाया गया है।
2. मुझे समझाए गए ख़तरे के लक्षणों में से कोई भी लक्षण दिखने पर मैं तुरंत अस्पताल से संपर्क करूँगा/करूँगी या वापस आऊँगा/आऊँगी।

यदि मैं डॉक्टर की सलाह के विरुद्ध अस्पताल छोड़ रहा/रही हूँ:
3. उपचार करने वाले डॉक्टर ने मुझे मेरी वर्तमान स्थिति, अभी भी सुझाया गया उपचार, और उपचार पूरा होने से पहले अस्पताल छोड़ने के जोखिम समझाए हैं, जिनमें मेरी स्थिति का बिगड़ना, स्थायी हानि या मृत्यु शामिल हो सकती है।
4. मैं उपचार करने वाले डॉक्टर की सलाह के विरुद्ध, अपनी इच्छा से अस्पताल छोड़ रहा/रही हूँ, और इस निर्णय तथा इसके परिणामों की पूरी ज़िम्मेदारी मैं लेता/लेती हूँ।
5. मैं समझता/समझती हूँ कि मैं उपचार के लिए किसी भी समय इस अस्पताल में वापस आ सकता/सकती हूँ।

दोनों ही स्थितियों में, मैं पुष्टि करता/करती हूँ कि मुझे मेरा सामान और मेरे दस्तावेज़ मिल गए हैं।`),
    kn: draft(`ವೈದ್ಯರ ಸಲಹೆಯ ಮೇರೆಗೆ ನನ್ನನ್ನು ಬಿಡುಗಡೆ ಮಾಡುತ್ತಿದ್ದರೆ:
1. ನನ್ನ ಬಿಡುಗಡೆ ಸಾರಾಂಶ (ಡಿಸ್ಚಾರ್ಜ್ ಸಮ್ಮರಿ) ನನಗೆ ದೊರೆತಿದೆ, ಮತ್ತು ನನ್ನ ಔಷಧಿಗಳು, ಆಹಾರ, ಅಪಾಯದ ಲಕ್ಷಣಗಳು ಹಾಗೂ ಮುಂದಿನ ತಪಾಸಣೆ ಭೇಟಿಗಳನ್ನು ನನಗೆ ವಿವರಿಸಲಾಗಿದೆ.
2. ನನಗೆ ವಿವರಿಸಿದ ಯಾವುದೇ ಅಪಾಯದ ಲಕ್ಷಣ ಕಂಡುಬಂದರೆ ನಾನು ತಕ್ಷಣ ಆಸ್ಪತ್ರೆಯನ್ನು ಸಂಪರ್ಕಿಸುತ್ತೇನೆ ಅಥವಾ ಹಿಂತಿರುಗುತ್ತೇನೆ.

ವೈದ್ಯರ ಸಲಹೆಗೆ ವಿರುದ್ಧವಾಗಿ ನಾನು ಆಸ್ಪತ್ರೆಯಿಂದ ಹೊರಡುತ್ತಿದ್ದರೆ:
3. ಚಿಕಿತ್ಸೆ ನೀಡುವ ವೈದ್ಯರು ನನ್ನ ಪ್ರಸ್ತುತ ಸ್ಥಿತಿ, ಇನ್ನೂ ಸಲಹೆ ನೀಡಲಾದ ಚಿಕಿತ್ಸೆ, ಮತ್ತು ಚಿಕಿತ್ಸೆ ಪೂರ್ಣಗೊಳ್ಳುವ ಮೊದಲೇ ಹೊರಡುವುದರ ಅಪಾಯಗಳನ್ನು ವಿವರಿಸಿದ್ದಾರೆ. ಅವುಗಳಲ್ಲಿ ನನ್ನ ಸ್ಥಿತಿ ಹದಗೆಡುವುದು, ಶಾಶ್ವತ ಹಾನಿ ಅಥವಾ ಮರಣ ಸೇರಿರಬಹುದು.
4. ಚಿಕಿತ್ಸೆ ನೀಡುವ ವೈದ್ಯರ ಸಲಹೆಗೆ ವಿರುದ್ಧವಾಗಿ, ನನ್ನ ಸ್ವಇಚ್ಛೆಯಿಂದ ನಾನು ಹೊರಡುತ್ತಿದ್ದೇನೆ, ಮತ್ತು ಈ ನಿರ್ಧಾರ ಹಾಗೂ ಅದರ ಪರಿಣಾಮಗಳ ಸಂಪೂರ್ಣ ಜವಾಬ್ದಾರಿಯನ್ನು ನಾನು ಹೊರುತ್ತೇನೆ.
5. ಚಿಕಿತ್ಸೆಗಾಗಿ ನಾನು ಯಾವಾಗ ಬೇಕಾದರೂ ಈ ಆಸ್ಪತ್ರೆಗೆ ಹಿಂತಿರುಗಬಹುದು ಎಂದು ನಾನು ಅರ್ಥಮಾಡಿಕೊಂಡಿದ್ದೇನೆ.

ಎರಡೂ ಸಂದರ್ಭಗಳಲ್ಲಿ, ನನ್ನ ವಸ್ತುಗಳು ಮತ್ತು ನನ್ನ ದಾಖಲೆಗಳು ನನಗೆ ದೊರೆತಿವೆ ಎಂದು ನಾನು ದೃಢೀಕರಿಸುತ್ತೇನೆ.`),
  },
}

// ---------------------------------------------------------------------------
// The forms.

const ANAESTHESIA_TYPES: readonly Tri[] = [
  ['General anaesthesia', 'सामान्य एनेस्थीसिया (पूरी बेहोशी)', 'ಸಾಮಾನ್ಯ ಅರಿವಳಿಕೆ (ಪೂರ್ಣ ಪ್ರಜ್ಞಾಹೀನತೆ)'],
  ['Spinal or epidural anaesthesia', 'स्पाइनल या एपिड्यूरल एनेस्थीसिया', 'ಸ್ಪೈನಲ್ ಅಥವಾ ಎಪಿಡ್ಯೂರಲ್ ಅರಿವಳಿಕೆ'],
  ['Regional nerve block', 'नस (नर्व) ब्लॉक द्वारा अंग-विशेष को सुन्न करना', 'ನರ ತಡೆ (ನರ್ವ್ ಬ್ಲಾಕ್) ಮೂಲಕ ಭಾಗಶಃ ಅರಿವಳಿಕೆ'],
  ['Local anaesthesia', 'स्थानीय एनेस्थीसिया (केवल उस जगह को सुन्न करना)', 'ಸ್ಥಳೀಯ ಅರಿವಳಿಕೆ (ಆ ಜಾಗವನ್ನು ಮಾತ್ರ ಮರಗಟ್ಟಿಸುವುದು)'],
  ['Sedation', 'बेहोशी की हल्की दवा (सेडेशन)', 'ಲಘು ನಿದ್ರಾಜನಕ (ಸೆಡೇಶನ್)'],
  ['No anaesthesia', 'कोई एनेस्थीसिया नहीं', 'ಅರಿವಳಿಕೆ ಇಲ್ಲ'],
]

const VACCINES = [
  'BCG', 'Hepatitis B', 'OPV (oral polio)', 'IPV (injectable polio)', 'Pentavalent (DPT-HepB-Hib)', 'Rotavirus',
  'PCV (pneumococcal)', 'MR (measles-rubella)', 'JE (Japanese encephalitis)', 'DPT booster', 'Td (tetanus-diphtheria)',
  'Typhoid conjugate', 'Hepatitis A', 'Varicella (chickenpox)', 'HPV', 'Influenza', 'COVID-19', 'Rabies', 'Other',
] as const

export const HOSPITAL_FORM_PACK: readonly HospitalPackForm[] = [
  {
    key: 'general_consent',
    name: 'General Consent for Admission and Treatment',
    category: 'Consent Forms',
    questions: [
      section('s_patient', PATIENT_DETAILS),
      patientName(),
      dateOfBirth(),
      ...signerQuestions(true),
      section('s_consent', ['Consent', 'सहमति', 'ಸಮ್ಮತಿ']),
      q('understood', 'checkbox', [
        'I have read the consent above, or it has been read out to me in a language I understand, and I have had the chance to ask questions',
        'मैंने ऊपर दी गई सहमति पढ़ ली है, या यह मुझे मेरी समझ की भाषा में पढ़कर सुनाई गई है, और मुझे प्रश्न पूछने का अवसर मिला है',
        'ಮೇಲಿನ ಸಮ್ಮತಿಯನ್ನು ನಾನು ಓದಿದ್ದೇನೆ, ಅಥವಾ ನನಗೆ ಅರ್ಥವಾಗುವ ಭಾಷೆಯಲ್ಲಿ ಓದಿ ಹೇಳಲಾಗಿದೆ, ಮತ್ತು ಪ್ರಶ್ನೆಗಳನ್ನು ಕೇಳಲು ನನಗೆ ಅವಕಾಶ ಸಿಕ್ಕಿದೆ',
      ], { required: true }),
      q('agree_treatment', 'checkbox', [
        "I agree to routine examination, investigations and treatment by the hospital's doctors and staff",
        'मैं अस्पताल के डॉक्टरों और कर्मचारियों द्वारा सामान्य जाँच, परीक्षण और उपचार के लिए सहमत हूँ',
        'ಆಸ್ಪತ್ರೆಯ ವೈದ್ಯರು ಮತ್ತು ಸಿಬ್ಬಂದಿಯಿಂದ ಸಾಮಾನ್ಯ ತಪಾಸಣೆ, ಪರೀಕ್ಷೆಗಳು ಮತ್ತು ಚಿಕಿತ್ಸೆಗೆ ನಾನು ಒಪ್ಪುತ್ತೇನೆ',
      ], { required: true }),
      q('agree_records', 'checkbox', [
        'I agree that my health records may be shared as described above',
        'मैं सहमत हूँ कि मेरे स्वास्थ्य रिकॉर्ड ऊपर बताए अनुसार साझा किए जा सकते हैं',
        'ಮೇಲೆ ವಿವರಿಸಿದಂತೆ ನನ್ನ ಆರೋಗ್ಯ ದಾಖಲೆಗಳನ್ನು ಹಂಚಿಕೊಳ್ಳಬಹುದು ಎಂದು ನಾನು ಒಪ್ಪುತ್ತೇನೆ',
      ], { required: true }),
      q('signature', 'signature', SIGNATURE, { required: true, sensitive: true }),
      q('sign_date', 'date', DATE, { required: true }),
    ],
    consents: [GENERAL_CONSENT],
  },
  {
    key: 'surgical_anaesthesia_consent',
    name: 'Consent for Surgery and Anaesthesia',
    category: 'Consent Forms',
    questions: [
      section('s_patient', PATIENT_DETAILS),
      patientName(),
      dateOfBirth(),
      section('s_procedure', ['Surgery or procedure', 'शल्य-क्रिया या प्रक्रिया', 'ಶಸ್ತ್ರಚಿಕಿತ್ಸೆ ಅಥವಾ ಪ್ರಕ್ರಿಯೆ']),
      q('procedure', 'text', ['Name of the surgery or procedure', 'शल्य-क्रिया या प्रक्रिया का नाम', 'ಶಸ್ತ್ರಚಿಕಿತ್ಸೆ ಅಥವಾ ಪ್ರಕ್ರಿಯೆಯ ಹೆಸರು'], { required: true, sensitive: true }),
      q('surgeon', 'text', ['Name of the surgeon', 'सर्जन का नाम', 'ಶಸ್ತ್ರಚಿಕಿತ್ಸಕರ ಹೆಸರು'], { required: true }),
      q('risks_explained', 'checkbox', [
        'The nature of the procedure, its expected benefits, its risks and possible complications, and the alternatives have been explained to me',
        'प्रक्रिया का स्वरूप, उसके अपेक्षित लाभ, उसके जोखिम और संभावित जटिलताएँ, तथा विकल्प मुझे समझाए गए हैं',
        'ಪ್ರಕ್ರಿಯೆಯ ಸ್ವರೂಪ, ಅದರ ನಿರೀಕ್ಷಿತ ಪ್ರಯೋಜನಗಳು, ಅಪಾಯಗಳು ಮತ್ತು ಸಂಭವನೀಯ ತೊಡಕುಗಳು, ಹಾಗೂ ಪರ್ಯಾಯಗಳನ್ನು ನನಗೆ ವಿವರಿಸಲಾಗಿದೆ',
      ], { required: true }),
      q('questions_answered', 'checkbox', [
        'My questions have been answered',
        'मेरे प्रश्नों के उत्तर दे दिए गए हैं',
        'ನನ್ನ ಪ್ರಶ್ನೆಗಳಿಗೆ ಉತ್ತರ ನೀಡಲಾಗಿದೆ',
      ], { required: true }),
      section('s_anaesthesia', ['Anaesthesia', 'एनेस्थीसिया (निश्चेतना)', 'ಅರಿವಳಿಕೆ']),
      q('anaesthesia_type', 'select', ['Type of anaesthesia planned', 'नियोजित एनेस्थीसिया का प्रकार', 'ಯೋಜಿತ ಅರಿವಳಿಕೆಯ ಪ್ರಕಾರ'], { required: true, options: ANAESTHESIA_TYPES }),
      q('anaesthetist', 'text', ['Name of the anaesthetist', 'एनेस्थेटिस्ट (निश्चेतना विशेषज्ञ) का नाम', 'ಅರಿವಳಿಕೆ ತಜ್ಞರ ಹೆಸರು']),
      q('anaesthesia_risks_explained', 'checkbox', [
        'The risks of anaesthesia have been explained to me',
        'एनेस्थीसिया के जोखिम मुझे समझाए गए हैं',
        'ಅರಿವಳಿಕೆಯ ಅಪಾಯಗಳನ್ನು ನನಗೆ ವಿವರಿಸಲಾಗಿದೆ',
      ]),
      q('blood_transfusion', 'select', [
        'Do you agree to a blood transfusion if it becomes necessary?',
        'आवश्यकता पड़ने पर क्या आप रक्त चढ़ाने के लिए सहमत हैं?',
        'ಅಗತ್ಯವಾದರೆ ರಕ್ತ ವರ್ಗಾವಣೆಗೆ ನೀವು ಒಪ್ಪುತ್ತೀರಾ?',
      ], { required: true, sensitive: true, options: [YES, NO] }),
      section('s_sign', ['Signature', 'हस्ताक्षर', 'ಸಹಿ']),
      ...signerQuestions(true),
      q('signature', 'signature', SIGNATURE, { required: true, sensitive: true }),
      q('witness_name', 'text', WITNESS, { required: true }),
      q('sign_date', 'date', DATE, { required: true }),
    ],
    consents: [SURGERY_CONSENT, ANAESTHESIA_CONSENT],
  },
  {
    key: 'admission_form',
    name: 'Admission Form',
    category: 'Admission',
    questions: [
      section('s_patient', PATIENT_DETAILS),
      patientName(),
      dateOfBirth(),
      q('sex', 'select', ['Sex', 'लिंग', 'ಲಿಂಗ'], { required: true, options: SEX }),
      q('mobile', 'phone', ['Mobile number', 'मोबाइल नंबर', 'ಮೊಬೈಲ್ ಸಂಖ್ಯೆ'], { required: true, sensitive: true, autofillField: 'phone' }),
      q('address', 'textarea', ['Residential address with PIN code', 'पिन कोड सहित घर का पता', 'ಪಿನ್ ಕೋಡ್ ಸಹಿತ ಮನೆಯ ವಿಳಾಸ'], { required: true, sensitive: true }),
      q('abha', 'text', ['ABHA number (if you have one)', 'आभा (ABHA) नंबर (यदि आपके पास है)', 'ಆಭಾ (ABHA) ಸಂಖ್ಯೆ (ನಿಮ್ಮ ಬಳಿ ಇದ್ದರೆ)'], { sensitive: true }),
      section('s_contact', ['Emergency contact', 'आपातकालीन संपर्क', 'ತುರ್ತು ಸಂಪರ್ಕ']),
      q('ec_name', 'text', ['Name of emergency contact', 'आपातकालीन संपर्क व्यक्ति का नाम', 'ತುರ್ತು ಸಂಪರ್ಕ ವ್ಯಕ್ತಿಯ ಹೆಸರು'], { required: true, sensitive: true }),
      q('ec_relation', 'text', ['Relationship to the patient', 'रोगी से संबंध', 'ರೋಗಿಯೊಂದಿಗಿನ ಸಂಬಂಧ'], { required: true }),
      q('ec_mobile', 'phone', ['Mobile number of emergency contact', 'आपातकालीन संपर्क व्यक्ति का मोबाइल नंबर', 'ತುರ್ತು ಸಂಪರ್ಕ ವ್ಯಕ್ತಿಯ ಮೊಬೈಲ್ ಸಂಖ್ಯೆ'], { required: true, sensitive: true }),
      section('s_admission', ['Admission details', 'भर्ती का विवरण', 'ದಾಖಲಾತಿ ವಿವರಗಳು']),
      q('admission_type', 'select', ['Type of admission', 'भर्ती का प्रकार', 'ದಾಖಲಾತಿಯ ಪ್ರಕಾರ'], {
        required: true,
        options: [['Planned', 'पूर्व-निर्धारित', 'ಪೂರ್ವನಿಗದಿತ'], ['Emergency', 'आपातकालीन', 'ತುರ್ತು'], ['Day care', 'डे केयर (उसी दिन छुट्टी)', 'ಡೇ ಕೇರ್ (ಅದೇ ದಿನ ಬಿಡುಗಡೆ)']],
      }),
      q('reason', 'textarea', ['Reason for admission', 'भर्ती का कारण', 'ದಾಖಲಾತಿಗೆ ಕಾರಣ'], { required: true, sensitive: true }),
      q('has_allergies', 'select', ['Do you have any known allergies?', 'क्या आपको कोई ज्ञात एलर्जी है?', 'ನಿಮಗೆ ಯಾವುದಾದರೂ ತಿಳಿದಿರುವ ಅಲರ್ಜಿ ಇದೆಯೇ?'], { required: true, sensitive: true, options: [YES, NO] }),
      q('allergy_details', 'textarea', ['Please describe the allergies', 'कृपया एलर्जी का विवरण दें', 'ದಯವಿಟ್ಟು ಅಲರ್ಜಿಗಳನ್ನು ವಿವರಿಸಿ'], { required: true, sensitive: true, visibleIf: { questionId: 'has_allergies', equals: 'Yes' } }),
      section('s_payment', ['Payment', 'भुगतान', 'ಪಾವತಿ']),
      q('payment_mode', 'select', ['How will the hospital bill be paid?', 'अस्पताल के बिल का भुगतान कैसे किया जाएगा?', 'ಆಸ್ಪತ್ರೆಯ ಬಿಲ್ ಅನ್ನು ಹೇಗೆ ಪಾವತಿಸಲಾಗುವುದು?'], {
        required: true,
        options: [
          ['Self-pay', 'स्वयं भुगतान', 'ಸ್ವಂತ ಪಾವತಿ'],
          ['Health insurance', 'स्वास्थ्य बीमा', 'ಆರೋಗ್ಯ ವಿಮೆ'],
          ['Government health scheme', 'सरकारी स्वास्थ्य योजना', 'ಸರ್ಕಾರಿ ಆರೋಗ್ಯ ಯೋಜನೆ'],
          ['Employer or corporate', 'नियोक्ता या कंपनी', 'ಉದ್ಯೋಗದಾತ ಅಥವಾ ಕಂಪನಿ'],
        ],
      }),
      q('insurer', 'text', ['Name of the insurance company or TPA', 'बीमा कंपनी या टीपीए का नाम', 'ವಿಮಾ ಕಂಪನಿ ಅಥವಾ ಟಿಪಿಎ ಹೆಸರು'], { required: true, visibleIf: { questionId: 'payment_mode', equals: 'Health insurance' } }),
      q('scheme', 'text', ['Name of the scheme (for example, PM-JAY)', 'योजना का नाम (जैसे पीएम-जय)', 'ಯೋಜನೆಯ ಹೆಸರು (ಉದಾಹರಣೆಗೆ, ಪಿಎಂ-ಜೆಎವೈ)'], { required: true, visibleIf: { questionId: 'payment_mode', equals: 'Government health scheme' } }),
      q('tariff_acknowledged', 'checkbox', [
        'I have been told the room charges and the estimated cost of treatment, and I accept responsibility for the hospital bill',
        'मुझे कमरे का शुल्क और उपचार का अनुमानित ख़र्च बताया गया है, और मैं अस्पताल के बिल की ज़िम्मेदारी स्वीकार करता/करती हूँ',
        'ಕೊಠಡಿ ಶುಲ್ಕ ಮತ್ತು ಚಿಕಿತ್ಸೆಯ ಅಂದಾಜು ವೆಚ್ಚವನ್ನು ನನಗೆ ತಿಳಿಸಲಾಗಿದೆ, ಮತ್ತು ಆಸ್ಪತ್ರೆಯ ಬಿಲ್‌ನ ಜವಾಬ್ದಾರಿಯನ್ನು ನಾನು ಒಪ್ಪಿಕೊಳ್ಳುತ್ತೇನೆ',
      ], { required: true }),
      q('rules_acknowledged', 'checkbox', [
        "I have been told the hospital's visiting rules, and that valuables should not be kept with the patient",
        'मुझे अस्पताल के मुलाक़ात के नियम बताए गए हैं, और यह भी कि क़ीमती सामान रोगी के पास नहीं रखना चाहिए',
        'ಆಸ್ಪತ್ರೆಯ ಭೇಟಿ ನಿಯಮಗಳನ್ನು ನನಗೆ ತಿಳಿಸಲಾಗಿದೆ, ಮತ್ತು ಬೆಲೆಬಾಳುವ ವಸ್ತುಗಳನ್ನು ರೋಗಿಯ ಬಳಿ ಇಡಬಾರದು ಎಂದು ತಿಳಿಸಲಾಗಿದೆ',
      ], { required: true }),
      q('signature', 'signature', SIGNATURE, { required: true, sensitive: true }),
      q('sign_date', 'date', DATE, { required: true }),
    ],
    consents: [],
  },
  {
    key: 'discharge_consent',
    name: 'Discharge Consent',
    category: 'Consent Forms',
    questions: [
      section('s_patient', PATIENT_DETAILS),
      patientName(),
      dateOfBirth(),
      q('discharge_type', 'select', ['Type of discharge', 'छुट्टी (डिस्चार्ज) का प्रकार', 'ಬಿಡುಗಡೆಯ ಪ್ರಕಾರ'], {
        required: true,
        options: [
          ['On medical advice', 'डॉक्टर की सलाह पर', 'ವೈದ್ಯರ ಸಲಹೆಯ ಮೇರೆಗೆ'],
          ['Against medical advice', 'डॉक्टर की सलाह के विरुद्ध', 'ವೈದ್ಯರ ಸಲಹೆಗೆ ವಿರುದ್ಧವಾಗಿ'],
        ],
      }),
      q('summary_received', 'checkbox', [
        'I have received the discharge summary, and my medicines, warning signs and follow-up have been explained to me',
        'मुझे डिस्चार्ज सारांश मिल गया है, और मेरी दवाएँ, ख़तरे के लक्षण और आगे की जाँच मुझे समझा दी गई हैं',
        'ಬಿಡುಗಡೆ ಸಾರಾಂಶ ನನಗೆ ದೊರೆತಿದೆ, ಮತ್ತು ನನ್ನ ಔಷಧಿಗಳು, ಅಪಾಯದ ಲಕ್ಷಣಗಳು ಹಾಗೂ ಮುಂದಿನ ತಪಾಸಣೆಯನ್ನು ನನಗೆ ವಿವರಿಸಲಾಗಿದೆ',
      ], { required: true, visibleIf: { questionId: 'discharge_type', equals: 'On medical advice' } }),
      q('leaving_reason', 'textarea', [
        'Reason for leaving against medical advice',
        'डॉक्टर की सलाह के विरुद्ध अस्पताल छोड़ने का कारण',
        'ವೈದ್ಯರ ಸಲಹೆಗೆ ವಿರುದ್ಧವಾಗಿ ಹೊರಡಲು ಕಾರಣ',
      ], { required: true, sensitive: true, visibleIf: { questionId: 'discharge_type', equals: 'Against medical advice' } }),
      q('leaving_risks_explained', 'checkbox', [
        'The doctor has explained my condition and the risks of leaving before treatment is complete, including the risk to life, and I take responsibility for this decision',
        'डॉक्टर ने मेरी स्थिति और उपचार पूरा होने से पहले जाने के जोखिम, जान के ख़तरे सहित, मुझे समझा दिए हैं, और मैं इस निर्णय की ज़िम्मेदारी लेता/लेती हूँ',
        'ವೈದ್ಯರು ನನ್ನ ಸ್ಥಿತಿ ಮತ್ತು ಚಿಕಿತ್ಸೆ ಪೂರ್ಣಗೊಳ್ಳುವ ಮೊದಲೇ ಹೊರಡುವುದರ ಅಪಾಯಗಳನ್ನು, ಜೀವಕ್ಕೆ ಅಪಾಯವೂ ಸೇರಿದಂತೆ, ವಿವರಿಸಿದ್ದಾರೆ, ಮತ್ತು ಈ ನಿರ್ಧಾರದ ಜವಾಬ್ದಾರಿಯನ್ನು ನಾನು ಹೊರುತ್ತೇನೆ',
      ], { required: true, visibleIf: { questionId: 'discharge_type', equals: 'Against medical advice' } }),
      q('belongings_received', 'checkbox', [
        'I have received my belongings and my documents',
        'मुझे मेरा सामान और मेरे दस्तावेज़ मिल गए हैं',
        'ನನ್ನ ವಸ್ತುಗಳು ಮತ್ತು ನನ್ನ ದಾಖಲೆಗಳು ನನಗೆ ದೊರೆತಿವೆ',
      ], { required: true }),
      section('s_sign', ['Signature', 'हस्ताक्षर', 'ಸಹಿ']),
      ...signerQuestions(true),
      q('signature', 'signature', SIGNATURE, { required: true, sensitive: true }),
      q('witness_name', 'text', WITNESS, { required: true }),
      q('sign_date', 'date', DATE, { required: true }),
    ],
    consents: [DISCHARGE_CONSENT],
  },
  {
    // Filled in by the doctor on duty, not the patient: every answer is sensitive.
    key: 'mlc_intimation',
    name: 'Medico-legal Case (MLC) Intimation',
    category: 'Medico-legal',
    questions: [
      section('s_case', ['Case details', 'मामले का विवरण', 'ಪ್ರಕರಣದ ವಿವರಗಳು'], true),
      q('full_name', 'text', ['Name of the patient (or "unknown")', 'रोगी का नाम (या "अज्ञात")', 'ರೋಗಿಯ ಹೆಸರು (ಅಥವಾ "ಅಪರಿಚಿತ")'], { required: true, sensitive: true, autofillField: 'name' }),
      q('age', 'number', ['Age in years (approximate if not known)', 'आयु वर्षों में (ज्ञात न हो तो अनुमानित)', 'ವಯಸ್ಸು ವರ್ಷಗಳಲ್ಲಿ (ತಿಳಿಯದಿದ್ದರೆ ಅಂದಾಜು)'], { required: true, sensitive: true, min: 0, max: 120 }),
      q('sex', 'select', ['Sex', 'लिंग', 'ಲಿಂಗ'], { required: true, sensitive: true, options: SEX }),
      q('address', 'textarea', ['Address, if known', 'पता, यदि ज्ञात हो', 'ವಿಳಾಸ, ತಿಳಿದಿದ್ದರೆ'], { sensitive: true }),
      q('brought_by', 'text', ['Brought by (name and relationship, or police)', 'किसके द्वारा लाया गया (नाम और संबंध, या पुलिस)', 'ಯಾರು ಕರೆತಂದರು (ಹೆಸರು ಮತ್ತು ಸಂಬಂಧ, ಅಥವಾ ಪೊಲೀಸ್)'], { required: true, sensitive: true }),
      q('arrival_date', 'date', ['Date of arrival at the hospital', 'अस्पताल पहुँचने की तारीख', 'ಆಸ್ಪತ್ರೆಗೆ ಬಂದ ದಿನಾಂಕ'], { required: true, sensitive: true }),
      q('arrival_time', 'text', ['Time of arrival (IST, 24-hour, for example 14:30)', 'पहुँचने का समय (IST, 24 घंटे के प्रारूप में, जैसे 14:30)', 'ಬಂದ ಸಮಯ (IST, 24 ಗಂಟೆಗಳ ಮಾದರಿ, ಉದಾಹರಣೆಗೆ 14:30)'], { required: true, sensitive: true }),
      q('case_type', 'select', ['Nature of the case', 'मामले का स्वरूप', 'ಪ್ರಕರಣದ ಸ್ವರೂಪ'], {
        required: true,
        sensitive: true,
        options: [
          ['Road traffic accident', 'सड़क दुर्घटना', 'ರಸ್ತೆ ಅಪಘಾತ'],
          ['Assault', 'मारपीट या हमला', 'ಹಲ್ಲೆ'],
          ['Burns', 'जलना', 'ಸುಟ್ಟ ಗಾಯಗಳು'],
          ['Poisoning', 'विषाक्तता (ज़हर)', 'ವಿಷಪ್ರಾಶನ'],
          ['Fall or other injury', 'गिरना या अन्य चोट', 'ಬೀಳುವಿಕೆ ಅಥವಾ ಇತರ ಗಾಯ'],
          ['Sexual offence', 'यौन अपराध', 'ಲೈಂಗಿಕ ಅಪರಾಧ'],
          ['Brought unconscious, cause unknown', 'बेहोशी की हालत में लाया गया, कारण अज्ञात', 'ಪ್ರಜ್ಞಾಹೀನ ಸ್ಥಿತಿಯಲ್ಲಿ ಕರೆತರಲಾಗಿದೆ, ಕಾರಣ ತಿಳಿದಿಲ್ಲ'],
          ['Other', 'अन्य', 'ಇತರೆ'],
        ],
      }),
      q('history', 'textarea', ['Brief history as given, and by whom', 'संक्षिप्त विवरण, जैसा बताया गया, और किसने बताया', 'ನೀಡಲಾದ ಸಂಕ್ಷಿಪ್ತ ವಿವರ, ಮತ್ತು ಯಾರು ನೀಡಿದರು'], { required: true, sensitive: true }),
      q('findings', 'textarea', ['Injuries and findings on examination', 'जाँच में पाई गई चोटें और निष्कर्ष', 'ತಪಾಸಣೆಯಲ್ಲಿ ಕಂಡುಬಂದ ಗಾಯಗಳು ಮತ್ತು ಅಂಶಗಳು'], { required: true, sensitive: true }),
      section('s_police', ['Police intimation', 'पुलिस को सूचना', 'ಪೊಲೀಸರಿಗೆ ಮಾಹಿತಿ'], true),
      q('police_station', 'text', ['Name of the police station informed', 'जिस पुलिस थाने को सूचना दी गई उसका नाम', 'ಮಾಹಿತಿ ನೀಡಿದ ಪೊಲೀಸ್ ಠಾಣೆಯ ಹೆಸರು'], { required: true, sensitive: true }),
      q('intimation_date', 'date', ['Date of intimation', 'सूचना देने की तारीख', 'ಮಾಹಿತಿ ನೀಡಿದ ದಿನಾಂಕ'], { required: true, sensitive: true }),
      q('intimation_time', 'text', ['Time of intimation (IST, 24-hour, for example 14:30)', 'सूचना देने का समय (IST, 24 घंटे के प्रारूप में, जैसे 14:30)', 'ಮಾಹಿತಿ ನೀಡಿದ ಸಮಯ (IST, 24 ಗಂಟೆಗಳ ಮಾದರಿ, ಉದಾಹರಣೆಗೆ 14:30)'], { required: true, sensitive: true }),
      q('intimation_mode', 'select', ['How the police were informed', 'पुलिस को किस माध्यम से सूचना दी गई', 'ಪೊಲೀಸರಿಗೆ ಹೇಗೆ ಮಾಹಿತಿ ನೀಡಲಾಯಿತು'], {
        required: true,
        sensitive: true,
        options: [
          ['Written intimation', 'लिखित सूचना', 'ಲಿಖಿತ ಮಾಹಿತಿ'],
          ['Telephone', 'टेलीफ़ोन', 'ದೂರವಾಣಿ'],
          ['To the police officer in person', 'पुलिस अधिकारी को व्यक्तिगत रूप से', 'ಪೊಲೀಸ್ ಅಧಿಕಾರಿಗೆ ಖುದ್ದಾಗಿ'],
          ['Email', 'ईमेल', 'ಇಮೇಲ್'],
        ],
      }),
      q('officer', 'text', ['Name and badge number of the officer who received it', 'सूचना प्राप्त करने वाले अधिकारी का नाम और बैज नंबर', 'ಮಾಹಿತಿ ಸ್ವೀಕರಿಸಿದ ಅಧಿಕಾರಿಯ ಹೆಸರು ಮತ್ತು ಬ್ಯಾಡ್ಜ್ ಸಂಖ್ಯೆ'], { sensitive: true }),
      q('mlc_number', 'text', ['MLC register number', 'एमएलसी रजिस्टर नंबर', 'ಎಂಎಲ್‌ಸಿ ರಿಜಿಸ್ಟರ್ ಸಂಖ್ಯೆ'], { sensitive: true }),
      q('doctor_name', 'text', ['Name of the doctor on duty', 'ड्यूटी पर तैनात डॉक्टर का नाम', 'ಕರ್ತವ್ಯದಲ್ಲಿರುವ ವೈದ್ಯರ ಹೆಸರು'], { required: true, sensitive: true }),
      q('signature', 'signature', ['Signature of the doctor on duty (type full name)', 'ड्यूटी डॉक्टर के हस्ताक्षर (पूरा नाम टाइप करें)', 'ಕರ್ತವ್ಯದಲ್ಲಿರುವ ವೈದ್ಯರ ಸಹಿ (ಪೂರ್ಣ ಹೆಸರನ್ನು ಟೈಪ್ ಮಾಡಿ)'], { required: true, sensitive: true }),
    ],
    consents: [],
  },
  {
    key: 'vaccination_record',
    name: 'Vaccination Record',
    category: 'Clinical records',
    questions: [
      section('s_patient', PATIENT_DETAILS),
      patientName(),
      dateOfBirth(),
      section('s_dose', ['Vaccine given', 'दिया गया टीका', 'ನೀಡಿದ ಲಸಿಕೆ']),
      // Vaccine names are kept in English in every language, as on the vaccination card.
      q('vaccine', 'select', ['Vaccine', 'टीका (वैक्सीन)', 'ಲಸಿಕೆ'], { required: true, englishOptions: VACCINES }),
      q('vaccine_other', 'text', ['Name of the vaccine', 'टीके का नाम', 'ಲಸಿಕೆಯ ಹೆಸರು'], { required: true, visibleIf: { questionId: 'vaccine', equals: 'Other' } }),
      q('dose', 'select', ['Dose', 'खुराक', 'ಡೋಸ್'], {
        required: true,
        options: [
          ['Birth dose', 'जन्म के समय की खुराक', 'ಜನನದ ಸಮಯದ ಡೋಸ್'],
          ['1st dose', 'पहली खुराक', 'ಮೊದಲ ಡೋಸ್'],
          ['2nd dose', 'दूसरी खुराक', 'ಎರಡನೇ ಡೋಸ್'],
          ['3rd dose', 'तीसरी खुराक', 'ಮೂರನೇ ಡೋಸ್'],
          ['Booster', 'बूस्टर खुराक', 'ಬೂಸ್ಟರ್ ಡೋಸ್'],
          ['Single dose', 'एकल खुराक', 'ಏಕ ಡೋಸ್'],
        ],
      }),
      q('date_given', 'date', ['Date given', 'टीका लगाने की तारीख', 'ಲಸಿಕೆ ನೀಡಿದ ದಿನಾಂಕ'], { required: true }),
      q('brand', 'text', ['Brand and manufacturer', 'ब्रांड और निर्माता', 'ಬ್ರ್ಯಾಂಡ್ ಮತ್ತು ತಯಾರಕರು']),
      q('batch_number', 'text', ['Batch number', 'बैच नंबर', 'ಬ್ಯಾಚ್ ಸಂಖ್ಯೆ'], { required: true }),
      q('expiry_date', 'date', ['Expiry date of the batch', 'बैच की समाप्ति तिथि', 'ಬ್ಯಾಚ್‌ನ ಅವಧಿ ಮುಗಿಯುವ ದಿನಾಂಕ']),
      q('site', 'select', ['Site and route', 'टीका लगाने का स्थान और तरीक़ा', 'ಲಸಿಕೆ ನೀಡಿದ ಜಾಗ ಮತ್ತು ವಿಧಾನ'], {
        required: true,
        options: [
          ['Left upper arm', 'बाईं ऊपरी बाँह', 'ಎಡ ತೋಳಿನ ಮೇಲ್ಭಾಗ'],
          ['Right upper arm', 'दाईं ऊपरी बाँह', 'ಬಲ ತೋಳಿನ ಮೇಲ್ಭಾಗ'],
          ['Left thigh', 'बाईं जाँघ', 'ಎಡ ತೊಡೆ'],
          ['Right thigh', 'दाईं जाँघ', 'ಬಲ ತೊಡೆ'],
          ['By mouth', 'मुँह से (ड्रॉप्स)', 'ಬಾಯಿಯ ಮೂಲಕ (ಹನಿಗಳು)'],
          ['Other', 'अन्य', 'ಇತರೆ'],
        ],
      }),
      q('reaction', 'select', [
        'Any reaction during the 30 minutes of observation?',
        'निगरानी के 30 मिनट के दौरान कोई प्रतिक्रिया (रिएक्शन) हुई?',
        '30 ನಿಮಿಷಗಳ ವೀಕ್ಷಣೆಯ ಅವಧಿಯಲ್ಲಿ ಯಾವುದಾದರೂ ಪ್ರತಿಕ್ರಿಯೆ ಕಂಡುಬಂದಿದೆಯೇ?',
      ], { required: true, sensitive: true, options: [NO, YES] }),
      q('reaction_details', 'textarea', ['Describe the reaction and the action taken', 'प्रतिक्रिया और की गई कार्रवाई का विवरण दें', 'ಪ್ರತಿಕ್ರಿಯೆ ಮತ್ತು ಕೈಗೊಂಡ ಕ್ರಮವನ್ನು ವಿವರಿಸಿ'], { required: true, sensitive: true, visibleIf: { questionId: 'reaction', equals: 'Yes' } }),
      q('next_due', 'date', ['Next dose due on', 'अगली खुराक की तारीख', 'ಮುಂದಿನ ಡೋಸ್ ದಿನಾಂಕ']),
      q('given_by', 'text', ['Vaccinated by (name)', 'टीका लगाने वाले का नाम', 'ಲಸಿಕೆ ನೀಡಿದವರ ಹೆಸರು'], { required: true }),
    ],
    consents: [],
  },
]

// ---------------------------------------------------------------------------

/**
 * Installs every pack form that is not already present (matched by template
 * name, active or archived), attaching its consent documents. A consent
 * document that already exists by name is reused as it stands -- the hospital
 * may have edited or reviewed it -- and is never overwritten. Pass a
 * transaction to make the whole install atomic.
 */
export async function seedHospitalForms(db: WriteExecutor): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = []
  const skipped: string[] = []
  for (const form of HOSPITAL_FORM_PACK) {
    const [existing] = await db.select({ id: formTemplates.id }).from(formTemplates).where(eq(formTemplates.name, form.name)).limit(1)
    if (existing) { skipped.push(form.name); continue }

    const [template] = await db.insert(formTemplates).values({
      name: form.name,
      category: form.category,
      diagnosisTag: 'General',
      questions: form.questions,
      languages: [...HOSPITAL_FORM_LANGUAGES],
    }).returning({ id: formTemplates.id })

    for (const [sortOrder, consent] of form.consents.entries()) {
      let [doc] = await db.select({ id: consentDocuments.id }).from(consentDocuments).where(eq(consentDocuments.name, consent.name)).limit(1)
      if (!doc) {
        [doc] = await db.insert(consentDocuments).values({
          name: consent.name,
          bodyText: consent.bodyText,
          legalReviewStatus: 'draft',
          translations: {
            ...(consent.translations.hi ? { hi: { bodyText: consent.translations.hi } } : {}),
            ...(consent.translations.kn ? { kn: { bodyText: consent.translations.kn } } : {}),
          },
        }).returning({ id: consentDocuments.id })
      }
      await db.insert(formTemplateConsents).values({ formTemplateId: template.id, consentDocumentId: doc.id, sortOrder }).onConflictDoNothing()
    }
    created.push(form.name)
  }
  return { created, skipped }
}
