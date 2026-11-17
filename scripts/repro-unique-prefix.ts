/**
 * Reproduction for a platform defect (GAP_REGISTER G-PLAT-5), kept for the upstream report:
 * a FeltDB equality read on the PREFIX of a composite unique index ([sourceId, recordKey]) returned only the
 * first page (1,000 records) once another source's records followed in the index — `find` and `count` alike.
 * Signal works around it with a plain [sourceId] index on signal_links. To see the defect, remove that index
 * from feltkit/app.ts and run:  node scripts/repro-unique-prefix.ts 2000   (prints "fail … duplicates a value")
 */
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.ts";
import { LISTINGS_MAPPING } from "../lib/example.ts";
const n = Number(process.argv[2] ?? 2000);
const listings = Array.from({ length: n }, (_, i) => ({ listing_id: `L${i}`, address: `${100 + i} Test Street`, lat: +(30 + (i % 100) * 0.003).toFixed(6), lng: +(-90 + Math.floor(i / 100) * 0.004).toFixed(6), price: 300000, beds: 3, baths: 2, sqft: 1500, status: "active", parcel_ref: "" }));
const app = await createTestApp();
try {
  const id = await app.as("ada").mutation(api.sources.create, { name: "l", kind: "push", entityType: "property", mapping: JSON.stringify(LISTINGS_MAPPING), content: JSON.stringify(listings) } as never);
  const id2 = await app.as("ada").mutation(api.sources.create, { name: "m", kind: "push", entityType: "property", mapping: JSON.stringify(LISTINGS_MAPPING), content: JSON.stringify(listings.map((l) => ({ ...l, listing_id: "M" + l.listing_id, address: "9" + l.address, lat: l.lat + 1 }))) } as never);
  void id2;
  await app.as("ada").mutation(api.sources.push, { sourceId: id, records: JSON.stringify([{ ...listings[1500], price: 1 }]) } as never);
  console.log("ok");
} catch (e) { console.log("fail", (e as Error).message); } finally { await app.close(); }
