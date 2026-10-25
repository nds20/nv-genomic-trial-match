/**
 * Lenhard AI Engine™️
 * Precision Oncology Matching Engine
 * 
 * Purpose: Matches patient biomarker profiles against clinical trial criteria.
 */
class LenhardAIEngine {
    constructor() {
        this.version = "1.0.0-alpha";
    }
/**
     * Matches a patient's biomarkers against a list of clinical trials.
     * @param {Array} patientBiomarkers - e.g., ['EGFR', 'KRAS', 'BRAF']
     * @param {Array} trials - Array of trial objects
     */
    match(patientBiomarkers, trials) {
        console.log(`[LenhardEngine] Analyzing ${patientBiomarkers.length} biomarkers against ${trials.length} trials...`);
return trials.map(trial => {
            // Calculate a "Match Score" based on biomarker overlap
            const matchedBiomarkers = trial.requiredBiomarkers.filter(b => 
                patientBiomarkers.includes(b)
            );
const score = (matchedBiomarkers.length / trial.requiredBiomarkers.length) * 100;
return {
                trialId: trial.id,
                trialName: trial.name,
                matchScore: score.toFixed(2) + "%",
                matchedBiomarkers: matchedBiomarkers,
                status: score > 50 ? "POTENTIAL_MATCH" : "LOW_MATCH"
            };
        }).sort((a, b) => parseFloat(b.matchScore) - parseFloat(a.matchScore));
    }
}
module.exports = LenhardAIEngine;