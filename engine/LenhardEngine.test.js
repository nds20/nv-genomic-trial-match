const test = require('node:test');
const assert = require('node:assert/strict');
const LenhardAIEngine = require('./LenhardEngine');

const engine = new LenhardAIEngine();
const trials = [
    { id: 'T-1', name: 'EGFR study', requiredBiomarkers: ['EGFR'] },
    { id: 'T-2', name: 'Dual marker study', requiredBiomarkers: ['EGFR', 'ALK'] },
    { id: 'T-3', name: 'Empty criteria', requiredBiomarkers: [] }
];

function upload(contents, originalname = 'biomarkers.txt') {
    return { originalname, buffer: Buffer.from(contents) };
}

test('accepts a biomarker-only list and returns sorted match results', () => {
    const result = engine.analyzeResearchFile(upload('EGFR\nALK\nEGFR'), trials);

    assert.deepEqual(result.biomarkers, ['EGFR', 'ALK']);
    assert.equal(result.results[0].trialId, 'T-1');
    assert.equal(result.results[0].matchScore, '100.00%');
    assert.equal(result.results[2].matchScore, '0.00%');
});

test('rejects free text and patient identifiers before matching', () => {
    assert.throws(
        () => engine.analyzeResearchFile(upload('EGFR\nPatient: Jane Smith'), trials),
        /only recognized biomarker symbols/
    );
    assert.throws(
        () => engine.analyzeResearchFile(upload('EGFR\nname@example.com'), trials),
        /only recognized biomarker symbols/
    );
    assert.throws(
        () => engine.match(['Jane Smith'], trials),
        /only recognized biomarker symbols/
    );
});

test('rejects JSON containing any fields beyond biomarkers', () => {
    const contents = JSON.stringify({ biomarkers: ['EGFR'], patientName: 'Sample Patient' });
    assert.throws(
        () => engine.analyzeResearchFile(upload(contents, 'biomarkers.json'), trials),
        /only a biomarkers array/
    );
});

test('rejects unknown symbols, unsupported files, oversized files, and invalid UTF-8', () => {
    assert.throws(() => engine.analyzeResearchFile(upload('TP53'), trials), /only recognized biomarker symbols/);
    assert.throws(() => engine.analyzeResearchFile(upload('EGFR', 'report.pdf'), trials), { status: 415 });
    assert.throws(
        () => engine.analyzeResearchFile({ originalname: 'list.txt', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) }, trials),
        { status: 413 }
    );
    assert.throws(
        () => engine.analyzeResearchFile({ originalname: 'list.txt', buffer: Buffer.from([0xff]) }, trials),
        /valid UTF-8/
    );
});

test('handles case-insensitive biomarkers and empty trial criteria', () => {
    const result = engine.match(['egfr'], trials);

    assert.equal(result.find(trial => trial.trialId === 'T-1').matchScore, '100.00%');
    assert.equal(result.find(trial => trial.trialId === 'T-3').matchScore, '0.00%');
});
