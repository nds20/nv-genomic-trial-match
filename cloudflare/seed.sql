-- Generated faithfully from data/trials.json; do not edit trial facts here.
-- Run after schema.sql in the oncology-db D1 console.

INSERT OR REPLACE INTO trials (id, name, required_biomarkers_json) VALUES ('T-001', 'Lung Cancer Study', '["EGFR"]');
INSERT OR REPLACE INTO trials (id, name, required_biomarkers_json) VALUES ('T-002', 'Breast Cancer Study', '["BRCA1"]');
INSERT OR REPLACE INTO trials (id, name, required_biomarkers_json) VALUES ('T-003', 'NSCLC Targeted Therapy', '["EGFR", "ALK"]');
INSERT OR REPLACE INTO trials (id, name, required_biomarkers_json) VALUES ('T-004', 'Colorectal KRAS/BRAF Study', '["KRAS", "BRAF"]');
