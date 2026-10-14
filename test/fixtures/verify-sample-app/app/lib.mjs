export const normalizeTitle = raw => String(raw ?? '').replace(/\s+/g, ' ').trim()
export const addTask = (tasks, title) => [...tasks, { id: tasks.length + 1, title }]
