# Fair-housing review (G-DATA-8 / G-DATA-15) — a policy input, not a decision

**Status: unresolved.** This document records facts about what Signal does today and the questions that need a policy or legal answer. It does **not** introduce a restriction, and nothing here should be read as saying the product is protected by one. It is not legal advice.

## 1. What the real-estate scenario uses today

Verified from the code (`lib/engine/mapping.ts` vocabulary, `lib/example.ts` criteria, the web app's criteria editor). Updated for the rebuild.

| Used for | Attributes |
|---|---|
| Deciding a match (criteria, metrics) in the scenarios and tests | price, bedrooms, bathrooms, floor size, year built, HOA fee, price reduction, assessed value, annual property tax, estimated monthly rent, derived yields and ratios |
| Scoping | none built in: the map is a display of findings, not a filter. A user could still write criteria on any location attribute a source provides |
| Joining records (not shown as criteria) | parcel ID, street address, latitude/longitude, parcel geometry |
| Proposed by the mapping vocabulary | parcelId, listingId, address, latitude, longitude, name, asOf, price, status, assessedValue, annualPropertyTax, floorSize, yearBuilt, numberOfBedrooms, lotSize, estimatedMonthlyRent, zoning, floodZone. Other columns are proposed under their own names; columns that look like personal data are proposed but not included |

The example criteria and every test use only property and financial attributes from this list. No protected characteristic or proxy is used as a criterion in any validation run.

## 2. Where risk can enter

These are facts about reachability, not claims that anyone does this.

1. **Any column can be mapped to any attribute.** The proposer never suggests an owner, demographic or neighbourhood-quality column, and a column it does not recognise is left out by default. But the review panel's "Use this column" lets a person map any column under any name, and the JSON intent editor accepts any attribute. There is no allow-list.
2. **Parcel files commonly carry owner data** (owner name, mailing address, owner-occupancy or absentee flags, sometimes a homestead exemption). The synthetic fixture includes an `owner_name` column to show this. Owner name is personal data and can correlate with national origin, sex, familial status or religion. Mailing address can mark absentee owners. Public-record status does not settle whether it may be used for this purpose.
3. **Geography is a proxy.** Viewport scoping, ZIP, tract, school-district and "neighbourhood" boundaries can reproduce historical segregation patterns. Scoping by area is legitimate for a person looking for a home; a product that ranks or excludes areas on neighbourhood-composition signals is the concern. Signal currently has no such signals, but a user-supplied dataset could add one (a tract-level demographic or crime column mapped as an attribute).
4. **Free text.** The page extractor retains `text` and `description`; the `contains` operator can match any phrase in listing remarks ("family-friendly", "near church", "adults only"). Such phrases are themselves a fair-housing concern in advertising.
5. **Ordering.** `preferences` in an intent orders results by any attribute. Ordering is not excluding, but it still shapes what a person sees first.
6. **Who the user is.** A person looking for themselves is in a different position from an agent, landlord, lender or platform applying criteria to other people. Signal does not know which it is.

## 3. Policy options (to choose from; none is implemented)

| Option | What it would mean | Cost |
|---|---|---|
| A. Documentation and warning only | Say in the panel and docs that protected characteristics and their proxies must not be used; no enforcement | Cheapest; weakest; easy to ignore |
| B. Allow-list of criteria attributes | Criteria and metrics may use only listed property/financial attributes; everything else is refused at intent validation and at mapping approval | Strong and auditable; limits flexibility; the list needs an owner |
| C. Deny-list of attribute names | Refuse known-risky names (owner*, race, religion, familial status, etc.) | Easy to evade by renaming; false assurance |
| D. B plus review of mappings | Allow-list for criteria, and an explicit warning when an approved mapping contains owner/demographic-looking columns | More UI; still needs a list |
| E. Restrict the data a dataset may carry | Drop owner columns at import | Loses data the person owns; does not address proxies |

A deny-list on its own (C) should not be presented as protection. The allow-list shape (B) is the only one that can be stated precisely.

## 4. Questions that need legal or policy review

- Does the Fair Housing Act, ECOA, or a state/local equivalent apply to Signal as built, and does that depend on who uses it (individual searcher, agent, landlord, lender)?
- Which characteristics apply beyond the federal classes (for example source of income, or local classes)?
- Is a neighbourhood or geographic scope acceptable as a user criterion, and is any geographic ranking acceptable?
- May owner-name or mailing-address columns from public parcel records be imported at all, and for what purposes?
- Does keyword matching over listing text need restriction?
- What must the product say, and where, about intended use?
- Data licence and privacy: county terms for parcel data (redistribution, derivative use, owner PII) and listing-site terms for browser-session capture are separate questions from fair housing and also unresolved per source.

## 5. What is and is not decided

**Decided: nothing at the policy level.** The questions in §4 are still open and need an owner.

**Implemented in the rebuild (2026-11), because its brief requires criteria to stay within legal boundaries:**
- **A deny-list (option C)** in `lib/engine/policy.ts`: attribute and column names naming a federally protected class, common state additions (source of income, marital status, sexual orientation, age) or demographic composition are refused in mappings, criteria conditions and derived values, with a message pointing here. Page attributes with such names are not observed.
- **Default exclusion of personal data (part of E, with D's review step):** columns that look like owner or contact details are proposed but unticked; a person must choose to include them.

As §3 says, a deny-list is easy to evade by renaming and **is not protection**; it only stops the obvious cases and makes the policy visible. Proxies (geography, free text, owner names a person chooses to include) are not addressed. Signal still does not know who the user is (§2.6).
