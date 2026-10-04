// Pure task helpers; unit tests cover these and stay green on a broken user path.
export const normalizeTitle = raw => String(raw ?? '').replace(/\s+/g, ' ').trim()
export const addTask = (tasks, title) => [...tasks, { id: tasks.length + 1, title }]
