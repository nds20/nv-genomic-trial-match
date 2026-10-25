const form = document.getElementById('upload-form');
const button = document.getElementById('submit');
const errorBox = document.getElementById('error');
const resultsBox = document.getElementById('results');

function element(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
}

function renderResults(data) {
    resultsBox.replaceChildren();
    const biomarkerText = data.biomarkers.length ? data.biomarkers.join(', ') : 'none';
    resultsBox.append(element('p', `Recognized biomarkers: ${biomarkerText}`));
    const table = element('table');
    const head = element('thead');
    const headerRow = element('tr');
    ['Trial', 'Score', 'Matched biomarkers', 'Status'].forEach(label =>
        headerRow.append(element('th', label))
    );
    head.append(headerRow);
    table.append(head);

    const body = element('tbody');
    data.results.forEach(result => {
        const row = element('tr');
        const name = element('td', `${result.trialName} (${result.trialId})`);
        const score = element('td', result.matchScore);
        const matched = element('td', result.matchedBiomarkers.join(', ') || '—');
        const status = element('td', result.status.replaceAll('_', ' '));
        status.className = result.status;
        row.append(name, score, matched, status);
        body.append(row);
    });
    table.append(body);
    resultsBox.append(table);
}

form.addEventListener('submit', async event => {
    event.preventDefault();
    errorBox.textContent = '';
    resultsBox.replaceChildren(element('p', 'Checking the biomarker list…'));
    button.disabled = true;

    try {
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: new FormData(form)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Upload failed.');
        renderResults(data);
    } catch (error) {
        resultsBox.replaceChildren();
        errorBox.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});
