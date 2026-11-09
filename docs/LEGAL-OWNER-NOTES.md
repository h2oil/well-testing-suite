# Privacy notice and Terms of Use: open items for the owner

Not published (docs/ is outside the static publish allow-list, prism-build/publish-site.js). The public pages `privacy.html` and
`terms.html` carry only a version line in their source comment; the open items live here. The texts should be reviewed by a
qualified lawyer (UAE, DIFC and UK / EU data-protection and consumer law) — they are not legal advice.

## Versions (change together)

- Privacy notice version 1 = the server's `WTS_PRIVACY_VERSION` default ("1") = the analytics consent version
  (`WTS_consent.version` in `well-testing-app.html`).
- Terms of Use version 1 = the server's `WTS_TERMS_VERSION` default ("1").

## Facts still to supply (privacy §1, §3, §10, §13, §18, §22; terms §1, §18)

1. The legal name exactly as on the trade licence (use the same name on the sign-in consent screens, the App Store seller name,
   the app footer and `LICENSE`), the licence number, the licensing authority or free zone and the registered address.
2. Which UAE data-protection regime applies: the federal PDPL (mainland and free zones without their own data-protection law),
   the DIFC Data Protection Law No. 5 of 2020 (DIFC licence) or the ADGM Data Protection Regulations 2021 (ADGM licence; DIFC /
   ADGM controllers must register with their data-protection office). Then name it in privacy §3, adapt the §10 UAE column
   (DIFC / ADGM have legitimate interests), §13 (transfers out of the UAE) and §18 (regulator).
3. UK and EU representatives (UK / EU GDPR Art. 27). Analytics monitors UK / EU visitors, so the "occasional" exemption is
   doubtful. No representative is named until one is appointed.
4. Hosting, backup and e-mail regions and the hosting request-log retention. Accounts are not live: the page says account data
   "will be stored" in the UK or the EU.
5. Google Analytics settings (retention is stated as "up to 14 months" until a shorter value is set; signals / data sharing are
   not claimed off) and acceptance of the Google Analytics data processing terms.
6. Data processing agreements with the hosting and e-mail processors, including the EU standard contractual clauses, the UK
   Addendum or IDTA, and safeguards meeting the UAE law that applies. Privacy §12 / §13 state these in the future tense
   ("before accounts launch"); restore the present tense once they are signed.
7. A security-incident (breach) plan. Privacy §16 keeps only the commitment to tell users and regulators; restore "We have a plan
   for handling security incidents" once the plan exists.
8. Whether an Arabic version is needed (terms §2); whether the UK ICO has become the Information Commission.

## Decisions recorded

- Terms §17: DIFC law and the DIFC Courts, consumers keeping their home-country protection (alternative: UAE law and the Dubai
  Courts). The "express agreement in writing" sentence is limited to people who tick the account box; keep the in-app notice
  and the account tick box. With the onshore alternative, the lawyer should add that the exclusions and cap in §12 reach
  contractual claims only (Civil Transactions Law Art. 383 / 390; a court can adjust agreed damages).
- `LICENSE` §9 now defers to terms §17 for the law and courts (it named England and Wales before); terms §10 says so.
- The iOS app keeps the store's standard licence agreement (no custom EULA); terms §2 says these terms add to it. If a custom
  EULA is ever submitted, add the store's minimum terms first.
- Liability cap (terms §12): the greater of USD 100 and the amounts paid in the previous 12 months.
- The sidebar footer links read "Privacy notice · Terms of Use", matching the page titles, the banner, the account tick boxes
  and the report disclaimer (test CB12).
- Both pages are static: no JavaScript, no external requests, no web fonts or remote images.
