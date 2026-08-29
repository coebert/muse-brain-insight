ALTER TABLE public.eeg_sessions
  ADD COLUMN IF NOT EXISTS chronic_conditions text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS acute_pathology text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS chronic_burden text,
  ADD COLUMN IF NOT EXISTS chronic_cns text,
  ADD COLUMN IF NOT EXISTS acute_class text;

ALTER TABLE public.eeg_sessions
  ADD CONSTRAINT eeg_sessions_chronic_burden_check
  CHECK (chronic_burden IS NULL OR chronic_burden IN ('none','single','multiple','high')) NOT VALID;

ALTER TABLE public.eeg_sessions
  ADD CONSTRAINT eeg_sessions_chronic_cns_check
  CHECK (chronic_cns IS NULL OR chronic_cns IN ('present','absent')) NOT VALID;

ALTER TABLE public.eeg_sessions
  ADD CONSTRAINT eeg_sessions_acute_class_check
  CHECK (acute_class IS NULL OR acute_class IN ('none','systemic','neuro','mixed')) NOT VALID;