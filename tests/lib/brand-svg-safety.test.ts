// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { checkSvgSafe, sniffImageType } from '@/lib/brand-image'

const enc = (s: string) => new TextEncoder().encode(s)
const svg = (inner: string, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"${attrs}>${inner}</svg>`

describe('sniffImageType', () => {
  it('recognises PNG, JPEG and WebP magic bytes', () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png')
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg')
    expect(sniffImageType(enc('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp')
  })

  it('recognises SVG text whose first element is <svg, after an XML declaration or comments', () => {
    expect(sniffImageType(enc('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml')
    expect(sniffImageType(enc('<!-- c --><svg></svg>'))).toBe('image/svg+xml')
    expect(sniffImageType(enc('﻿  \n<?xml version="1.0"?>\n<!-- a -->\n<!-- b -->\n<svg>'))).toBe('image/svg+xml')
  })

  it('returns null for HTML, PDF, other near-misses and empty input', () => {
    expect(sniffImageType(enc('<html><svg></svg></html>'))).toBeNull()
    expect(sniffImageType(enc('%PDF-1.7'))).toBeNull()
    expect(sniffImageType(new Uint8Array())).toBeNull()
    expect(sniffImageType(enc('<svgfoo></svgfoo>'))).toBeNull()
    expect(sniffImageType(enc('RIFF\u0000\u0000\u0000\u0000WAVEfmt '))).toBeNull()
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
  })
})

describe('checkSvgSafe', () => {
  const rejects: [string, string][] = [
    ['<script>', svg('<script>alert(1)</script>')],
    ['<SCRIPT>', svg('<SCRIPT>alert(1)</SCRIPT>')],
    ['onload', svg('<path d="M0 0"/>', ' onload="x"')],
    ['onclick with spaces', svg('<path d="M0 0" onclick = \'x\'/>')],
    ['<foreignObject>', svg('<foreignObject><div/></foreignObject>')],
    ['<!DOCTYPE svg [', `<!DOCTYPE svg [ ]>${svg('<path d="M0 0"/>')}`],
    ['<!ENTITY', `${svg('<path d="M0 0"/>')}<!ENTITY x "y">`],
    ['href https', svg('<a href="https://x"><path d="M0 0"/></a>')],
    ['xlink:href protocol-relative', svg('<image xlink:href="//x"/>')],
    ['href data uri', svg('<image href="data:image/png;base64,AAAA"/>')],
    ['style url()', svg('<rect width="1" height="1" style="background:url(https://x)"/>')],
    ['@import', svg('<style>@import "x.css";</style>')],
    ['javascript:', svg('<a href="#a"><text>javascript:alert(1)</text></a>')],
    ['<iframe>', svg('<iframe></iframe>')],
    ['<embed>', svg('<embed/>')],
    ['<object>', svg('<object></object>')],
    ['<use> external', svg('<use href="other.svg#a"/>')],
    ['<feImage> external', svg('<filter id="f"><feImage href="x.png"/></filter>')],
    ['href with spaces before a non-# value', svg('<use href = " other.svg#a"/>')],
    ['<style> containing url(#)', svg('<style>.a{fill:url(#g)}</style>')],
    ['xml-stylesheet processing instruction', `<?xml-stylesheet href="x.css"?>${svg('')}`],
    ['CSS escape', svg('<rect style="fill:u\\72l(https://x)"/>')],
    // XML decodes character references before librsvg sees them.
    ['numeric reference in url(', svg('<rect width="1" height="1" style="fill:u&#114;l(https://x)"/>')],
    ['numeric references hiding @import and data:', svg('<style>&#64;import "&#100;ata:text/css,a{}";</style>')],
    ['numeric reference hiding javascript:', svg('<text>&#106;avascript:alert(1)</text>')],
    ['hex numeric reference', svg('<text>&#x6a;avascript:</text>')],
    ['unknown named entity', svg('<text>&nbsp;</text>')],
    ['bare ampersand', svg('<text>A & B</text>')],
    // Namespace-prefixed elements.
    ['prefixed <s:script>', svg('<s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script>')],
    ['prefixed <s:foreignObject>', svg('<s:foreignObject xmlns:s="http://www.w3.org/2000/svg"/>')],
    ['prefixed <s:iframe>', svg('<s:iframe xmlns:s="http://www.w3.org/1999/xhtml"/>')],
    ['prefixed <s:use> external', svg('<s:use xmlns:s="http://www.w3.org/2000/svg" href="x.svg#a"/>')],
    ['prefixed <s:style> with url(#)', svg('<s:style xmlns:s="http://www.w3.org/2000/svg">.a{fill:url(#g)}</s:style>')],
    ['unclosed <style> with url(#)', svg('<style>.a{fill:url(#g)}')],
    ['xml:base', svg('<g xml:base="https://x/"><use href="#a"/></g>')],
  ]
  it.each(rejects)('rejects %s', (_label, text) => {
    const r = checkSvgSafe(text)
    expect(r.ok).toBe(false)
  })

  it('returns a fixed reason code, never the input', () => {
    const r = checkSvgSafe(svg('<script>secret-value</script>'))
    expect(r).toEqual({ ok: false, reason: 'script' })
    expect(checkSvgSafe(svg('', ' onload="x"'))).toEqual({ ok: false, reason: 'event_handler' })
    expect(checkSvgSafe(svg('<foreignObject/>'))).toEqual({ ok: false, reason: 'foreign_object' })
    expect(checkSvgSafe(`${svg('')}<!ENTITY x "y">`)).toEqual({ ok: false, reason: 'entity' })
    expect(checkSvgSafe(svg('<use href="x.svg#a"/>'))).toEqual({ ok: false, reason: 'external_ref' })
    expect(checkSvgSafe(svg('<text>data:</text>'))).toEqual({ ok: false, reason: 'data_uri' })
  })

  it('accepts a clean logo with paths, groups, a gradient and local references', () => {
    const clean = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Created for Sanjeevani Hospital -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" viewBox="0 0 200 50">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0" gradientUnits="objectBoundingBox">
      <stop offset="0" stop-color="#194f81" stop-opacity="1"/>
      <stop offset="1" stop-color="#2a7ab8"/>
    </linearGradient>
    <path id="a" d="M0 0h10v10z"/>
  </defs>
  <g transform="translate(5 5)" fill="url(#g)">
    <path d="M0 0L40 0L40 40Z"/>
    <use href="#a"/>
    <use xlink:href = "#a" x="20"/>
    <rect width="10" height="10" style="fill:url( '#g' )"/>
  </g>
  <text x="50" y="30" font-family="sans-serif" dominant-baseline="middle">Sanjeevani</text>
</svg>`
    expect(checkSvgSafe(clean)).toEqual({ ok: true })
  })

  it('reports numeric character references as entity', () => {
    expect(checkSvgSafe(svg('<text>&#106;avascript:</text>'))).toEqual({ ok: false, reason: 'entity' })
  })

  it('accepts the five predefined entities', () => {
    expect(checkSvgSafe(svg('<text>Shah &amp; Sons &lt;Pune&gt; &quot;OPD&quot; &apos;24x7&apos;</text>'))).toEqual({
      ok: true,
    })
  })

  it('accepts a <style> block without url( alongside fill="url(#g)" outside it', () => {
    const text = svg(
      '<style>.a{fill:#194f81;stroke-width:2}</style>' +
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#194f81"/></linearGradient></defs>' +
        '<rect class="a" width="10" height="10"/><rect width="10" height="10" fill="url(#g)"/>',
    )
    expect(checkSvgSafe(text)).toEqual({ ok: true })
  })
})
