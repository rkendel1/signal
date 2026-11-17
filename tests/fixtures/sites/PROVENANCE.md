# Site evidence fixtures

Real evidence collected on 2026-11-17 by `scripts/collect-evidence.ts` (the same collector the extension runs) from
public pages of the U.S. Geological Survey Earthquake Hazards Program:

- `usgs-map.json` — https://earthquake.usgs.gov/earthquakes/map/
- `usgs-event.json` — an event page linked from that feed
- `usgs-search.json` — https://earthquake.usgs.gov/earthquakes/search/

USGS data is in the U.S. public domain. The pages also load third-party ArcGIS map resources; one of those request
URLs carried an access token, which was replaced with `REDACTEDfixtureTOKEN…` before committing (the tests use it to
prove a token never reaches a shared definition). No cookies or sessions were involved: no account was signed in.
