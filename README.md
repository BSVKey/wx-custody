# wx-custody

Custody receipts for NOAA weather-satellite data, corroborated across the three
independent cloud mirrors of NOAA's Open Data Dissemination program: Amazon Web
Services, Google Cloud and Microsoft Azure.

Built for **parametric insurance and weather-triggered contracts**, where disputes are
about the data: what the source showed at the trigger time, whether it was later changed,
and whether it was even available.

## What it records

| Record | Contents |
|---|---|
| File receipt | For one data file: what each mirror served (size, SHA-256 computed by the witness, the mirror's own MD5 claim and whether it held up), when each mirror published it (lag after scan end), and a verdict: `corroborated_all`, `corroborated_partial`, `single_source`, `DISCREPANCY` or `missing_everywhere` |
| Window manifest | For one product over a time window: every receipt, missing scan slots against the product's own cadence, per-mirror absences and checksum-claim failures, publication-lag statistics, and a Merkle root over the receipts (the value to anchor on a public ledger) |

## Use

```bash
node bin/run.mjs                                   # GOES-19 rainfall rate (ABI-L2-RRQPEF), last 6 h
node bin/run.mjs --product ABI-L2-DSIC --hours 3   # any GOES product
node bin/run.mjs --product SEIS-L1b-SGPS --hours 1  # space weather: particles (also MAG, SUVI, EXIS)
node bin/verify.mjs --run out/<runId> --pub <custody public key> --refetch
npm test                                           # offline, zero dependencies
```

## First live run (2026-09-29)

GOES-19 rainfall rate, 6 hours: 35 files, all byte-identical on all three mirrors, no
missing 10-minute slots, no checksum-claim failures. Median publication lag after scan
end: AWS 12 s, Azure 20 s, Google Cloud 25 s. Independent re-verification re-downloaded
all 105 mirror copies: 0 changed.

## Space weather (2026-09-29)

GOES-19 space-weather products work the same way. One hour of SEIS-L1b-SGPS particle data:
59 one-minute files, all byte-identical on AWS, Google Cloud and Azure, no missing slots;
median publication lag AWS 9 s, Azure 17 s, Google Cloud 21 s.

## Boundaries

- Records attest what the public mirrors served and when, not conditions on the ground.
- NOAA data is a US Government work in the public domain (17 U.S.C. 105).
- Not affiliated with or endorsed by NOAA, Amazon, Google or Microsoft.
- Read-only. Anchoring a window root on chain is a separate, manual step.

## Weather Custody Pro

A commercial edition adds NEXRAD radar and USGS earthquake sources, revision history and
"what did the data show at trigger time" lookups for insurers and calculation agents.
Available on request: support@embryospace.com.

## License

Apache License 2.0, provided "AS IS" without warranties or conditions of any kind (see
[LICENSE](LICENSE), section 7). Copyright 2026 Embryo Space Inc. (DBA BSVKey). See [NOTICE](NOTICE).
