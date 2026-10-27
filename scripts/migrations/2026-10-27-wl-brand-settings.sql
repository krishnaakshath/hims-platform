-- 2026-10-27 WL T3: white-label branding (spec §3, lane rulings R1-R3).
-- brand_settings is a singleton (id = 1, revision guards concurrent admin edits); each non-null
-- column overrides the BRAND_* env layer for that one field. brand_assets holds the processed
-- PNG logos and icons by kind; blob_url is an opaque storage-driver URL that never leaves the
-- server, sha256 content-addresses the public /branding/<kind>-<hash16>.png path.
-- Neither table references patients or users, so the seed's clearExistingData keeps them (like
-- billing_settings). Additive, idempotent, safe to re-run: tables are created only when missing,
-- with every rule a named CHECK, and the singleton row is inserted ON CONFLICT DO NOTHING.
BEGIN;
CREATE TABLE IF NOT EXISTS brand_settings (
  id integer PRIMARY KEY DEFAULT 1,
  revision integer NOT NULL DEFAULT 0,
  display_name text,
  tagline text,
  support_email text,
  support_phone text,
  accent_color text,
  logo_url text,
  login_quote text,
  login_quote_attribution text,
  login_show_department_list boolean NOT NULL DEFAULT true,
  portal_name text,
  print_header_text text,
  print_footer_text text,
  print_signature_line text,
  email_signature text,
  sms_name text,
  onboarding_test_signin_at timestamp,
  onboarding_dismissed_at timestamp,
  updated_at timestamp NOT NULL DEFAULT now(),
  updated_by_name text,
  CONSTRAINT brand_settings_singleton CHECK (id = 1),
  CONSTRAINT brand_settings_revision_nonnegative CHECK (revision >= 0),
  CONSTRAINT brand_settings_display_name_length CHECK (char_length(display_name) <= 60),
  CONSTRAINT brand_settings_tagline_length CHECK (char_length(tagline) <= 160),
  -- The email pattern is EMAIL_RE from src/lib/brand.ts.
  CONSTRAINT brand_settings_support_email_format CHECK (char_length(support_email) <= 254
    AND support_email ~ '^[^\s@<>"''(),;:\\\[\]]+@[^\s@<>"''(),;:\\\[\]]+\.[^\s@<>"''(),;:\\\[\]]+$'),
  CONSTRAINT brand_settings_support_phone_format CHECK (char_length(support_phone) <= 20 AND support_phone ~ '^\+?[0-9][0-9 -]{5,18}$'),
  CONSTRAINT brand_settings_accent_color_format CHECK (accent_color ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT brand_settings_logo_url_length CHECK (char_length(logo_url) <= 2048),
  CONSTRAINT brand_settings_login_quote_length CHECK (char_length(login_quote) <= 200),
  CONSTRAINT brand_settings_login_quote_attribution_length CHECK (char_length(login_quote_attribution) <= 100),
  CONSTRAINT brand_settings_portal_name_length CHECK (char_length(portal_name) <= 40),
  CONSTRAINT brand_settings_print_header_text_length CHECK (char_length(print_header_text) <= 120),
  CONSTRAINT brand_settings_print_footer_text_length CHECK (char_length(print_footer_text) <= 200),
  CONSTRAINT brand_settings_print_signature_line_length CHECK (char_length(print_signature_line) <= 80),
  -- At most 300 characters and 4 lines (3 newlines).
  CONSTRAINT brand_settings_email_signature_length CHECK (char_length(email_signature) <= 300
    AND char_length(email_signature) - char_length(replace(email_signature, E'\n', '')) <= 3),
  CONSTRAINT brand_settings_sms_name_length CHECK (char_length(sms_name) <= 30)
);
INSERT INTO brand_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS brand_assets (
  kind text PRIMARY KEY,
  source text NOT NULL,
  blob_url text NOT NULL,
  sha256 text NOT NULL,
  content_type text NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  byte_size integer NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  created_by_name text NOT NULL,
  CONSTRAINT brand_assets_kind_valid CHECK (kind IN ('logo_light', 'logo_dark', 'icon_32', 'icon_180', 'icon_192', 'icon_512')),
  CONSTRAINT brand_assets_source_valid CHECK (source IN ('upload', 'derived')),
  CONSTRAINT brand_assets_sha256_format CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT brand_assets_content_type_png CHECK (content_type = 'image/png'),
  CONSTRAINT brand_assets_dimensions_positive CHECK (width > 0 AND height > 0 AND byte_size > 0)
);
COMMIT;
