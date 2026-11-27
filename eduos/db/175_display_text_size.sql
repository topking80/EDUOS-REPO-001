-- Student app Phase E: per-person display settings. user_preferences (db/011)
-- already holds theme (school | high_contrast) and reduce_motion; add text size.
-- Settings follow the person to every device; nothing is kept in the browser.
ALTER TABLE user_preferences ADD COLUMN text_size text NOT NULL DEFAULT 'standard' CHECK (text_size IN ('standard', 'large', 'larger'));
