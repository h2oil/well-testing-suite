# Exporting Reports

The Well Testing Suite supports three export formats: PDF, PNG, and Session files.

## PDF Export

Click the **PDF** button in the top-right corner of any calculator page.

### What's Included

1. **Cover Page** — H2Oil logo, client logo (if uploaded), project title, client/well details, date, and engineer information.
2. **Inputs Section** — All current input values displayed in a formatted table.
3. **Charts** — Any visible canvas charts are embedded as images.
4. **Results Section** — Calculated results reproduced in the report.

### Customising the Cover Page

Navigate to **Client & Well Information** and fill in:
- Client/company name, contact, email, reference
- Well name, field, operator, country, rig
- Engineer name, position, company, email
- Upload a **client logo** for co-branding

These details are automatically pulled into every PDF export.

## PNG Export

Click the **PNG** button to generate a composite image containing:
- Page title and subtitle
- All input values (rendered as text)
- All canvas charts (rendered at full resolution)
- Results table

The PNG is useful for pasting into presentations, emails, or chat messages.

## Session Export / Import

### Export

From the **Client & Well Information** page, click **Export Session (.txt)**.

This creates a JSON text file containing:
- All calculator inputs across every module
- Client and well information
- Client logo (embedded as base64)
- A live snapshot of the currently visible page

Filename format: `H2Oil_<ClientName>_YYYY-MM-DD_HHMM.txt`

### Import

Click **Import Session** and select a previously exported `.txt` or `.json` file.

This restores:
- All calculator input values
- Client/well information and logo
- The import status is shown on screen with a count of restored calculators

### Use Cases

- **Backup** — Export before clearing browser data
- **Sharing** — Send a session file to a colleague to share all inputs and setups
- **Device Transfer** — Move your work from one computer/browser to another
- **Archiving** — Save completed well test data alongside your final reports

## CSV Export

Some individual calculators (AGA-3, Choke, DCA, Flare) include a dedicated **CSV export** button that exports the specific calculation results in comma-separated format, suitable for importing into Excel or other tools.
