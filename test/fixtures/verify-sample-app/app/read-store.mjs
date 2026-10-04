// The product's read-only persistence interface: reads stored titles in a separate process.
import { readFileSync } from 'node:fs'

if (process.argv[2] === '--read') {
  let rows = []
  try { rows = JSON.parse(readFileSync(process.argv[3], 'utf8')) } catch { /* No stored file reads as empty. */ }
  process.stdout.write(JSON.stringify(rows.map(row => row.title)))
}
