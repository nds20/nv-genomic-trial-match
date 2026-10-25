const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./server');

test('serves the upload UI and enforces the biomarker-only API policy', async t => {
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });

    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const home = await fetch(baseUrl);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Do not upload patient records/);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(home.headers.get('cache-control'), 'no-store');

    const form = new FormData();
    form.append('research', new Blob(['EGFR\nALK']), 'biomarkers.txt');
    const accepted = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
    const result = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.deepEqual(result.biomarkers, ['EGFR', 'ALK']);
    assert.equal(result.results.length, 4);

    const unsafeForm = new FormData();
    unsafeForm.append('research', new Blob(['EGFR\nPatient: Jane Smith']), 'report.txt');
    const rejected = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: unsafeForm });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /Patient details and free text are not accepted/);
});
