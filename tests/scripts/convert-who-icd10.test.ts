// Converter from WHO's ClaML ICD-10 release to the importer CSV. The fixture is INVENTED (every
// label starts "SAMPLE fictional"); it only mimics WHO's published ClaML structure.
import { describe, it, expect } from 'vitest'
import { convertWhoIcd10 } from '../../scripts/code-systems/convert-who-icd10'
import { validateCodeSystemImport, CLI_IMPORT_LIMITS } from '@/lib/coding/import'

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ClaML SYSTEM "ClaML.dtd">
<ClaML version="2.0.0">
	<Meta name="lang" value="en"/>
	<Modifier code="X00_5"><SubClass code="0"/>
		<Rubric id="m1" kind="text"><Label xml:lang="en" xml:space="default">SAMPLE fictional modifier</Label></Rubric>
	</Modifier>
	<Class code="I" kind="chapter">
		<SubClass code="A00-A09"/>
		<Rubric id="r1" kind="preferred"><Label xml:lang="en" xml:space="default">SAMPLE fictional chapter</Label></Rubric>
	</Class>
	<Class code="A00-A09" kind="block">
		<SuperClass code="I"/>
		<SubClass code="A00"/>
		<SubClass code="A01"/>
		<Rubric id="r2" kind="preferred"><Label xml:lang="en" xml:space="default">SAMPLE fictional block</Label></Rubric>
	</Class>
	<Class code="A00" kind="category">
		<SuperClass code="A00-A09"/>
		<SubClass code="A00.0"/>
		<SubClass code="A00.9"/>
		<Rubric id="r3" kind="preferred"><Label xml:lang="en" xml:space="default">SAMPLE fictional &amp; header</Label></Rubric>
		<Rubric id="r3b" kind="inclusion"><Label xml:lang="en" xml:space="default">ignored inclusion</Label></Rubric>
	</Class>
	<Class code="A00.0" kind="category">
		<SuperClass code="A00"/>
		<Rubric id="r4" kind="preferred"><Label xml:lang="en" xml:space="default">SAMPLE fictional first</Label></Rubric>
	</Class>
	<Class code="A00.9" kind="category">
		<SuperClass code="A00"/>
		<Rubric id="r5" kind="preferred"><Label xml:lang="en" xml:space="default">
			<Para>SAMPLE fictional   wrapped</Para>
			<Para>label</Para>
		</Label></Rubric>
	</Class>
	<Modifier code="S99A02_4"><SubClass code=".0"/><SubClass code=".9"/></Modifier>
	<ModifierClass code=".0" modifier="S99A02_4"><SuperClass code="S99A02_4"/>
		<Rubric id="m2" kind="preferred"><Label xml:lang="en" xml:space="default">SAMPLE fictional with coma</Label></Rubric>
	</ModifierClass>
	<ModifierClass code=".9" modifier="S99A02_4"><SuperClass code="S99A02_4"/>
		<Rubric id="m3" kind="preferred"><Label xml:lang="en" xml:space="default">SAMPLE fictional plain</Label></Rubric>
	</ModifierClass>
	<Class code="A02" kind="category">
		<SuperClass code="A00-A09"/>
		<ModifiedBy code="S99A02_4"/>
		<Rubric id="r7" kind="preferred"><Label xml:lang="en" xml:space="default">SAMPLE fictional modified</Label></Rubric>
	</Class>
	<Class code="A01" kind="category">
		<SuperClass code="A00-A09"/>
		<Rubric id="r6" kind="preferred"><Label xml:lang="en" xml:space="default">=SAMPLE fictional formula</Label></Rubric>
	</Class>
</ClaML>`

describe('convertWhoIcd10', () => {
  const out = convertWhoIcd10(FIXTURE)
  const lines = out.csv.trim().split('\n')

  it('emits the importer header and only categories', () => {
    expect(lines[0]).toBe('code,display,parent_code,selectable,active,effective_from,effective_to,sex,age_min_years,age_max_years,excludes')
    expect(out.codeCount).toBe(7)
    expect(lines).toHaveLength(8)
  })

  it('marks categories with subcategories as not selectable and parents subcategories', () => {
    expect(lines).toContain('A00,SAMPLE fictional & header,,no,yes,,,,,,')
    expect(lines).toContain('A00.0,SAMPLE fictional first,A00,yes,yes,,,,,,')
    expect(lines).toContain('A00.9,SAMPLE fictional wrapped label,A00,yes,yes,,,,,,')
  })

  it('never emits a display starting with = + - @', () => {
    expect(lines).toContain('A01,SAMPLE fictional formula,,yes,yes,,,,,,')
    for (const l of lines.slice(1)) expect(l.split(',')[1]).not.toMatch(/^[=+\-@]/)
  })

  it('produces CSV that passes the importer validator', () => {
    const r = validateCodeSystemImport(out.csv, { kind: 'icd10', version: 'WHO-2019', name: 'WHO ICD-10 (2019)', licenceNote: 'test' }, CLI_IMPORT_LIMITS)
    expect(r.issues).toEqual([])
    expect(r.rows).toHaveLength(7)
  })

  it('expands fourth-character modifiers into subcategories', () => {
    expect(lines).toContain('A02,SAMPLE fictional modified,,no,yes,,,,,,')
    expect(lines).toContain('A02.0,SAMPLE fictional modified: SAMPLE fictional with coma,A02,yes,yes,,,,,,')
    expect(lines).toContain('A02.9,SAMPLE fictional modified: SAMPLE fictional plain,A02,yes,yes,,,,,,')
  })

  it('quotes displays containing commas', () => {
    const o = convertWhoIcd10(FIXTURE.replace('SAMPLE fictional first', 'SAMPLE fictional, with comma'))
    expect(o.csv).toContain('A00.0,"SAMPLE fictional, with comma",A00')
  })

  it('refuses a source with no categories', () => {
    expect(() => convertWhoIcd10('<ClaML></ClaML>')).toThrow()
  })
})
