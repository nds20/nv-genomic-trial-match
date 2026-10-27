CREATE TABLE cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  cancer_type TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'Stage IV',
  histology TEXT NOT NULL DEFAULT '',
  sample_type TEXT NOT NULL DEFAULT 'Tissue NGS',
  prior_therapy TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'intake',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  file_kind TEXT NOT NULL DEFAULT 'Research PDF',
  size_kb INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  gene TEXT NOT NULL,
  variant TEXT NOT NULL,
  alteration TEXT NOT NULL,
  vaf REAL NOT NULL DEFAULT 0,
  classification TEXT NOT NULL,
  therapy TEXT NOT NULL,
  evidence_level TEXT NOT NULL,
  trial_count INTEGER NOT NULL DEFAULT 0,
  confidence INTEGER NOT NULL DEFAULT 80,
  rationale TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
