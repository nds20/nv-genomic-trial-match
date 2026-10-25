# NV Genomic Trial Match

An early-stage prototype for comparing a biomarker list with clinical trial criteria. It is not a clinical decision-support system and is not certified as HIPAA compliant.

## Run locally

Requires Node.js 18 or newer.

```powershell
npm install
npm start
```

Open `http://localhost:3000`. With no Cosmos DB settings, the app uses the sample catalog in `data/trials.json`.

## Set up Azure Cosmos DB

This app uses the **Azure Cosmos DB for NoSQL** API, not the MongoDB API. In Cosmos DB, the equivalent of a table is a **container**. The app expects one container containing trial documents.

1. In the [Azure portal](https://portal.azure.com), choose **Create a resource** and select **Azure Cosmos DB for NoSQL**.
2. Select your subscription and resource group, choose an account name and a region near your app, and enable the free tier if the option is available. The free tier must be selected when creating the account and is limited to one account per subscription. Check the [current free-tier terms](https://learn.microsoft.com/en-us/azure/cosmos-db/free-tier); free allowances and regional availability can change.
3. After the account is deployed, open **Data Explorer** and create:
   - Database ID: `nv-genomic-trial-match`
   - Container ID: `trials`
   - Partition key: `/id`
4. In Data Explorer, open the `trials` container and use **New Item** to add each trial as a separate JSON document. For example:

```text
{
  "id": "T-001",
  "name": "Lung Cancer Study",
  "requiredBiomarkers": ["EGFR"]
}
```

Repeat **New Item** for every trial, using a unique `id` for each one. The app will not copy the local sample trials into Cosmos automatically. It reads each document’s `id`, `name`, and `requiredBiomarkers` fields.

5. In the Cosmos account, open **Keys** and copy the URI and a primary key. Keep the key private; it grants access to the account. For local testing, set the app’s environment variables in a PowerShell terminal:

```powershell
$env:COSMOS_ENDPOINT = "https://<account-name>.documents.azure.com:443/"
$env:COSMOS_KEY = "<paste-the-primary-key-locally>"
$env:COSMOS_DATABASE = "nv-genomic-trial-match"
$env:COSMOS_CONTAINER = "trials"
npm start
```

Use your actual account URI and key locally; do not paste the key into chat, source files, or GitHub. For a hosted app, put settings in the hosting platform’s protected configuration, not in the browser or repository. The current prototype uses a Cosmos account key; production should move to managed identity and least-privilege access.

6. Open `http://localhost:3000/api/health`. It should report `"trialStore":"cosmos"`. Then open `http://localhost:3000/api/trials` and confirm your trial documents appear. Without all four Cosmos settings, the app uses the local sample catalog instead.

For a small prototype, keep the account in one region and avoid enabling paid features or extra throughput until you understand their cost. Review Azure pricing and configure a budget alert; a budget alert notifies you but does not itself cap spending. `TRUST_PROXY=true` may be set when deployed behind a single trusted reverse proxy so upload throttling uses the client IP.

## Upload format and safeguards

The prototype accepts only UTF-8 `.txt`, `.csv`, `.tsv`, or `.json` biomarker lists, up to 5 MB and 5,000 symbols. Text files must contain one symbol per line; JSON must contain only a `biomarkers` array. Symbols must be present in the trial catalog. Free text, extra columns, and additional JSON fields are rejected. For example:

```json
{ "biomarkers": ["EGFR", "ALK"] }
```

Uploads are held in memory for processing and are not stored or logged by this app. The engine rejects content outside this narrow format, caps file size, rate-limits upload attempts, and adds standard HTTP security headers. These safeguards reduce risk but cannot guarantee that data is de-identified or satisfy HIPAA by themselves.

**Do not upload real patient information or protected health information.** This prototype has no user authentication, clinical audit workflow, or HIPAA compliance certification. Before use with real clinical data, the deployment needs a documented risk analysis and appropriate administrative, physical, and technical safeguards, including identity/access management, an appropriate business associate agreement and Azure configuration, operational monitoring, and review by qualified privacy/compliance counsel. The matching output is for research exploration only; it is not proof of eligibility or medical advice.

## Verify

```powershell
npm test
```
