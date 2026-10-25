const LenhardAIEngine = require('./engine/LenhardEngine');
const engine = new LenhardAIEngine();
const patient = ['EGFR', 'ALK'];
const trials = [
    { id: 'T-001', name: 'Lung Cancer Study', requiredBiomarkers: ['EGFR'] },
    { id: 'T-002', name: 'Breast Cancer Study', requiredBiomarkers: ['BRCA1'] }
];
const results = engine.match(patient, trials);
console.log(results);