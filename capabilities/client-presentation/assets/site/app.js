(function () {
  'use strict';

  const data = window.PresentationData;
  const doc = document;
  const ns = 'http://www.w3.org/2000/svg';
  const money = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0});
  const number = new Intl.NumberFormat('en-US', {maximumFractionDigits: 0});
  const byId = (id) => doc.getElementById(id);
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const svgEl = (tag, attrs = {}) => {
    const node = doc.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  };
  const present = (value) => value !== undefined && value !== null && value !== '';
  const showValue = (value, formatter = String) => present(value) && Number.isFinite(Number(value)) ? formatter(Number(value)) : 'Not verified';
  const compactMoney = (value) => {
    if (!Number.isFinite(Number(value))) return 'Not verified';
    const amount = Number(value);
    return amount >= 1000000 ? `$${(amount / 1000000).toFixed(2)}M` : money.format(amount);
  };
  const percentFormat = new Intl.NumberFormat('en-US', {maximumFractionDigits: 2});
  const percent = (value) => Number.isFinite(Number(value)) ? `${percentFormat.format(Number(value) * 100)}%` : 'Not verified';
  const displayCarry = (value) => Number(value) < 0 ? `Surplus ${money.format(Math.abs(Number(value)))}` : money.format(Number(value));
  const safeImageSource = (value) => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const source = value.trim();
    if (/^https:\/\//i.test(source)) {
      try { return new URL(source).protocol === 'https:' ? source : null; } catch { return null; }
    }
    if (/^(?:\.\/)?(?:assets|media)\/[a-zA-Z0-9_./-]+$/.test(source) && !source.split('/').includes('..')) return source;
    return null;
  };
  const sampleMode = Boolean(data && data.presentation && data.presentation.fictional);
  const properties = Array.isArray(data && data.properties) ? data.properties : [];
  const leases = Array.isArray(data && data.leases) ? data.leases : [];
  const developments = Array.isArray(data && data.developments) ? data.developments : [];
  const sources = Array.isArray(data && data.sources) ? data.sources : [];
  let selectedProperty = properties[0] || null;
  let lastTrigger = null;
  let lastTriggerInfo = null;
  let financeCalculation = null;
  let handlingHistory = false;

  function setText(id, value) {
    const target = byId(id);
    if (target) target.textContent = present(value) ? String(value) : '';
  }

  function setSignedSummary(id, value, costMetric) {
    const target = byId(id);
    const amount = Number(value);
    if (!target || !Number.isFinite(amount)) { if (target) target.textContent = 'Not verified'; return; }
    target.textContent = money.format(amount);
    target.classList.remove('finance-positive','finance-negative','finance-benefit-positive','finance-benefit-negative');
    if (costMetric) {
      if (id === 'extra-cash' && amount < 0) target.textContent = `Savings vs. leasing ${money.format(Math.abs(amount))}`;
      target.classList.add(amount < 0 ? 'finance-positive' : 'finance-negative');
    }
    else target.classList.add(amount >= 0 ? 'finance-benefit-positive' : 'finance-benefit-negative');
  }

  function art(key, alt, imageSource) {
    const wrapper = make('span', 'property-art');
    const source = safeImageSource(imageSource);
    if (source) {
      const img = make('img');
      img.src = source;
      img.alt = alt || 'Property image';
      img.loading = 'lazy';
      wrapper.append(img);
    } else {
      const palette = {
        harbor: ['#dce9ef', '#f57f29', '#70a3bc', '#f8fafb'],
        grove: ['#e6eee8', '#f57f29', '#80a9b5', '#f8faf7'],
        summit: ['#e2eaf1', '#f57f29', '#79a5bb', '#f8fafb']
      }[key] || ['#dce9ef', '#f57f29', '#70a3bc', '#f8fafb'];
      const picture = svgEl('svg', {viewBox: '0 0 420 180', role: 'img', 'aria-label': alt || 'Architectural illustration'});
      const add = (tag, attrs) => picture.append(svgEl(tag, attrs));
      add('rect', {width: 420, height: 180, fill: palette[0]});
      add('circle', {cx: 340, cy: 38, r: 26, fill: '#f2bd8c'});
      add('path', {d: 'M0 148h420v32H0z', fill: '#b8ccd4'});
      add('path', {d: 'M62 148V76h296v72z', fill: palette[3]});
      add('path', {d: 'M49 80h322l-25-28H74z', fill: palette[1]});
      add('rect', {x: 84, y: 92, width: 252, height: 54, rx: 2, fill: palette[2]});
      add('path', {d: 'M145 92v54m66-54v54m66-54v54m-193-27h252', stroke: '#edf5f7', 'stroke-width': 6});
      add('rect', {x: 188, y: 119, width: 44, height: 29, fill: '#174b78'});
      add('path', {d: 'M210 123v21m-8-14h16', stroke: '#fff', 'stroke-width': 4});
      for (const [x, y, r] of [[31, 126, 17], [389, 129, 18]]) {
        add('circle', {cx: x, cy: y, r, fill: '#75977e'});
        add('path', {d: `M${x} ${y + 13}v21`, stroke: '#64836c', 'stroke-width': 6});
      }
      wrapper.append(picture);
      const label = make('span', 'image-caption', sampleMode ? 'ILLUSTRATION · FICTIONAL PLACEHOLDER' : 'ILLUSTRATION · NOT A PROPERTY PHOTO');
      wrapper.append(label);
    }
    return wrapper;
  }

  function renderHeaderAndText() {
    const presentation = data.presentation || {};
    const brand = data.brand || {};
    const split = String(presentation.title || 'A place to grow with purpose.').match(/^(.*?)(?:\s+(with|for|and)\s+)(.*)$/i);
    const title = byId('hero-title');
    if (title) {
      title.replaceChildren();
      title.append(doc.createTextNode(split ? split[1] : String(presentation.title || '')));
      if (split) {
        title.append(doc.createElement('br'));
        const accent = make('em', '', `${split[2]} ${split[3]}`);
        title.append(accent);
      }
    }
    setText('hero-intro', presentation.summary || (sampleMode
      ? 'A clear view of lease and ownership paths for a growing independent practice. Names, figures, locations, and sources in this example are fictional.'
      : 'A clear view of lease and ownership paths for a growing independent practice.'));
    setText('prepared-for', presentation.preparedFor);
    setText('scenario-date', presentation.scenarioDate);
    setText('footer-brand', brand.name || 'Practice Real Estate');
    setText('footer-descriptor', brand.descriptor || 'Client presentation');
    setText('header-brand', brand.name || 'Practice Real Estate');
    setText('footer-mark', String(brand.name || 'P').trim().charAt(0).toUpperCase());
    setText('header-descriptor', brand.descriptor || 'Client presentation');
    setText('brand-mark', String(brand.name || 'P').trim().charAt(0).toUpperCase());
    doc.title = `${brand.name || 'Practice Real Estate'} | ${presentation.title || 'Client presentation'}`;
    setText('presentation-kicker', sampleMode ? 'Real estate strategy · Illustrative scenario' : 'Real estate strategy');
    setText('hero-growth-value', `${data.metrics?.[0]?.value ?? ''}${data.metrics?.[0]?.suffix || ''}`);
    setText('hero-growth-label', data.metrics?.[0]?.label || 'Growth indicator');
    setText('growth-period', data.metrics?.[0]?.note || '');
    setText('overview-intro', sampleMode
      ? 'This example compares fictional ownership opportunities with a lease path, using one consistent set of planning assumptions.'
      : 'Compare ownership opportunities with a lease path using one consistent set of planning assumptions.');
    setText('sources-intro', sampleMode
      ? 'This example uses fictional placeholder figures. Replace them with current, verifiable evidence before presenting a recommendation.'
      : 'Review the current sources, geography, and retrieval dates behind each market or property claim.');
    const a = data.assumptions || {};
    const assumptionsLine = `Owner allocation ${percent(a.occupancyFraction)}; purchase financing ${percent(1 - Number(a.downPaymentFraction))}; estimated interest ${percent(a.annualInterest)}; ${showValue(a.amortizationYears, (n) => `${number.format(n)}-year amortization`)}; ${showValue(a.annualAppreciation, percent)} annual appreciation; ${showValue(a.annualRentPerSf, (n) => `${money.format(n)}/SF/year`)} base rent; ${showValue(a.collectionLoss, percent)} collection allowance; ${showValue(a.fillMonths, (n) => `${number.format(n)}-month linear fill`)}; ${showValue(a.practiceBuildoutPerSf, (n) => `${money.format(n)}/SF practice buildout`)}; ${showValue(a.holdYears, (n) => `${number.format(n)}-year hold`)}.`;
    setText('strategy-footnote', `${sampleMode ? 'Fictional planning inputs: ' : 'Planning inputs: '}${assumptionsLine} Practice area rounds up to the next whole square foot. Mortgage payments you fund equal modeled mortgage payments less collected outside rent; a negative amount is a surplus. Rent avoided is practice area × base rent × hold years. Extra cash vs. leasing is down payment + carry + tenant improvements − practice rent avoided; modeled benefit is hold-year equity − extra cash vs. leasing. Excludes closing and selling costs, taxes, commissions, reserves, repairs, capital expenditures, unreimbursed ownership expenses, and opportunity cost unless added. Equity is not liquid cash or sale proceeds. NNN base rent does not prove all owner expenses are reimbursed. These are planning assumptions, not a lender offer or forecast.`);
    setText('summary-caveat', 'Provisional, undiscounted illustration. Excludes closing and selling costs, taxes, commissions, reserves, repairs, capital expenditures, unreimbursed ownership expenses, and opportunity cost unless entered. Equity is not liquid cash or sale proceeds. NNN base rent does not prove all owner expenses are reimbursed.');
    setText('locator-disclaimer', data.locator?.disclaimer || (sampleMode
      ? 'Fictional Locator Schematic. No real roads, places, or distances are shown.'
      : 'Locator diagram uses the coordinates in this presentation. Verify the projection and site placement.'));
    setText('locator-svg-title', sampleMode ? (data.locator?.label || 'Fictional Locator Schematic') : (data.locator?.label || 'Development locator'));
    const legend = doc.querySelector('.locator-legend');
    if (legend) legend.hidden = !sampleMode;
    setText('locator-svg-desc', data.locator?.disclaimer || 'A schematic showing the configured development projects.');
    setText('map-caption', sampleMode ? 'FICTIONAL LOCATOR SCHEMATIC · NOT TO SCALE' : 'LOCATOR SCHEMATIC · VERIFY SITE PLACEMENT');
    setText('demographic-note', sampleMode
      ? 'Illustrative values only · verify source and geography'
      : 'Confirm the source, geography, methodology, and date for each measure');
    setText('demo-kicker', data.demographics?.title || 'Demographic trend');
    const demoNote = byId('demographic-note');
    if (demoNote) demoNote.hidden = !sampleMode;
    for (const el of doc.querySelectorAll('[data-fictional-only]')) el.hidden = !sampleMode;
    if (brand.navy) doc.documentElement.style.setProperty('--navy', brand.navy);
    if (brand.orange) doc.documentElement.style.setProperty('--orange', brand.orange);
  }

  function renderMetrics() {
    const grid = byId('metric-grid');
    if (!grid) return;
    grid.replaceChildren();
    const metrics = Array.isArray(data.metrics) ? data.metrics : [];
    metrics.forEach((metric, index) => {
      const card = make('article', `metric-card${index === metrics.length - 1 ? ' metric-card-accent' : ''} scroll-reveal`);
      card.append(make('span', 'metric-index', String(index + 1).padStart(2, '0')));
      const value = make('span', 'metric-value');
      value.append(doc.createTextNode(String(metric.value ?? '—')));
      value.append(make('span', '', metric.suffix || ''));
      card.append(value, make('span', 'metric-label', metric.label || ''), make('span', 'metric-note', metric.note || ''));
      const trend = Array.isArray(metric.trend) ? metric.trend.map(Number).filter(Number.isFinite) : [];
      if (trend.length > 1) {
        const chart = svgEl('svg', {viewBox: '0 0 120 34', 'aria-hidden': 'true'});
        const min = Math.min(...trend), max = Math.max(...trend), span = max - min || 1;
        const points = trend.map((v, i) => `${2 + i * (116 / (trend.length - 1))},${29 - ((v - min) / span) * 24}`).join(' ');
        chart.append(svgEl('polyline', {points, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'}));
        card.append(chart);
      }
      grid.append(card);
    });
  }

  function renderDevelopmentMap() {
    const map = doc.querySelector('.locator-svg');
    const rows = byId('development-rows');
    const cards = byId('development-grid');
    if (!map || !rows || !cards) return;
    rows.replaceChildren();
    cards.replaceChildren();
    const baseSource = safeImageSource(data.locator?.image);
    if (baseSource) {
      const base = svgEl('image', {x: 0, y: 0, width: 820, height: 330, preserveAspectRatio: 'none'});
      base.setAttribute('href', baseSource);
      map.insertBefore(base, map.children[1] || null);
    }
    if (!sampleMode) {
      map.querySelectorAll('.schematic-road,.schematic-block,.schematic-landscape').forEach((node) => node.remove());
      if (!baseSource) {
        const label = svgEl('text', {x: 410, y: 170, 'text-anchor': 'middle', class: 'map-caption'});
        label.textContent = 'VERIFIED BASEMAP REQUIRED';
        map.append(label);
      }
    }
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    developments.forEach((development, index) => {
      const coords = development.locator || {};
      const pointX = Number(coords.x), pointY = Number(coords.y);
      const hasPoint = Number.isFinite(pointX) && Number.isFinite(pointY) && pointX >= 0 && pointX <= 100 && pointY >= 0 && pointY <= 100;
      if (hasPoint && (sampleMode || baseSource)) {
        const x = pointX / 100 * 820;
        const y = pointY / 100 * 330;
        const marker = svgEl('g', {class: 'map-marker', 'data-development-id': development.id, tabindex: 0, role: 'button', 'aria-label': `Open ${development.name} details`});
        marker.append(svgEl('circle', {cx: x, cy: y, r: 20}));
        const label = svgEl('text', {x, y: y + 4});
        label.textContent = String(index + 1).padStart(2, '0');
        marker.append(label, svgEl('circle', {class: 'marker-pulse', cx: x, cy: y, r: 29}));
        map.append(marker);
      }

      const row = doc.createElement('tr');
      row.dataset.developmentId = development.id;
      const ordinal = make('th', '', String(index + 1)); ordinal.scope = 'row'; ordinal.dataset.label = '#';
      const project = doc.createElement('td');
      const open = make('button', 'dev-open', development.name || 'Development');
      open.type = 'button';
      open.dataset.developmentId = development.id;
      project.append(open);
      const place = make('td', '', development.location || 'Not verified');
      const status = make('td', '', development.status || 'Not verified');
      const evidence = make('td', '', sourceById.get(development.sourceId)?.title || 'Source needed');
      row.append(ordinal, project, place, status, evidence);
      rows.append(row);

      const tile = make('button', 'property-card property-tile development-tile scroll-reveal');
      tile.type = 'button';
      tile.dataset.developmentId = development.id;
      tile.setAttribute('aria-haspopup', 'dialog');
      tile.append(art(development.artKey, `${development.name || 'Development'} concept illustration`, development.image));
      const head = make('span', 'property-tile-head');
      head.append(make('span', 'property-type', development.status || 'Development'), make('span', 'property-arrow', '↗'));
      tile.append(head, make('span', 'property-title', development.name || 'Development'), make('span', 'property-location', development.location || 'Not verified'));
      tile.append(make('span', 'property-preview-line', 'Open project details →'));
      cards.append(tile);
    });
    const heads = doc.querySelectorAll('.locator-table thead th');
    ['#', 'Development project', 'Location', 'Scenario', 'Source'].forEach((label, index) => { if (heads[index]) heads[index].textContent = label; });
    if (developments.length === 0) cards.append(make('p', 'empty-state', 'No development projects have been added.'));
  }

  function renderOptionLocator(kind, items, host) {
    if (!host) return;
    host.replaceChildren();
    if (!items.length) return;
    const title = make('h3', 'option-map-title', kind === 'lease' ? 'Lease locator' : 'Purchase locator');
    const svg = svgEl('svg', {viewBox: '0 0 680 220', role: 'group', 'aria-label': `${kind === 'lease' ? 'Lease' : 'Purchase'} option locator schematic`});
    svg.append(svgEl('rect', {width: 680, height: 220, rx: 14, fill: '#eaf1f5'}));
    const mapImage = safeImageSource(data.locator?.image);
    if (mapImage) svg.append(svgEl('image', {href: mapImage, x: 0, y: 0, width: 680, height: 220, preserveAspectRatio: 'none'}));
    else if (sampleMode) {
      svg.append(svgEl('path', {d: 'M-10 165c150-95 240-60 342-4s211 54 368-75', fill: 'none', stroke: '#fff', 'stroke-width': 28, 'stroke-linecap': 'round'}));
      svg.append(svgEl('path', {d: 'M140 -20c27 93 94 126 181 155s143 69 173 109', fill: 'none', stroke: '#fff', 'stroke-width': 22, 'stroke-linecap': 'round'}));
    }
    items.forEach((item, index) => {
      const point = item.locator || {};
      const pointX = Number(point.x), pointY = Number(point.y);
      const hasPoint = Number.isFinite(pointX) && Number.isFinite(pointY) && pointX >= 0 && pointX <= 100 && pointY >= 0 && pointY <= 100;
      const key = kind === 'lease' ? 'lease-id' : 'property-id';
      if (hasPoint && (sampleMode || mapImage)) {
        const x = pointX / 100 * 680, y = pointY / 100 * 220;
        const marker = svgEl('g', {class: 'map-marker option-marker', [`data-${key}`]: item.id, tabindex: 0, role: 'button', 'aria-label': `Open ${item.name || 'option'} details`});
        marker.append(svgEl('circle', {cx: x, cy: y, r: 18}));
        const label = svgEl('text', {x, y: y + 4}); label.textContent = String(index + 1).padStart(2, '0'); marker.append(label);
        svg.append(marker);
      }
    });
    const note = make('p', 'option-map-note', mapImage
      ? 'Coordinates use the configured image projection. Verify each point against its source.'
      : sampleMode ? 'Fictional locator schematic · not to scale' : 'A verified basemap is required before site locations can be shown.');
    host.append(title, svg, note);
  }

  function renderLeaseRows() {
    const body = byId('lease-rows');
    if (!body) return;
    body.replaceChildren();
    const cards = byId('lease-grid');
    cards?.replaceChildren();
    leases.forEach((lease) => {
      const row = doc.createElement('tr');
      row.dataset.leaseId = lease.id;
      const first = doc.createElement('th');
      first.scope = 'row';
      first.dataset.label = 'Lease scenario';
      const open = make('button', 'row-title data-open', lease.name || 'Lease option');
      open.type = 'button';
      open.dataset.leaseId = lease.id;
      open.setAttribute('aria-haspopup', 'dialog');
      first.append(open, make('span', 'row-subtitle', lease.subtitle || ''));
      const location = make('td', '', lease.location || 'Not verified');
      location.dataset.label = 'Location';
      const area = make('td', '', showValue(lease.areaSf, (value) => `${number.format(value)} SF`));
      area.dataset.label = 'Area';
      const rent = make('td', '', showValue(lease.annualRentPerSf, (value) => `${money.format(value)} / SF / year`));
      rent.dataset.label = 'Base rent';
      const structure = make('td', '', lease.structure || 'Not verified');
      structure.dataset.label = 'Structure';
      const parking = make('td', '', `${showValue(lease.parkingSpaces, number.format)}${present(lease.parkingRatio) ? ` · ${lease.parkingRatio}` : ''}`);
      parking.dataset.label = 'Parking';
      row.append(first, location, area, rent, parking, structure);
      body.append(row);
      if (cards) {
        const tile = make('button', 'property-card property-tile lease-tile scroll-reveal');
        tile.type = 'button'; tile.dataset.leaseId = lease.id; tile.setAttribute('aria-haspopup', 'dialog');
        tile.append(art(lease.artKey || 'grove', `${lease.name || 'Lease option'} illustration`, lease.image));
        const head = make('span', 'property-tile-head');
        head.append(make('span', 'property-type', lease.structure || 'LEASE OPTION'), make('span', 'property-arrow', '↗'));
        const stats = make('span', 'property-stats');
        for (const [label, value] of [['AREA', showValue(lease.areaSf, (n) => `${number.format(n)} SF`)], ['BASE RENT', showValue(lease.annualRentPerSf, (n) => `${money.format(n)} / SF / year`)]]) {
          const fact = make('span'); fact.append(make('small', '', label), make('strong', '', value)); stats.append(fact);
        }
        tile.append(head, make('span', 'property-title', lease.name || 'Lease option'), make('span', 'property-location', lease.location || lease.subtitle || 'Not verified'), stats, make('span', 'property-location parking-line', `Parking: ${showValue(lease.parkingSpaces, number.format)} spaces`), make('span', 'property-preview-line', 'Open lease details →'));
        cards.append(tile);
      }
    });
    renderOptionLocator('lease', leases, byId('lease-locator'));
  }

  function renderPurchaseProperties() {
    const grid = byId('property-grid');
    if (!grid) return;
    grid.replaceChildren();
    const purchases = properties;
    const body = byId('purchase-rows');
    body?.replaceChildren();
    purchases.forEach((property, index) => {
      const tile = make('button', 'property-card property-tile scroll-reveal');
      tile.type = 'button';
      tile.dataset.propertyId = property.id;
      tile.setAttribute('aria-haspopup', 'dialog');
      if (selectedProperty && property.id === selectedProperty.id) tile.setAttribute('aria-pressed', 'true');
      tile.append(art(property.artKey, `${property.name || 'Property'} concept illustration`, property.image));
      const head = make('span', 'property-tile-head');
      head.append(make('span', 'property-type', `${String(index + 1).padStart(2, '0')} · ${property.status || 'PURCHASE OPTION'}`), make('span', 'property-arrow', '↗'));
      tile.append(head, make('span', 'property-title', property.name || 'Property option'), make('span', 'property-location', property.location || 'Not verified'));
      const stats = make('span', 'property-stats');
      for (const [label, value] of [['AREA', showValue(property.totalSf, (n) => `${number.format(n)} SF`)], ['PRICE', showValue(property.price, money.format)]]) {
        const fact = make('span');
        fact.append(make('small', '', label), make('strong', '', value));
        stats.append(fact);
      }
      const parking = make('span', 'property-location parking-line', `Parking: ${showValue(property.parkingSpaces, number.format)} spaces${present(property.parkingRatio) ? ` · ${property.parkingRatio}` : ''}`);
      tile.append(stats, parking, make('span', 'property-preview-line', 'Open property details →'));
      grid.append(tile);
      if (body) {
        const row = doc.createElement('tr'); row.dataset.propertyId = property.id;
        const name = doc.createElement('th'); name.scope = 'row'; name.dataset.label = 'Purchase option';
        const open = make('button', 'row-title data-open', property.name || 'Purchase option'); open.type = 'button'; open.dataset.propertyId = property.id; open.setAttribute('aria-haspopup', 'dialog'); name.append(open);
        const location = make('td', '', property.location || 'Not verified'); location.dataset.label = 'Location';
        const area = make('td', '', showValue(property.totalSf, (n) => `${number.format(n)} SF`)); area.dataset.label = 'Area';
        const price = make('td', '', showValue(property.price, money.format)); price.dataset.label = 'Price';
        const parkingCell = make('td', '', `${showValue(property.parkingSpaces, number.format)}${present(property.parkingRatio) ? ` · ${property.parkingRatio}` : ''}`); parkingCell.dataset.label = 'Parking';
        row.append(name, location, area, price, parkingCell); body.append(row);
      }
    });
    renderOptionLocator('purchase', purchases, byId('purchase-locator'));
    const select = byId('property-select');
    if (select) {
      select.replaceChildren();
      purchases.forEach((property) => {
        const option = make('option', '', property.name || 'Property option');
        option.value = property.id;
        select.append(option);
      });
      if (selectedProperty) select.value = selectedProperty.id;
    }
  }

  function renderDemographics() {
    const chart = byId('demographic-chart');
    if (!chart) return;
    const years = Array.isArray(data.demographics?.years) ? data.demographics.years : [];
    const values = Array.isArray(data.demographics?.index) ? data.demographics.index : [];
    const title = make('title', '', data.demographics?.title || 'Population index');
    title.id = 'demo-chart-title';
    const desc = make('desc', '', sampleMode ? 'Fictional illustrative index values.' : 'Population index values from the configured presentation data.');
    desc.id = 'demo-chart-desc';
    chart.replaceChildren(title, desc);
    const reportLink=byId('demographic-report');
    const reportUrl=safeImageSource(data.demographics?.reportPath) || safeWebSource(data.demographics?.reportPath);
    if(reportLink){reportLink.hidden=!reportUrl;if(reportUrl){reportLink.href=reportUrl;reportLink.target='_blank';reportLink.rel='noopener noreferrer';}}
    const pairs = years.map((year, index) => ({year, raw:values[index], value:Number(values[index])}));
    if (pairs.some((entry)=>!present(entry.raw)||!present(entry.year)||!Number.isFinite(entry.value)||!Number.isFinite(Number(entry.year)))) {
      const placeholder=svgEl('text',{x:310,y:140,'text-anchor':'middle',class:'axis-label'}); placeholder.textContent='Not verified'; chart.append(placeholder); return;
    }
    if (pairs.length < 2) {
      const placeholder = svgEl('text', {x: 310, y: 140, 'text-anchor': 'middle', class: 'axis-label'});
      placeholder.textContent = 'Not verified';
      chart.append(placeholder);
      const reportLink=byId('demographic-report'); const reportUrl=safeImageSource(data.demographics?.reportPath)||safeWebSource(data.demographics?.reportPath);
      if(reportLink){reportLink.hidden=!reportUrl;if(reportUrl){reportLink.href=reportUrl;reportLink.target='_blank';reportLink.rel='noopener noreferrer';}}
      return;
    }
    const min = Math.min(...pairs.map((p) => p.value));
    const max = Math.max(...pairs.map((p) => p.value));
    const span = max - min || 1;
    const x0 = 68, dx = 500 / (pairs.length - 1);
    const yFor = (value) => 190 - ((value - min) / span) * 140;
    for (let step = 0; step < 4; step++) chart.append(svgEl('path', {d: `M52 ${50 + step * 46}h536`, class: 'demo-grid'}));
    chart.append(svgEl('path', {d: 'M52 26v190h536', fill: 'none', stroke: '#d9e2e9', 'stroke-width': 1.5}));
    const path = pairs.map((p, index) => `${index ? 'L' : 'M'}${x0 + index * dx} ${yFor(p.value)}`).join(' ');
    chart.append(svgEl('path', {d: path, class: 'demo-line'}));
    pairs.forEach((point, index) => {
      const x = x0 + index * dx, y = yFor(point.value);
      chart.append(svgEl('circle', {cx: x, cy: y, r: 5, fill: '#fff', stroke: '#f57f29', 'stroke-width': 3}));
      const label = svgEl('text', {x, y: 239, 'text-anchor': 'middle', class: 'axis-label'});
      label.textContent = String(point.year);
      chart.append(label);
    });
    [min, min + span / 2, max].forEach((value, index) => {
      const label = svgEl('text', {x: 13, y: 194 - index * 70, class: 'axis-label'});
      label.textContent = number.format(Math.round(value));
      chart.append(label);
    });
    const questions = byId('demographic-questions');
    questions?.querySelectorAll('article').forEach((node) => node.remove());
    (data.demographics?.questions || []).forEach((question, index) => {
      const article = make('article');
      article.append(make('span', 'question-number', String(index + 1).padStart(2, '0')));
      const copy = make('div');
      copy.append(make('h3', '', question.title || 'Question'), make('p', '', question.body || ''));
      article.append(copy);
      questions?.insertBefore(article, questions.querySelector('.text-link'));
    });
  }

  function renderSources() {
    const grid = byId('sources-grid');
    if (!grid) return;
    grid.replaceChildren();
    sources.forEach((source, index) => {
      const card = make('article', 'source-card');
      card.append(make('span', 'source-index', String.fromCharCode(65 + (index % 26))), make('h3', '', source.title || 'Source'));
      card.append(make('p', '', [source.geography, source.date, source.notes].filter(present).join(' · ') || (sampleMode ? 'Source details have not been added.' : 'Source details not verified.')));
      const url = safeImageSource(source.url) || safeWebSource(source.url);
      const reportPath=safeImageSource(source.reportPath) || safeWebSource(source.reportPath);
      if (reportPath) { const report=make('a','report-link','Open supporting report ↗'); report.href=reportPath; report.target='_blank'; report.rel='noopener noreferrer'; card.append(report); }
      if (url) {
        const link = make('a', '', 'Open source ↗');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', `Open source: ${source.title || 'source'}`);
        card.append(link);
      }
      card.append(make('span', 'source-status', url ? 'SOURCE LINKED' : sampleMode ? 'SOURCE NEEDED' : 'VERIFY SOURCE'));
      grid.append(card);
    });
  }

  function safeWebSource(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.trim());
      return url.protocol === 'https:' ? url.href : null;
    } catch { return null; }
  }

  function routeTo(id, updateHistory = false) {
    const firstVisible = (data.sections || []).find((section) => section.visible !== false && byId(section.id))?.id || 'home';
    const valid = new Set((data.sections || []).filter((section) => section.visible !== false && byId(section.id)).map((section) => section.id));
    const targetId = valid.has(id) ? id : firstVisible;
    setActiveRecord(null);
    doc.querySelectorAll('.presentation-view').forEach((view) => {
      const active = view.dataset.view === targetId;
      view.hidden = !active;
      view.dataset.active = String(active);
    });
    const section = data.sections?.find((item) => item.id === targetId);
    const label = section?.title || section?.label || targetId[0].toUpperCase() + targetId.slice(1);
    setText('sticky-page-title', label);
    doc.querySelectorAll('.section-nav a').forEach((link) => {
      if (link.hash === `#${targetId}`) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (updateHistory && location.hash !== `#${targetId}`) history.pushState({view: targetId}, '', `#${targetId}`);
    window.scrollTo({top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
    const heading = byId(targetId)?.querySelector('h1,h2');
    if (heading && targetId !== 'home') { heading.tabIndex = -1; heading.focus({preventScroll: true}); }
  }

  function installSectionTitles() {
    (data.sections || []).forEach((section) => {
      const view = byId(section.id);
      if (!view) return;
      if (section.visible === false && section.id !== 'home') view.hidden = true;
      const heading = view.querySelector('h1,h2');
      if (heading && present(section.title)) heading.textContent = section.title;
    });
    const firstVisible = (data.sections || []).find((section) => section.visible !== false && byId(section.id))?.id || 'home';
    doc.querySelectorAll('a[href^="#"]').forEach((link) => {
      const target = link.hash.slice(1);
      const section = data.sections.find((item) => item.id === target);
      if (['home','leases','purchases','strategy','demographics','sources'].includes(target) && (!section || section.visible === false)) link.hidden = true;
      if (link.classList.contains('wordmark')) { link.href = `#${firstVisible}`; link.hidden = false; }
    });
    const nav = doc.querySelector('.section-nav');
    if (nav && data.sections) {
      nav.querySelectorAll('a[href^="#"]').forEach((link) => {
        const section = data.sections.find((item) => `#${item.id}` === link.hash);
        link.hidden = !section || section.visible === false;
      });
      data.sections.forEach((section) => {
        const link = nav.querySelector(`a[href="#${CSS.escape(section.id)}"]`);
        if (!link) return;
        link.textContent = section.label || section.id;
        link.hidden = section.visible === false;
      });
    }
  }

  function stableTriggerClasses(value) {
    const classes = typeof value === 'string' ? value : value?.baseVal || '';
    return classes.split(/\s+/).filter((name) => name && !['is-active','is-selected','is-visible'].includes(name)).sort().join(' ');
  }

  function showDetail(kind, id, trigger, writeLocation = true) {
    const collection = kind === 'development' ? developments : kind === 'lease' ? leases : properties;
    const item = collection.find((entry) => entry.id === id);
    if (!item) return;
    lastTrigger = trigger || null;
    const dialog = byId('detail-dialog');
    const parentView = trigger?.closest?.('.presentation-view')?.dataset.view || doc.querySelector('.presentation-view[data-active="true"]')?.dataset.view || 'home';
    const triggerEntity = trigger ? entityFor(trigger) : null;
    lastTriggerInfo = trigger && triggerEntity ? {
      parentView, kind: triggerEntity.kind, id: triggerEntity.id,
      tagName: trigger.tagName, className: stableTriggerClasses(trigger.className)
    } : null;
    const deepLink = `#${kind === 'property' ? 'property' : kind}-${encodeURIComponent(id)}`;
    dialog.dataset.parentView = parentView;
    dialog.dataset.entityHash = deepLink;
    const isDevelopment = kind === 'development';
    const isLease = kind === 'lease';
    setText('dialog-type', isDevelopment ? item.status : isLease ? 'LEASE OPTION' : item.status || 'PURCHASE OPTION');
    setText('dialog-title', item.name || 'Details');
    setText('dialog-description', item.description || item.planningNote || item.subtitle || 'Details not verified.');
    setText('dialog-fact1-label', isDevelopment ? 'LOCATION' : 'AREA');
    setText('dialog-area', isDevelopment ? item.location || 'Not verified' : showValue(isLease ? item.areaSf : item.totalSf, (value) => `${number.format(value)} SF`));
    setText('dialog-fact2-label', isDevelopment ? 'SCENARIO' : isLease ? 'ANNUAL BASE RENT' : sampleMode ? 'SAMPLE PRICE' : 'ASKING PRICE');
    setText('dialog-price', isDevelopment ? item.status || 'Not verified' : isLease ? showValue(item.annualRentPerSf, (value) => `${money.format(value)} / SF / year`) : showValue(item.price, money.format));
    setText('dialog-fact3-label', isDevelopment ? 'SOURCE' : 'PARKING');
    const source = sources.find((entry) => entry.id === item.sourceId);
    setText('dialog-parking', isDevelopment ? source?.title || 'Source needed' : `${showValue(item.parkingSpaces, number.format)} spaces${present(item.parkingRatio) ? ` · ${item.parkingRatio}` : ''}`);
    setText('dialog-note', isDevelopment
      ? (sampleMode ? 'Fictional civic development concept. It does not represent an announced or approved project.' : 'Confirm the project status, timing, and source before using it in a recommendation.')
      : (sampleMode ? 'Fictional planning example. Confirm price, condition, parking, financing, and all transaction terms.' : item.planningNote || 'Confirm property details and transaction terms.'));
    const imageBox = byId('dialog-illustration');
    imageBox.replaceChildren(art(item.artKey, `${item.name || 'Property'} illustration`, item.image));
    setText('dialog-kicker', sampleMode ? 'FICTIONAL SCENARIO · DETAILS' : 'PROPERTY DETAILS');
    setActiveRecord(null);
    dialog.showModal();
    if (writeLocation && location.hash !== deepLink) history.pushState({detail: id, parentView}, '', deepLink);
    byId('dialog-close')?.focus();
  }

  function installDialog() {
    const dialog = byId('detail-dialog');
    const close = dialog?.querySelector('.dialog-close');
    close?.addEventListener('click', () => dialog.close());
    dialog?.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    dialog?.addEventListener('close', () => {
      if (!handlingHistory && location.hash === dialog.dataset.entityHash) {
        const parentView = dialog.dataset.parentView || 'home';
        history.replaceState({view: parentView}, '', `#${parentView}`);
        routeTo(parentView);
      }
      const restore = (lastTrigger && lastTrigger.isConnected) ? lastTrigger : findLastTriggerCounterpart();
      if (restore) restore.focus();
    });
    dialog?.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  }

  function syncLocation() {
    const hash = location.hash || '#home';
    const detail = hash.match(/^#(property|lease|development)-(.+)$/);
    const dialog = byId('detail-dialog');
    if (detail) {
      const kind = detail[1], id = decodeURIComponent(detail[2]);
      const parent = kind === 'property' ? 'purchases' : kind === 'lease' ? 'leases' : 'home';
      routeTo(parent);
      if (!dialog.open || dialog.dataset.entityHash !== hash) showDetail(kind, id, null, false);
      return;
    }
    if (dialog.open) {
      handlingHistory = true;
      dialog.close();
      handlingHistory = false;
    }
    const requested = hash.slice(1);
    const visible = data.sections?.find((section)=>section.id===requested && section.visible!==false);
    const firstVisible = data.sections?.find((section)=>section.visible!==false && byId(section.id))?.id || 'home';
    const target = visible ? requested : firstVisible;
    if (`#${target}` !== hash) history.replaceState({view:target},'',`#${target}`);
    routeTo(target);
  }

  function entityFor(node) {
    if (node.dataset.developmentId) return {kind:'development', id:node.dataset.developmentId, item:developments.find((x)=>x.id===node.dataset.developmentId)};
    if (node.dataset.leaseId) return {kind:'lease', id:node.dataset.leaseId, item:leases.find((x)=>x.id===node.dataset.leaseId)};
    if (node.dataset.propertyId) return {kind:'property', id:node.dataset.propertyId, item:properties.find((x)=>x.id===node.dataset.propertyId)};
    return null;
  }

  function findLastTriggerCounterpart() {
    if (!lastTriggerInfo) return null;
    const view = doc.querySelector(`.presentation-view[data-view="${CSS.escape(lastTriggerInfo.parentView)}"][data-active="true"]`);
    if (!view) return null;
    const attribute = lastTriggerInfo.kind === 'development' ? 'data-development-id' : lastTriggerInfo.kind === 'lease' ? 'data-lease-id' : 'data-property-id';
    return [...view.querySelectorAll(`[${attribute}]`)].find((node) => {
      return node.dataset[ lastTriggerInfo.kind === 'development' ? 'developmentId' : lastTriggerInfo.kind === 'lease' ? 'leaseId' : 'propertyId' ] === lastTriggerInfo.id
        && node.tagName === lastTriggerInfo.tagName && stableTriggerClasses(node.className) === lastTriggerInfo.className
        && !node.closest('[hidden]') && node.getClientRects().length > 0;
    }) || null;
  }

  function setActiveRecord(record) {
    doc.querySelectorAll('[data-development-id],[data-lease-id],[data-property-id]').forEach((node) => {
      const item = entityFor(node);
      node.classList.toggle('is-active', Boolean(record && item && item.kind===record.kind && item.id===record.id));
    });
    const preview = byId('entity-preview');
    if (!preview) return;
    if (!record || !record.item) {
      preview.setAttribute('aria-hidden','true');
      doc.querySelectorAll('[aria-describedby="entity-preview"]').forEach((node)=>node.removeAttribute('aria-describedby'));
      return;
    }
    setText('preview-title', record.item.name || 'Details');
    setText('preview-description', record.item.location || record.item.subtitle || record.item.description || 'Details not verified.');
    const artHost = byId('preview-art');
    artHost?.replaceChildren(art(record.item.artKey, `${record.item.name || 'Place'} illustration`, record.item.image));
    preview.setAttribute('aria-hidden','false');
    doc.querySelectorAll('[data-development-id],[data-lease-id],[data-property-id]').forEach((node)=>{
      const linked=entityFor(node);
      if(linked && linked.kind===record.kind && linked.id===record.id) node.setAttribute('aria-describedby','entity-preview');
      else node.removeAttribute('aria-describedby');
    });
  }

  function installInteractions() {
    doc.querySelector('.section-nav')?.addEventListener('click', (event) => {
      const link = event.target.closest('a[href^="#"]');
      if (!link) return;
      event.preventDefault();
      routeTo(link.hash.slice(1), true);
    });
    window.addEventListener('popstate', syncLocation);
    window.addEventListener('hashchange', () => {
      syncLocation();
    });
    doc.addEventListener('click', (event) => {
      const development = event.target.closest('[data-development-id]');
      if (development) {
        showDetail('development', development.dataset.developmentId, development);
        return;
      }
      const lease = event.target.closest('[data-lease-id]');
      if (lease) { showDetail('lease', lease.dataset.leaseId, lease); return; }
      const property = event.target.closest('[data-property-id]');
      if (property) {
        selectedProperty = properties.find((entry) => entry.id === property.dataset.propertyId) || selectedProperty;
        const select = byId('property-select');
        if (select && selectedProperty) select.value = selectedProperty.id;
        doc.querySelectorAll('[data-property-id][aria-pressed]').forEach((node) => node.setAttribute('aria-pressed', String(node.dataset.propertyId === selectedProperty.id)));
        showDetail('property', property.dataset.propertyId, property);
        updateFinance();
      }
    });
    doc.addEventListener('keydown', (event) => {
      const marker = event.target.closest?.('.map-marker[role="button"]');
      if (marker && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); marker.dispatchEvent(new MouseEvent('click', {bubbles: true})); }
    });
    doc.addEventListener('pointerover', (event) => {
      const node = event.target.closest('[data-development-id],[data-lease-id],[data-property-id]');
      if (node) setActiveRecord(entityFor(node));
    });
    doc.addEventListener('pointerout', (event) => {
      const node = event.target.closest('[data-development-id],[data-lease-id],[data-property-id]');
      if (node && !node.contains(event.relatedTarget)) setActiveRecord(null);
    });
    doc.addEventListener('focusin', (event) => {
      const node = event.target.closest('[data-development-id],[data-lease-id],[data-property-id]');
      if (node) setActiveRecord(entityFor(node));
    });
    doc.addEventListener('focusout', (event) => {
      const node = event.target.closest('[data-development-id],[data-lease-id],[data-property-id]');
      if (node && !node.contains(event.relatedTarget)) setActiveRecord(null);
    });
    const slider = byId('ti-slider');
    slider?.addEventListener('input', () => updateFinance());
    byId('property-select')?.addEventListener('change', (event) => {
      selectedProperty = properties.find((property) => property.id === event.target.value) || selectedProperty;
      renderPurchaseProperties();
      updateFinance();
    });
  }

  function renderOwnershipMechanism(results) {
    const grid = byId('ownership-property-grid');
    if (!grid) return;
    grid.replaceChildren();
    if (!results.length) {
      ['mechanism-structure','mechanism-buildings','mechanism-cash','mechanism-equity'].forEach((id)=>setText(id,'Not available'));
      setText('why-structure-copy','Modeled figures are unavailable for this presentation.');
      return;
    }
    const a = data.assumptions || {};
    setText('mechanism-structure', `${percent(a.occupancyFraction)} practice · ${percent(1-Number(a.occupancyFraction))} outside tenants`);
    setText('mechanism-buildings', `${number.format(results.length)} purchase ${results.length===1?'option':'options'}`);
    setText('mechanism-cash', `${percent(1-Number(a.downPaymentFraction))} financed · ${percent(a.annualInterest)} · ${number.format(a.amortizationYears)} years`);
    setText('mechanism-cash-note', `Outside rent: ${money.format(Number(a.annualRentPerSf))}/SF/year; ${percent(a.collectionLoss)} collection loss; ${number.format(a.fillMonths)}-month linear fill. Collected rent offsets modeled mortgage payments.`);
    const current = results.find((entry)=>entry.property.id===selectedProperty?.id) || results[0];
    const held = (current.result.years||[]).find((row)=>row.year===Number(a.holdYears)) || current.result;
    setText('mechanism-equity', `${number.format(a.holdYears)}-year equity ${money.format(held.equity)}`);
    const cash = Number(held.extraCashRequired);
    const cashText = cash < 0 ? `Savings vs. leasing ${money.format(Math.abs(cash))}` : `Extra cash vs. leasing ${money.format(cash)}`;
    setText('mechanism-equity-note', `${cashText}; modeled benefit ${money.format(held.benefit)}. Equity is not liquid cash or sale proceeds.`);
    results.forEach(({property,result},index)=>{
      const card=make('button','mechanism-property'); card.type='button'; card.dataset.propertyId=property.id; card.setAttribute('aria-haspopup','dialog');
      card.append(art(property.artKey,`${property.name||'Purchase option'} illustration`,property.image));
      const copy=make('span','mechanism-property-copy');
      copy.append(make('strong','',`${String(index+1).padStart(2,'0')} · ${property.name||'Purchase option'}`),make('small','',property.location||'Not verified'),make('span','',`${number.format(result.practiceSf)} SF practice · ${number.format(result.tenantSf)} SF outside tenants`));
      card.append(copy); grid.append(card);
    });
    const selected= current.property.name || 'Selected option';
    const year=number.format(a.holdYears);
    const benefit=Number(held.benefit);
    const assessment=benefit>=0
      ? `Under the current assumptions, ${selected} models ${money.format(held.equity)} in hold-year equity against ${cashText}, for an estimated ${year}-year benefit of ${money.format(benefit)}. Outside tenant collections reduce mortgage payments you fund after the modeled collection allowance and lease-up period.`
      : `Under the current assumptions, ${selected} models ${money.format(held.equity)} in hold-year equity against ${cashText}, resulting in a modeled ${year}-year benefit of ${money.format(benefit)}. Outside tenant collections reduce mortgage payments you fund after the modeled collection allowance and lease-up period; verify the inputs before drawing a conclusion.`;
    setText('why-structure-copy',assessment);
  }

  function updateFinance() {
    const strategy = data.sections?.find((section) => section.id === 'strategy' && section.visible !== false);
    if (!strategy) return;
    const slider = byId('ti-slider');
    const tiPerSf = slider ? Number(slider.value) : 25;
    setText('ti-output', `$${number.format(tiPerSf)}/SF`);
    setText('ti-range-current', `$${number.format(tiPerSf)}/SF`);
    if (slider) slider.style.background = `linear-gradient(90deg,var(--orange) ${(tiPerSf - 25) / 50 * 100}%,#ffffff36 ${(tiPerSf - 25) / 50 * 100}%)`;
    const helper = window.PresentationFinance;
    const purchases = properties;
    if (!helper || typeof helper.compute !== 'function' || purchases.length === 0) {
      financeCalculation = null;
      ['buildout-value', 'ti-value', 'combined-budget', 'extra-cash', 'ten-year-benefit'].forEach((id) => setText(id, 'Not available'));
      const status = byId('finance-status');
      if (status) status.textContent = 'Ownership scenario is not available for this presentation.';
      renderFinanceComparison([]);
      renderFinanceChart([]);
      renderOwnershipMechanism([]);
      return;
    }
    try {
      const results = purchases.map((property) => ({property, result: helper.compute({price: property.price, totalSf: property.totalSf}, data.assumptions, tiPerSf)}));
      financeCalculation = results.find((entry) => entry.property.id === selectedProperty?.id)?.result || results[0].result;
      selectedProperty = results.find((entry) => entry.property.id === selectedProperty?.id)?.property || results[0].property;
      setText('buildout-value', money.format(financeCalculation.practiceBuildout));
      setText('ti-value', money.format(financeCalculation.tenantTi));
      setText('combined-budget', money.format(financeCalculation.combinedBudget));
      setSignedSummary('extra-cash', financeCalculation.extraCashRequired, true);
      setSignedSummary('ten-year-benefit', financeCalculation.benefit, false);
      setText('summary-period-label', `${number.format(data.assumptions.holdYears)}-YEAR SUMMARY`);
      setText('summary-period', `${number.format(data.assumptions.holdYears)} YEARS`);
      const budget = Math.max(0, financeCalculation.combinedBudget);
      const practicePct = budget > 0 ? financeCalculation.practiceBuildout / budget * 100 : 0;
      const tiPct = budget > 0 ? financeCalculation.tenantTi / budget * 100 : 0;
      byId('buildout-bar').style.width = `${Math.max(0, Math.min(100, practicePct))}%`;
      byId('ti-bar').style.width = `${Math.max(0, Math.min(100, tiPct))}%`;
      const status = byId('finance-status');
      if (status) status.textContent = `Scenario shown for ${selectedProperty.name || 'selected property'} with a $${number.format(tiPerSf)}/SF landlord TI contribution added to project budget.`;
      renderFinanceComparison(results);
      renderFinanceChart(financeCalculation.years || []);
      renderOwnershipMechanism(results);
    } catch (error) {
      financeCalculation = null;
      ['buildout-value', 'ti-value', 'combined-budget', 'extra-cash', 'ten-year-benefit'].forEach((id) => setText(id, 'Not verified'));
      const status = byId('finance-status');
      if (status) status.textContent = 'Review the property and planning assumptions before calculating this scenario.';
      renderFinanceComparison([]);
      renderFinanceChart([]);
      renderOwnershipMechanism([]);
    }
  }

  function renderFinanceComparison(entries) {
    const head = byId('finance-compare-head');
    const body = byId('finance-compare-body');
    if (!head || !body) return;
    head.replaceChildren();
    body.replaceChildren();
    const header = doc.createElement('tr');
    const lead = make('th', '', 'Planning measure'); lead.scope = 'col'; header.append(lead);
    entries.forEach(({property}) => {
      const th = doc.createElement('th'); th.scope = 'col';
      const open = make('button', 'row-title data-open', property.name || 'Property');
      open.type = 'button'; open.dataset.propertyId = property.id; open.setAttribute('aria-haspopup', 'dialog');
      th.append(open); header.append(th);
    });
    head.append(header);
    const rows = [
      ['Minimum practice area', (r) => `${number.format(r.practiceSf)} SF`],
      ['Outside tenant area', (r) => `${number.format(r.tenantSf)} SF`],
      ['Purchase price', (r, p) => money.format(p.price)],
      ['Monthly principal and interest', (r) => money.format(r.payment)],
      ['Practice buildout', (r) => money.format(r.practiceBuildout)],
      ['Landlord TI contribution', (r) => money.format(r.tenantTi)],
      ['Combined project budget', (r) => money.format(r.combinedBudget)],
      ['Appreciation at hold', (r) => money.format(r.appreciation)],
      ['Principal repaid at hold', (r) => money.format(r.principalRepaid)],
      ['Remaining loan balance', (r) => money.format(r.balance)],
      ['Owner equity at hold', (r) => money.format(r.equity)],
      ['Mortgage payments you fund', (r) => displayCarry(r.carry)],
      ['Practice rent avoided', (r) => money.format(r.avoidedPracticeRent)],
      ['Extra cash vs. leasing', (r) => Number(r.extraCashRequired) < 0 ? `Savings vs. leasing ${money.format(Math.abs(r.extraCashRequired))}` : money.format(r.extraCashRequired)],
      ['Estimated financial benefit vs. leasing', (r) => money.format(r.benefit)]
    ];
    rows.forEach(([label, valueFor]) => {
      const row = doc.createElement('tr');
      const th = make('th', '', label); th.scope = 'row'; th.dataset.label = 'Planning measure'; row.append(th);
      entries.forEach(({property, result}) => {
        const end = (result.years || []).find((point) => point.year === Number(data.assumptions.holdYears)) || result;
        const cell = make('td', '', valueFor(end, property));
        cell.dataset.label = property.name || 'Property';
        const field = label.includes('benefit') ? 'benefit' : label.includes('Extra cash') ? 'extraCashRequired' : label.includes('payments you fund') ? 'carry' : null;
        if (field) {
          const amount = Number(end[field]);
          if (Number.isFinite(amount)) {
            if (field === 'benefit') cell.classList.add(amount >= 0 ? 'finance-benefit-positive' : 'finance-benefit-negative');
            else if (field === 'carry' && amount < 0) { cell.textContent = `Surplus ${money.format(Math.abs(amount))}`; cell.classList.add('finance-carry-surplus'); }
            else cell.classList.add(amount >= 0 ? 'finance-negative' : 'finance-positive');
          }
        }
        row.append(cell);
      });
      body.append(row);
    });
  }

  function renderFinanceChart(years) {
    const chart = byId('finance-chart');
    if (!chart) return;
    const title = make('title', '', 'Owner equity and mortgage payments you fund by year');
    title.id = 'chart-title';
    const desc = make('desc', '', years.length ? `Equity and mortgage payments funded by outside rent, with dollar values by year. Negative carry is a surplus.` : 'Scenario values are not available.');
    desc.id = 'chart-desc';
    chart.replaceChildren(title, desc);
    const points = years.filter((row) => Number.isFinite(Number(row.carry)) && Number.isFinite(Number(row.equity)));
    if (points.length < 2) {
      const placeholder = svgEl('text', {x: 450, y: 125, 'text-anchor': 'middle', class: 'chart-placeholder'});
      placeholder.textContent = 'Scenario values not available';
      chart.append(placeholder);
      return;
    }
    const max = Math.max(1, ...points.map((p) => Math.max(Number(p.carry), Number(p.equity))));
    const min = Math.min(0, ...points.map((p) => Math.min(Number(p.carry), Number(p.equity))));
    const span = max - min || 1;
    const xFor = (index) => 36 + index * (828 / (points.length - 1));
    const yFor = (value) => 196 - ((value - min) / span) * 160;
    for (let i = 0; i < 4; i++) chart.append(svgEl('path', {d: `M30 ${36 + i * 54}h840`, class: 'chart-grid'}));
    const rentPath = points.map((p, i) => `${i ? 'L' : 'M'}${xFor(i)} ${yFor(Number(p.carry))}`).join(' ');
    const equityPath = points.map((p, i) => `${i ? 'L' : 'M'}${xFor(i)} ${yFor(Number(p.equity))}`).join(' ');
    chart.append(svgEl('path', {d: rentPath, class: 'chart-path chart-path-rent'}), svgEl('path', {d: equityPath, class: 'chart-path chart-path-equity'}));
    [max, max / 2 + min / 2, min].forEach((value, index) => {
      const label = svgEl('text', {x: 3, y: 41 + index * 77, class: 'chart-axis'});
      label.textContent = compactMoney(value);
      chart.append(label);
    });
    points.forEach((point, index) => {
      if (index % Math.max(1, Math.floor(points.length / 5)) !== 0 && index !== points.length - 1) return;
      const label = svgEl('text', {x: xFor(index), y: 224, 'text-anchor': 'middle', class: 'chart-axis'});
      label.textContent = `Yr ${point.year}`;
      chart.append(label);
    });
  }

  function installReveal() {
    const nodes = doc.querySelectorAll('.scroll-reveal');
    if (!('IntersectionObserver' in window)) { nodes.forEach((node) => node.classList.add('is-visible')); return; }
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
    }), {threshold: 0.12});
    nodes.forEach((node) => observer.observe(node));
  }

  if (!data || !Array.isArray(data.sections)) {
    const status = byId('finance-status');
    if (status) status.textContent = 'Presentation data is unavailable.';
    return;
  }
  renderHeaderAndText();
  installSectionTitles();
  renderMetrics();
  renderDevelopmentMap();
  renderLeaseRows();
  renderPurchaseProperties();
  renderDemographics();
  renderSources();
  installDialog();
  installInteractions();
  installReveal();
    syncLocation();
  updateFinance();
})();
