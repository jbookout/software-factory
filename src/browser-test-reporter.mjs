// Forward result markers, never test names, console output or error payloads.
export default async function* browserResults(events) {
  for await (const { type, data } of events) {
    if (type === 'test:pass' && !data.skip && !data.todo) yield '.'
    if (type === 'test:fail') yield 'X'
  }
}
