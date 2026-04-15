# FAQ & Troubleshooting

## General

### How do I install the application?
No installation is needed. Simply open `well-testing-app.html` in any modern web browser.

### Does it need an internet connection?
No. The application is fully self-contained and works entirely offline.

### Where is my data stored?
All input data is stored in your browser's `localStorage`. It persists between browser sessions but is specific to the browser and device you're using.

### How do I move data to another computer?
Use **Export Session** on the Client & Well Information page to create a `.txt` file, then use **Import Session** on the other machine.

### My saved data disappeared — what happened?
This can happen if you cleared your browser data (cookies, cache, site data), switched browsers, or used private/incognito mode. Always use **Export Session** to back up important data.

### Can multiple people use the same file?
Yes. Each user opens the HTML file in their own browser and their data is stored locally. Users do not interfere with each other. To share data, use session export/import.

## Calculators

### Why do some calculators show a red error message?
The validation system checks that all required inputs are filled in and within valid ranges. Fix the highlighted fields and try again.

### Can I export results to Excel?
Several calculators (AGA-3, Choke, DCA, Flare) support **CSV export**, which can be opened directly in Excel. For other calculators, use the **PDF export** for a formatted report.

### How accurate are the calculations?
Calculations follow published industry standards (API, AGA, ASME) and peer-reviewed correlations (Arps, Standing, Vasquez & Beggs, etc.). See the [Standards & Correlations](Standards-&-Correlations.md) page for full references. Always verify critical results against independent software.

### The chart looks blank — what's wrong?
Charts are rendered on an HTML5 Canvas element. Ensure your browser supports Canvas (all modern browsers do). If the chart is blank, check that you've entered valid input data and clicked **Calculate**.

## PDF Export

### The PDF doesn't show my client logo
Make sure you've uploaded a logo on the **Client & Well Information** page and clicked **Save Information**.

### Can I customise the PDF layout?
The PDF layout is fixed to ensure consistent, professional formatting. You can customise the content by filling in the Client & Well Information fields.

## Mobile

### How do I navigate on mobile?
Tap the hamburger menu icon (three horizontal lines) in the top-left corner to open the sidebar navigation. Tap a module to navigate — the menu closes automatically.

### Are all features available on mobile?
Yes, all calculators and exports work on mobile browsers. The layout is responsive and adapts to smaller screens.
