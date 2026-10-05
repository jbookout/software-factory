import { test } from '@e2e-dev/web'
import { expect } from 'e2e'

test('lost-save', async ({ app, browser, screen }) => {
  await app.open('/tasks/new')
  await screen.getByLabel('Title').fill('Buy milk')
  await screen.getByRole('button', { name: 'Save' }).click()
  await browser.reload()
  await expect(screen.getByTestId('tasks')).toContainText('Buy milk')
})

test('dead-filter', async ({ app, screen }) => {
  await app.open('/tasks?filter=done')
  await expect(screen.getByRole('listitem')).toHaveCount(1)
  await expect(screen.getByTestId('tasks')).toContainText('Completed task')
})

test('blank-refusal', async ({ app, screen }) => {
  await app.open('/tasks/new')
  await screen.getByRole('button', { name: 'Save' }).click()
  await expect(screen.getByRole('alert')).toHaveText('Title required')
  await expect(screen.getByTestId('success')).toBeVisible({ visible: false })
})

test('lazy-empty', async ({ app, screen }) => {
  await app.open('/tasks?filter=archived')
  await expect(screen.getByTestId('state')).toHaveText('No archived tasks')
  await expect(screen.getByRole('listitem')).toHaveCount(0)
})

test('denied-admin', async ({ app, screen }) => {
  await app.open('/admin')
  await expect(screen.getByRole('alert')).toHaveText('Permission denied')
  await expect(screen.getByRole('button', { name: 'Delete all tasks' })).toBeAttached({ attached: false })
})

test('help-tab', async ({ app, browser, screen }) => {
  await app.open('/tasks')
  await screen.getByRole('link', { name: 'Help' }).click()
  await expect(browser).toHaveURL('/tasks')
  await expect.poll(() => browser.evaluate(async () => (await fetch('/help-visits')).json())).toBe(1)
  await app.open('/help')
  await expect(screen.getByRole('heading')).toHaveText('Task help')
})
