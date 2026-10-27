#!/usr/bin/env node
import { defaultLedgerDir, readRecords, summarize } from "../src/ledger.mjs";

const dir = process.argv[2] || defaultLedgerDir();
const days = Number(process.argv[3]) || 7;
const records = readRecords(dir);

if (!records.length) {
  process.stdout.write(`no records in ${dir}\n`);
  process.exit(0);
}

process.stdout.write(`dir: ${dir}\nrecords: ${records.length}\n\n`);
for (const entry of summarize(records, { days })) {
  const sources = Object.entries(entry.sources)
    .map(([name, count]) => `${name}:${count}`)
    .join(" ");
  process.stdout.write(
    `${entry.day}  runs ${String(entry.runs).padStart(3)}  ${String(entry.minutes).padStart(4)}min  sessions ${entry.sessions}  ${sources}\n`,
  );
}
