// ABOUTME: extractMeta transform — pulls meta tags, og:*, article:*, canonical, language into metadata.
// ABOUTME: Default behavior extracts everything sensible with a blocklist for browser/SEO/verification noise.

import type { Transform } from '../pipeline'

export interface ExtractMetaOptions {
  only?: string[]
  exclude?: RegExp[]
  extras?: Record<string, string>
}

const DEFAULT_EXCLUDES: RegExp[] = [
  // Browser/rendering hints
  /^viewport$/,
  /^charset$/,
  /^x_ua_compatible$/,
  /^format_detection$/,
  /^referrer$/,
  /^color_scheme$/,
  /^theme_color$/,
  // Mobile app shims
  /^apple_mobile_web_app_/,
  /^msapplication_/,
  /^mobile_web_app_capable$/,
  /^application_name$/,
  /^handheldfriendly$/,
  /^mobileoptimized$/,
  // SEO directives
  /^robots$/,
  /^googlebot$/,
  /^bingbot$/,
  // Verification
  /^google_site_verification$/,
  /^yandex_verification$/,
  /^msvalidate/,
  /^facebook_domain_verification$/,
  /^fb_app_id$/,
  /^p_domain_verify$/,
  /^norton_safeweb_site_verification$/,
  // Tooling
  /^generator$/,
  // Twitter cards (almost always duplicates of og:*)
  /^twitter_/,
]

function normalizeKey(name: string): string {
  return name.replace(/[:\-]/g, '_').toLowerCase()
}

function isBlocked(key: string, userExcludes: RegExp[]): boolean {
  for (const re of DEFAULT_EXCLUDES) {
    if (re.test(key)) return true
  }
  for (const re of userExcludes) {
    if (re.test(key)) return true
  }
  return false
}

export function extractMeta(options: ExtractMetaOptions = {}): Transform {
  const userExcludes = options.exclude ?? []
  const onlyKeys = options.only ? new Set(options.only) : null
  const extras = options.extras ?? {}

  return (ctx) => {
    const $ = ctx.$

    // Extract <meta> tags
    $('meta').each((_, el) => {
      const name = $(el).attr('name') ?? $(el).attr('property')
      const content = $(el).attr('content')
      if (!name || content === undefined) return

      const key = normalizeKey(name)
      if (onlyKeys && !onlyKeys.has(key)) return
      if (isBlocked(key, userExcludes)) return

      ctx.metadata[key] = content
    })

    // Extract <title>
    const titleText = $('title').first().text().trim()
    if (titleText) {
      const key = 'html_title'
      if (!onlyKeys || onlyKeys.has(key)) {
        if (!isBlocked(key, userExcludes)) {
          ctx.metadata[key] = titleText
        }
      }
    }

    // Extract <html lang>
    const lang = $('html').attr('lang')
    if (lang) {
      const key = 'language'
      if (!onlyKeys || onlyKeys.has(key)) {
        if (!isBlocked(key, userExcludes)) {
          ctx.metadata[key] = lang
        }
      }
    }

    // Extract canonical URL — link[rel=canonical] takes precedence over og:url
    const canonicalKey = 'canonical_url'
    if (!onlyKeys || onlyKeys.has(canonicalKey)) {
      if (!isBlocked(canonicalKey, userExcludes)) {
        const linkCanonical = $('link[rel="canonical"]').attr('href')
        if (linkCanonical) {
          ctx.metadata[canonicalKey] = linkCanonical
        } else if (ctx.metadata.og_url) {
          ctx.metadata[canonicalKey] = ctx.metadata.og_url
        }
      }
    }

    // Extras: always added, even when only is set
    for (const [key, selector] of Object.entries(extras)) {
      const el = $(selector).first()
      const content = el.attr('content') ?? el.attr('href') ?? el.text().trim()
      if (content) {
        ctx.metadata[key] = content
      }
    }

    return ctx
  }
}
