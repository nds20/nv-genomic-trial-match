const form = document.getElementById('upload-form');
const errorBox = document.getElementById('error');
const resultsBox = document.getElementById('results');

function node(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.textContent = '';
  resultsBox.replaceChildren(node('p', 'Checking the biomarker list…'));
  try {
    const response = await fetch('/api/upload', { method: 'POST', body: new FormData(form) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Upload failed.');
    resultsBox.replaceChildren(node('p', `Recognized biomarkers: ${data.biomarkers.join(', ') || 'none'}`));
    const table = node('table');
    const head = node('thead');
    const row = node('tr');
    ['Trial', 'Score', 'Matched biomarkers', 'Status'].forEach((label) => row.append(node('th', label)));
    head.append(row); table.append(head);
    const body = node('tbody');
    for (const result of data.results) {
      const tr = node('tr');
      tr.append(node('td', `${result.trialName} (${result.trialId})`), node('td', result.matchScore), node('td', result.matchedBiomarkers.join(', ') || '—'), node('td', result.status.replaceAll('_', ' ')));
      body.append(tr);
    }
    table.append(body); resultsBox.append(table);
  } catch (error) {
    resultsBox.replaceChildren();
    errorBox.textContent = error.message;
  }
});
