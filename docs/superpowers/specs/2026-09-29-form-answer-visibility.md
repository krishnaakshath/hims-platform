# Form Answer Visibility (Admin & Doctors) — Design Spec

**Status:** Draft for review — finding + a test-only recommendation, no implementation needed.
**Position in the larger initiative:** a standalone investigation prompted by "the admin and also the doctors should be able to see the forms that have been filled by the patients, like they should be able to look at their answers as well." This is not part of the Forms Hub redesign or the Tebra/IntakeQ migration work being spec'd in parallel — it touches neither.

## 1. Finding: this already works today. No gap exists.

Both `admin` and `pi` (and, as a side effect of how the check is written, `crc` and `frontdesk` too) can already open a patient's Client Forms submission and read their actual answers, not just status. There is no role gate hiding this anywhere in the page, the API route, or the query layer:

- **Page:** `src/app/(dashboard)/client-forms/[id]/page.tsx:9` calls `requireSessionOrRedirect()` with no role restriction, then renders every question's actual submitted answer (`rawValue = submission.answers?.[q.id]`, lines 24-49) for whichever staff session loaded the page.
- **API:** `src/app/api/form-submissions/[id]/route.ts:19-27` (`GET`) calls `requireSession()` with no role restriction and returns the full submission object, including `answers`, from `getFormSubmission`.
- **Query layer:** `src/lib/queries/form-submissions.ts:49-74` (`getFormSubmission`) takes no role or session parameter at all and unconditionally projects `answers: row.submission.answers` (line 66).

This codebase's own idiom for restricting a route to specific roles is an explicit inline check after `requireSession()`/`requireSessionOrRedirect()` returns — e.g. `if (!['admin', 'pi'].includes(session.role)) return ...` (see `src/app/api/patients/[anonId]/lab-orders/route.ts:15` or `.../notes/route.ts:22`). Neither `client-forms/[id]/page.tsx` nor `api/form-submissions/[id]/route.ts` contains any such check — the absence is total, not role-specific, so nobody with a valid staff session is excluded.

`src/lib/role-capabilities.ts:32` already documents this for `pi` ("Review a patient's actual submitted answers in Client Forms"). It isn't separately called out for `admin`, but `admin`'s bullet list (`role-capabilities.ts:45`, "Everything a Research Coordinator can do") and `crc`'s Client Forms bullet (`role-capabilities.ts:16`, "Send and track intake forms via Form Templates and Client Forms") cover it by inheritance, and the code has no `admin`-excluding check regardless. `src/components/LeftNav.tsx:38` also lists `/client-forms` with no `roles` restriction, and the surrounding comment (lines 24-28) explicitly notes "Client Forms stays visible to PI -- reviewing a patient's actual submitted answers is clinical review... Admin and CRC both keep full operational access."

**Recommendation: close this as no work needed.** The one real gap is in test coverage, not behavior: nothing currently pins that `GET /api/form-submissions/[id]` returns real answers (not just status) for both `admin` and `pi`, so a future refactor could silently narrow this without any test failing. §2 adds that regression test; nothing else in this spec.

## 2. Regression test to add

`tests/api/form-submissions.test.ts` currently only covers `GET /api/form-submissions` (the list route) and `POST`. There is no test at all for `GET /api/form-submissions/[id]` (the single-submission route that returns `answers`), and the two existing tests against that file's `PUT` handler (`tests/api/form-submission-complete-signature-gate.test.ts`, `tests/api/form-submission-complete-scoring.test.ts`) each mock a single fixed role and never assert on `answers` visibility.

Add a new file, `tests/api/form-submission-answer-visibility.test.ts`, combining two existing patterns already in this suite: the real-DB submission fixture from `tests/api/form-submission-complete-signature-gate.test.ts` (insert a real `formTemplates`/`formSubmissions` row with known answers, clean up in `afterEach`), and the per-test role override from `tests/api/patients.test.ts` (`vi.mock('@/lib/auth', async () => { const actual = await vi.importActual(...); return { ...actual, requireSession: vi.fn(async () => ({ role: 'crc' as const, name: 'Test CRC' })) } })` at module scope, then `vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: '<role>', name: '...' })` inside each test):

- Insert one real submission with known `answers` (e.g. `{ q1: 'yes' }`) against a real seeded patient (`RD-0001`, matching existing fixtures).
- With `requireSession` overridden to `{ role: 'admin', name: 'Test Admin' }`, call `GET` from `src/app/api/form-submissions/[id]/route.ts` and assert `res.status === 200` and `body.answers.q1 === 'yes'` (the actual answer value, not just presence of a `status` field).
- Repeat with `requireSession` overridden to `{ role: 'pi', name: 'Test PI' }`, asserting the same.

This pins the exact capability the user asked about (admin and doctors can see real submitted answers) so it can't silently regress, without asserting anything about `crc`/`frontdesk` (already implied by the same absence-of-gate, out of scope to enumerate further) or about the Forms Hub display redesign.

## 3. Explicitly out of scope

- Redesigning how form submissions are displayed (Forms Hub spec's job).
- Any change to patient-facing form-filling UX.
- Anything about the Tebra/IntakeQ data model.
- Adding or changing any role gate — none is needed; this spec adds a test only.
