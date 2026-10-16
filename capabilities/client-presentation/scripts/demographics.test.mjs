import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import '../assets/site/demographics.js';
const fixture = JSON.parse(await fs.readFile(new URL('../assets/site/presentation.json', import.meta.url), 'utf8'));
const {validate, derive, freshness} = globalThis.PresentationDemographics;
test('one research model derives counts and shares consistently', () => {
  const model = derive(validate(fixture.demographics, fixture.sources));
  assert.equal(model.age.total, 11400);
  assert.deepEqual(model.age.values.map(v => v.share), [0.2, 0.6, 0.2]);
  assert.equal(model.income.total, 4000);
  assert.deepEqual(model.income.values.map(v => v.share), [0.3, 0.45, 0.25]);
  assert.deepEqual(model.income.above, [{threshold: 50000, count: 2800, share: .7}, {threshold: 100000, count: 1000, share: .25}]);
  assert.equal(model.income.median.label, 'Median household income');
  assert.equal(model.income.median.unit, 'USD/year');
});
test('research rejects mislabeling, overlaps, divergent totals and incomplete evidence', () => {
  for (const [change, message] of [
    [d => d.income.unit = 'people', /unit must be households/],
    [d => d.income.cells[1].lower = 49999, /non-overlapping/],
    [d => d.age.cells[0].value++, /reconcile/],
    [d => d.income.median.label = '', /median label/],
    [d => d.income.sourceId = 'missing', /sourceId/],
    [d => d.age.period = '', /period/],
    [d => d.income.cells[0].share = .9, /derived/],
    [d => d.geography.label = '', /geography/],
    [d => d.geography.members = ['example-city', 'overlapping-county'], /aggregation is unsupported/],
    [d => d.geography.components = [{unit:'people'}, {unit:'households'}], /aggregation is unsupported/],
    [d => d.asOfDate = 'yesterday', /ISO date/],
    [d => d.asOfDate = '2026-02-30', /ISO date/],
    [d => d.asOfDate = '2026-13-01', /Invalid time value|ISO date/],
    [d => d.population.values.reverse(), /increasing/],
    [d => d.income.thresholds = [75000], /cell boundary/],
    [d => d.income.median.period = '2025', /distribution period/],
    [d => d.validThrough = '2026-09-30', /before research/],
  ]) {
    const data = structuredClone(fixture.demographics); change(data);
    assert.throws(() => validate(data, fixture.sources), message);
  }
});
test('freshness is computed from dates and expires rather than retaining a saved status', () => {
  assert.equal(freshness(fixture.demographics, '2026-10-07'), 'Reviewed through 2026-12-31');
  assert.equal(freshness(fixture.demographics, '2027-01-01'), 'Research expired; update before publication');
  assert.equal(freshness(fixture.demographics, '2026-09-30'), 'Research date is in the future');
});
