# Security policy

## Project status

This repository is an early-stage prototype. It is not intended to receive protected health information (PHI) and is not HIPAA certified. Do not use it to store or process real patient records.

The upload engine accepts a strict biomarker-list format, limits uploads to 5 MB, rejects free text and extra fields, does not persist uploads, and applies a process-local upload limit. These controls are not a substitute for authentication, an organizational risk analysis, a business associate agreement, or the administrative, physical, and technical safeguards required for a production healthcare service.

## Reporting a vulnerability

Please do not include patient information, credentials, or other sensitive data in a report. If private vulnerability reporting is enabled for this repository, use the repository's **Security** tab to submit a report. Otherwise, contact the repository maintainers privately before opening a public issue.

Reports should include the affected version or commit, impact, and steps to reproduce using non-sensitive test data. The maintainers will acknowledge reports as soon as practical and coordinate any public disclosure after a fix is available.
