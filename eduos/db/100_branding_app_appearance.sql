-- 100 (UI-02): the school's theme also chooses how the EduOS app looks: dark,
-- light, or following the device's setting. NULL inherits (school -> district
-- -> system default, which is dark, as the app has always been).
ALTER TABLE branding_profiles
  ADD COLUMN app_appearance text CHECK (app_appearance IS NULL OR app_appearance IN ('dark','light','device'));