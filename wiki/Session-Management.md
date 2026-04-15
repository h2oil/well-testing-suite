# Session Management

The Well Testing Suite provides robust data persistence and portability through auto-save, session export, and session import.

## Auto-Save

Every input field in every calculator auto-saves to the browser's `localStorage`:

- **Mechanism:** A debounced `input` event listener (300ms) captures all field values for the current calculator page.
- **Scope:** Each calculator module has a unique storage key (prefixed with `wts_`).
- **Feedback:** A brief "Inputs saved" flash notification appears in the corner when values are persisted.
- **Restoration:** When you navigate back to a calculator, all saved values are automatically restored.

## Session Export

Export all calculator data and settings as a single `.txt` file.

### What's Included

- All calculator input values across every module
- Client and well information
- Client logo (embedded as base64 data URI)
- A live snapshot of the currently visible page's input values
- Metadata (export timestamp, format version)

### File Format

The exported file is a JSON document with the format identifier `H2Oil_WTS_Session_v1`. Keys include:

- `_format` — Format identifier
- `_version` — Schema version number
- `_exported` — ISO 8601 timestamp
- `wts_<module>` — Per-calculator saved data
- `h2oil_client_info` — Client/well/engineer details
- `_live_<page>` — Live snapshot of the currently visible page

### Filename

Auto-generated as: `H2Oil_<ClientName>_YYYY-MM-DD_HHMM.txt`

## Session Import

Restore a previously exported session file.

### Process

1. Click **Import Session** on the Client & Well Information page.
2. Select the `.txt` or `.json` file.
3. The importer reads and validates the file format.
4. All `wts_*` keys are written to `localStorage`.
5. Client info and logo are restored.
6. A status message shows how many calculators were restored.
7. The current page re-renders with the imported values.

### Compatibility

- Session files are forward-compatible (newer versions can read older exports).
- The importer handles both the `H2Oil_WTS_Session_v1` format and raw localStorage dumps.

## Tips

- **Regular Backups:** Export sessions before clearing browser data or switching devices.
- **Collaboration:** Share session files with colleagues to transfer calculator setups.
- **Archiving:** Save session files alongside final PDF reports for project records.
- **Multiple Projects:** Export/import different sessions when switching between wells or clients.
