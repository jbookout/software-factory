(function (root) {
  'use strict';
  const text = (value, label) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} requires text`);
  };
  const date = (value, label) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error(`${label} requires an ISO date`);
  };
  function validate(data, sources) {
    if (data?.modelVersion !== 1) throw new Error('demographics.modelVersion must be 1');
    text(data.title, 'demographic title');
    text(data.geography?.id, 'demographic geography ID');
    text(data.geography?.label, 'demographic geography label');
    if (data.geography.members != null || data.geography.components != null) throw new Error('geographic aggregation is unsupported; supply one source-reported geography');
    if (!['city', 'county', 'region', 'radius'].includes(data.geography?.kind)) throw new Error('demographic geography kind is invalid');
    if (data.geography.kind === 'radius' && (!Number.isFinite(data.geography.radiusMiles) || data.geography.radiusMiles <= 0 || !data.geography.method)) throw new Error('radius geography requires miles and a research method');
    date(data.asOfDate, 'demographic asOfDate');
    date(data.validThrough, 'demographic validThrough');
    if (data.validThrough < data.asOfDate) throw new Error('demographic validity ends before research');
    const source = (id) => {
      if (!sources.some(s => s.id === id)) throw new Error('demographic sourceId must match a declared source');
    };
    const measure = (value, unit) => {
      text(value?.period, 'demographic period');
      source(value?.sourceId);
      if (value.unit !== unit) throw new Error(`demographic unit must be ${unit}`);
    };
    measure(data.population, 'people');
    if (!Array.isArray(data.population.values) || !data.population.values.length) throw new Error('population requires period values');
    const periods = new Set();
    let previousYear = 0;
    for (const point of data.population.values) {
      text(point.label, 'population period label');
      if (!/^\d{4}$/.test(point.label) || Number(point.label) <= previousYear) throw new Error('population periods must be increasing calendar years');
      previousYear = Number(point.label);
      if (periods.has(point.label)) throw new Error('population period labels must be unique');
      periods.add(point.label);
      if (!Number.isSafeInteger(point.value) || point.value < 0) throw new Error('population counts must be nonnegative integers');
      if ('display' in point) throw new Error('population display is derived from its count');
    }
    const distribution = (value, unit, name) => {
      measure(value, unit);
      if (!Array.isArray(value.cells) || !value.cells.length) throw new Error(`${name} requires labeled cells`);
      let previousUpper = 0;
      for (const [index, cell] of value.cells.entries()) {
        text(cell.label, `${name} cell label`);
        if (!Number.isFinite(cell.lower) || cell.lower !== previousUpper || (cell.upper !== null && (!Number.isFinite(cell.upper) || cell.upper <= cell.lower)) || (cell.upper === null && index !== value.cells.length - 1)) throw new Error(`${name} cells must be ordered, contiguous and non-overlapping`);
        if (!Number.isSafeInteger(cell.value) || cell.value < 0) throw new Error(`${name} cell counts must be nonnegative integers`);
        if ('share' in cell || 'total' in value) throw new Error(`${name} totals and shares are derived`);
        previousUpper = cell.upper;
      }
      if (previousUpper !== null || value.cells.reduce((n, c) => n + c.value, 0) === 0) throw new Error(`${name} requires a positive complete distribution`);
    };
    distribution(data.age, 'people', 'age');
    distribution(data.income, 'households', 'income');
    if (data.age.cells.reduce((sum, c) => sum + c.value, 0) !== data.population.values.at(-1).value || data.age.period !== data.population.values.at(-1).label) throw new Error('age cells must reconcile to population at the same period');
    text(data.income.median?.label, 'income median label');
    if (data.income.median.sourceId !== data.income.sourceId || data.income.median.period !== data.income.period) throw new Error('income median must bind the distribution period and source');
    if (data.income.thresholds?.some(threshold => !data.income.cells.some(cell => cell.lower === threshold))) throw new Error('income thresholds must match a lower inclusive cell boundary');
    if (data.income.median.unit !== 'USD/year' || !Number.isFinite(data.income.median.value) || data.income.median.value < 0) throw new Error('income median requires USD/year and a nonnegative value');
    for (const card of data.cards || []) { text(card.title, 'demographic card title'); text(card.geography, 'demographic card geography'); text(card.period, 'demographic card period'); source(card.sourceId); }
    return data;
  }
  function derive(data) {
    const distribution = value => {
      const total = value.cells.reduce((sum, cell) => sum + cell.value, 0);
      return {...value, total, values: value.cells.map(cell => ({...cell, share: cell.value / total}))};
    };
    const age = distribution(data.age), income = distribution(data.income);
    income.above = (income.thresholds || []).map(threshold => {
      const count = income.cells.filter(cell => cell.lower >= threshold).reduce((sum, cell) => sum + cell.value, 0);
      return {threshold, count, share: count / income.total};
    });
    return {...data, age, income, series: [{...data.population, name: 'Population'}, {...age, name: 'Age distribution'}, {...income, name: 'Household income distribution'}]};
  }
  function freshness(data, today) {
    date(today, 'freshness date');
    return today < data.asOfDate ? 'Research date is in the future' : today > data.validThrough ? 'Research expired; update before publication' : `Reviewed through ${data.validThrough}`;
  }
  root.PresentationDemographics = Object.freeze({validate, derive, freshness});
})(typeof window === 'undefined' ? globalThis : window);
