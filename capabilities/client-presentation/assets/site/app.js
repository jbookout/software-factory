(() => {
  "use strict";
  const d = window.PresentationData,
    $ = (s) => document.querySelector(s),
    $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (x) =>
    String(x ?? "").replace(
      /[&<>"']/g,
      (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c]),
    );
  const money = (x) =>
    Number.isFinite(Number(x))
      ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(Number(x))
      : "Not verified";
  const number = (x) =>
    Number.isFinite(Number(x))
      ? new Intl.NumberFormat("en-US").format(Number(x))
      : "Not verified";
  const properties = (d.properties || []).filter((p) => p.status !== "context"),
    contextProperties = (d.properties || []).filter((p) =>
      p.status === "context"
    ),
    leases = d.leases || [],
    projects = d.developments || [],
    entities = [...properties, ...leases],
    allProperties = d.properties || [],
    byId = Object.fromEntries(
      allProperties.concat(leases).map((x) => [x.id, x]),
    );
  const visibleSections = new Set(
    (d.sections || []).filter((s) => s.visible !== false).map((s) => s.id),
  );
  const navIds = [
    "home",
    ...(leases.length && visibleSections.has("leases") ? ["leases"] : []),
    ...(properties.length && visibleSections.has("purchases")
      ? ["purchases"]
      : []),
    ...(d.strategy?.mode === "owner_occupancy_30_70" && visibleSections.has("strategy")
      ? ["strategy"]
      : []),
    "tour",
    ...(visibleSections.has("demographics") ? ["demographics"] : []),
    "sources",
  ];
  let maps = {}, maplibregl = null;
  let selected = {
    version: null,
    selected_ids: [],
    notes: "",
    property_notes: {},
    csrf_token: null,
    dirty: false,
    busy: false,
    ready: false,
    conflict: false,
  };
  let adapter = null, dialogReturn = null, projectReturn = null;
  const txt = (id, value) => {
    const e = document.getElementById(id);
    if (e) e.textContent = String(value ?? "");
  };
  function title(p) {
    return p.name || p.address || p.id;
  }
  function sourceLine(p) {
    const s = (d.sources || []).find((x) => x.id === p.sourceId);
    return s
      ? `${s.title} · ${s.date}${p.sourcePage ? ` · p. ${p.sourcePage}` : ""}`
      : "Source not configured";
  }
  function buildNav() {
    let n = $("#site-nav");
    n.replaceChildren();
    const labels = {
      home: "Home",
      leases: "Leases",
      purchases: "Purchases",
      strategy: "Strategy",
      demographics: "Demographics",
      tour: "Tour List",
      sources: "Sources",
    };
    navIds.forEach((id) => {
      const a = document.createElement("a");
      a.href = "#" + id;
      a.textContent = labels[id];
      n.append(a);
    });
  }
  function show() {
    const id = (location.hash || "#home").slice(1),
      target = navIds.includes(id) ? document.getElementById(id) : $("#home");
    $$(".site-view").forEach((x) => x.hidden = x !== target);
    $$(".site-nav a").forEach((a) =>
      a.setAttribute(
        "aria-current",
        a.hash === "#" + target.id ? "page" : "false",
      )
    );
    $("#sticky-page-title").textContent = target.dataset.title ||
      d.sections?.find((s) => s.id === target.id)?.title ||
      ({
        home: "Overview",
        purchases: "Purchase Options",
        leases: "Lease Options",
        strategy: "Strategy",
        demographics: "Market Context",
        tour: "Review List",
        sources: "Sources",
      }[target.id] || "");
    window.scrollTo({ top: 0, behavior: "instant" });
    if (target.id === "home") initMap("development-map", projects);
    if (target.id === "purchases") initMap("purchase-map", properties);
    maps[target.id === "home" ? "development-map" : "purchase-map"]?.resize();
  }
  function setBrand() {
    const b = d.brand || {}, p = d.presentation || {};
    for (const id of ["brand-name", "home-brand", "footer-brand"]) {
      txt(id, b.name || "Practice");
    }
    for (const id of ["brand-descriptor", "home-descriptor"]) {
      txt(id, b.descriptor || "Healthcare Property Review");
    }
    txt(
      "presentation-meta",
      `${p.preparedFor || ""} · ${p.scenarioDate || ""}`,
    );
    document.title = `${b.name || "Practice"} | ${
      p.title || "Property Review"
    }`;
    document.documentElement.style.setProperty(
      "--brand-primary",
      "#002f6c",
    );
    document.documentElement.style.setProperty(
      "--brand-primary-dark",
      "#002f6c",
    );
    document.documentElement.style.setProperty(
      "--brand-accent",
      "#f57f29",
    );
    for (const id of ["brand-logo", "home-logo"]) {
      const img = $("#" + id);
      if (b.logo) {
        img.src = b.logo;
        img.alt = `${b.name} logo`;
        img.hidden = false;
      }
    }
  }
  function image(p, alt) {
    return p.image
      ? `<img class="listing-photo" src="${esc(p.image)}" alt="${
        esc(alt || title(p))
      }" loading="lazy">`
      : `<div class="image-placeholder" role="img" aria-label="${
        esc(p.noPhotoReason || "No verified image supplied")
      }">${esc(p.noPhotoReason || "No verified image supplied")}</div>`;
  }
  function facts(p) {
    return [["Asking", Number.isFinite(p.price) ? money(p.price) : null], [
      "Base rent",
      Number.isFinite(p.rentPerSf) ? `${money(p.rentPerSf)}/SF/year` : null,
    ], [
      "Building area",
      Number.isFinite(p.totalSf) ? `${number(p.totalSf)} SF` : null,
    ], [
      "Reported parking",
      p.parkingSpaces === null
        ? "Unknown"
        : p.parkingSpaces === undefined
        ? null
        : number(p.parkingSpaces),
    ], ...(p.details || []).map(detail => [esc(detail.label), esc(detail.value)])].filter((x) => x[1]).map(([a, b]) =>
      `<div><span>${a}</span><strong>${b}</strong></div>`
    ).join("");
  }
  function article(p, i) {
    const links = p.floorplan
      ? `<a class="button secondary" href="${esc(p.floorplan)}" target="_blank" rel="noopener">View supplied floor plan ↗</a>`
      : "";
    return `<article class="property-page"><div class="property-topline"><a href="https://carr.us" target="_blank" rel="noopener" aria-label="CARR website"><img class="carr-logo" src="carr-logo.png" alt="CARR"></a>${
      d.brand.logo
        ? `<img class="brand-logo" src="${esc(d.brand.logo)}" alt="${
          esc(d.brand.name)
        } logo">`
        : ``
    }<span class="brand-wordmark"><strong>${esc(d.brand.name)}</strong><small>${
      esc(d.brand.descriptor)
    }</small></span></div><div class="property-top"><figure>${
      image(p, `${title(p)} property image`)
    }<figcaption>${
      esc(sourceLine(p))
    }</figcaption></figure><div><span class="property-number">OPTION ${
      String(i + 1).padStart(2, "0")
    }</span><h2 id="property-dialog-title">${
      esc(title(p))
    }</h2><p>${esc(p.location || "")}</p><div class="property-facts">${
      facts(p)
    }</div></div></div><h3>Property review</h3><p>${
      esc(p.description || "")
    }</p>${
      p.planningNote
        ? `<div class="review-box"><h4>Planning question</h4><p>${
          esc(p.planningNote)
        }</p></div>`
        : ""
    }${
      p.availabilityNote
        ? `<p class="note"><strong>Availability:</strong> ${
          esc(p.availabilityNote)
        }</p>`
        : ""
    }${
      p.conflicts?.length
        ? `<div class="review-box"><h4>Source conflicts</h4><ul>${
          p.conflicts.map((x) => `<li>${esc(x)}</li>`).join("")
        }</ul></div>`
        : ""
    }<p class="note">Verify condition, availability, clinical layout, access and measurements during due diligence.</p><div class="property-links">${links}</div><p class="source-caption">Source: ${
      esc(sourceLine(p))
    }</p><button class="button add-to-tour" type="button" data-toggle="${
      esc(p.id)
    }" aria-pressed="false">Add to review list</button></article>`;
  }
  function openProperty(id, trigger) {
    let p = byId[id];
    if (!p) return;
    dialogReturn = trigger;
    $("#property-dialog-content").innerHTML = article(
      p,
      entities.indexOf(p),
    );
    syncButtons();
    $("#property-dialog").showModal();
  }
  function renderProperties() {
    const dir = $("#property-directory");
    dir.replaceChildren();
    const screening = $("#purchase-screening");
    screening.replaceChildren();
    for (const criterion of d.market.purchaseScreening || []) {
      const source = d.sources.find(item => item.id === criterion.sourceId);
      const card = document.createElement("article");
      card.innerHTML = `<strong>${esc(criterion.label)}</strong><p>${esc(criterion.description)}</p><small>${esc(source.title)} · ${esc(source.date)}</small>`;
      screening.append(card);
    }
    $("#purchase-screening-section").hidden = !screening.childElementCount;
    properties.forEach((p, i) => {
      let tile = document.createElement("a");
      tile.className = "property-jump";
      tile.href = "#purchases";
      tile.innerHTML = `<span>${String(i + 1).padStart(2, "0")}</span>${
        image(p, title(p))
      }<div><strong>${esc(title(p))}</strong><small>${
        Number.isFinite(p.price) ? money(p.price) : "Price not listed"
      } · ${
        Number.isFinite(p.totalSf)
          ? `${number(p.totalSf)} SF`
          : "Area not verified"
      }</small><small>${
        esc(p.planningNote || "")
      }</small></div><b aria-hidden="true">↗</b>`;
      tile.addEventListener("click", (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        openProperty(p.id, tile);
      });
      dir.append(tile);
    });
    let context = $("#market-context");
    context.replaceChildren();
    contextProperties.forEach((p) => {
      let el = document.createElement("article");
      el.className = "market-context-card";
      el.innerHTML = `${image(p, title(p))}<div><strong>${
        esc(title(p))
      }</strong><p>${esc(p.description || "")}</p><span>${
        esc(sourceLine(p))
      }</span></div>`;
      context.append(el);
    });
  }
  function openCurrentPractice(trigger) {
    const current = d.currentPractice;
    if (!current) return;
    dialogReturn = trigger;
    $("#property-dialog-content").innerHTML = `<article class="property-page"><div class="property-topline"><a href="https://carr.us" target="_blank" rel="noopener" aria-label="CARR website"><img class="carr-logo" src="carr-logo.png" alt="CARR"></a>${d.brand.logo ? `<img class="brand-logo" src="${esc(d.brand.logo)}" alt="${esc(d.brand.name)} logo">` : ""}<span class="brand-wordmark"><strong>${esc(d.brand.name)}</strong><small>${esc(d.brand.descriptor)}</small></span></div><span class="property-number">CURRENT PRACTICE · CONTEXT</span><h2 id="property-dialog-title">${esc(current.name)}</h2><p>${esc(current.location)}</p><p>${esc(current.description)}</p><p class="note">The locator is approximate and is not an entrance or navigation destination.</p><p class="source-caption">${esc(sourceLine(current))}</p></article>`;
    $("#property-dialog").showModal();
  }

  function initMap(id, items) {
    let el = document.getElementById(id);
    if (!el || maps[id]) return;
    if (!maplibregl) {
      el.textContent =
        "Map unavailable. The source-linked cards remain available.";
      return;
    }
    const center = d.locator?.center;
    if (!center) {
      el.textContent =
        "No map center configured. Entries remain listed without pins.";
      return;
    }
    let style = d.locator.style;
    if (!style) {
      el.textContent =
        "No basemap style configured. Entries remain listed without pins.";
      return;
    }
    el.replaceChildren();
    let map = new maplibregl.Map({
      container: id,
      style,
      center: [center.lon, center.lat],
      zoom: d.locator.zoom || 10,
      attributionControl: true,
      scrollZoom: false,
    });
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );
    maps[id] = map;
    const preview = new maplibregl.Popup({closeButton:false,closeOnClick:false,maxWidth:"240px",offset:20,className:"map-pin-preview"});
    const bindMarkerPreview = (button, point, record) => {
      const showPreview = () => preview.setLngLat(point).setHTML(`${image(record,title(record))}<strong class="map-preview-title">${esc(title(record))}</strong><span>Approximate area locator · Open for full details</span>`).addTo(map);
      button.addEventListener("mouseenter", showPreview);
      button.addEventListener("focus", showPreview);
      for (const event of ["mouseleave", "blur", "click"]) button.addEventListener(event, () => preview.remove());
    };
    const markers = [];
    const coordinates = [];
    let pins = 0;
    items.forEach((p, i) => {
      if (!p.locator) return;
      let button = document.createElement("button");
      button.type = "button";
      button.className = "map-pin";
      button.innerHTML = `<span class="pin-stem" hidden></span><span class="pin-number">${i + 1}</span>`;
      button.dataset.entityId = p.id;
      button.title = `${title(p)} · approximate locator`;
      button.setAttribute(
        "aria-label",
        `${title(p)} approximate area locator, not a navigation destination`,
      );
      button.addEventListener(
        "click",
        () => byId[p.id] ? openProperty(p.id, button) : openProject(p, button),
      );
      const marker = new maplibregl.Marker({ element: button }).setLngLat([
        p.locator.lon,
        p.locator.lat,
      ]).addTo(map);
      markers.push({marker, button, point: [p.locator.lon, p.locator.lat]});
      bindMarkerPreview(button,[p.locator.lon,p.locator.lat],p);
      coordinates.push([p.locator.lon, p.locator.lat]);
      pins++;
    });
    const current = d.currentPractice;
    if (current?.locator) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "map-practice";
      button.innerHTML = `<span class="pin-stem" hidden></span><span class="pin-number">P</span>`;
      button.title = `${current.name} · approximate locator`;
      button.setAttribute("aria-label", `${current.name}, approximate current-practice context locator, not a navigation destination`);
      button.addEventListener("click", () => openCurrentPractice(button));
      button.dataset.entityId = "current-practice";
      const marker = new maplibregl.Marker({element: button}).setLngLat([current.locator.lon, current.locator.lat]).addTo(map);
      markers.push({marker, button, point: [current.locator.lon, current.locator.lat]});
      coordinates.push([current.locator.lon, current.locator.lat]);
      pins++;
    }
    const status = id === "purchase-map" ? $("#purchase-map-status") : null;
    if (status) {
      const total = items.length + (current?.locator ? 1 : 0);
      status.textContent =
        `${pins} of ${total} entries have source-backed approximate locators. Unpinned entries remain in the cards. Locators are not entrances or navigation destinations.`;
    }
    const layoutPins = () => {
      const placed = [];
      const width = el.clientWidth, height = el.clientHeight;
      for (const {marker, button, point} of markers) {
        const projected = map.project(point);
        let position;
        for (let ring = 0; ring < 15 && !position; ring++) {
          const candidates = ring === 0 ? [[0, 0]] : Array.from({length: ring * 8}, (_, i) => [Math.cos(i / (ring * 8) * Math.PI * 2) * ring * 38, Math.sin(i / (ring * 8) * Math.PI * 2) * ring * 38]);
          for (const [dx, dy] of candidates) {
            const candidate = {x: Math.max(24, Math.min(width - 24, projected.x + dx)), y: Math.max(24, Math.min(height - 24, projected.y + dy))};
            if (placed.every(p => Math.abs(p.x - candidate.x) >= 36 || Math.abs(p.y - candidate.y) >= 36)) { position = candidate; break; }
          }
        }
        if (!position) { button.hidden = true; continue; }
        button.hidden = false;
        const offset = [position.x - projected.x, position.y - projected.y];
        marker.setOffset(offset);
        const stem = button.querySelector(".pin-stem");
        if (stem) {
          const distance = Math.hypot(...offset);
          stem.hidden = distance < 2;
          stem.style.width = `${distance}px`;
          stem.style.transform = `rotate(${Math.atan2(-offset[1], -offset[0])}rad)`;
        }
        placed.push(position);
      }
    };
    map.on("load", () => {
      map.resize();
      if (coordinates.length) {
        const bounds = coordinates.reduce((b, coordinate) => b.extend(coordinate), new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));
        map.fitBounds(bounds, {padding: 60, maxZoom: 13, duration: 0});
      }
      layoutPins();
      el.dataset.mapReady = "true";
    });
    map.on("moveend", layoutPins);
    map.on("resize", layoutPins);
  }
  async function loadMaps() {
    try {
      maplibregl = await import("https://unpkg.com/maplibre-gl@6.13.0/dist/maplibre-gl.mjs");
      const view = $(".site-view:not([hidden])");
      if (view.id === "home") initMap("development-map", projects);
      if (view.id === "purchases") initMap("purchase-map", properties);
    } catch {
      for (const id of ["development-map", "purchase-map"]) {
        $("#" + id).textContent = "Map unavailable. The source-linked cards remain available.";
      }
    }
  }
  function renderLeases() {
    const dir = $("#lease-directory");
    dir.replaceChildren();
    leases.forEach((p, i) => {
      const tile = document.createElement("a");
      tile.className = "property-jump";
      tile.href = "#leases";
      tile.innerHTML = `<span>${String(i + 1).padStart(2, "0")}</span>${
        image(p, title(p))
      }<div><strong>${esc(title(p))}</strong><small>${
        Number.isFinite(p.rentPerSf)
          ? `${money(p.rentPerSf)}/SF/year`
          : "Rent not listed"
      } · ${
        Number.isFinite(p.totalSf)
          ? `${number(p.totalSf)} SF`
          : "Area not verified"
      }</small></div>`;
      tile.addEventListener("click", (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        openProperty(p.id, tile);
      });
      dir.append(tile);
    });
    if (!leases.length) $("#leases").hidden = true;
  }
  function renderProjects() {
    const dir = $("#development-directory");
    dir.replaceChildren();
    projects.forEach((p, i) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "development-tile";
      tile.dataset.project = p.id;
      tile.innerHTML = `${image(p, p.name)}<span class="development-number">${String(i + 1).padStart(2, "0")}</span><div><h4>${esc(p.name)}</h4><p>${esc(p.location || "")}</p><p>${esc(p.status || "Status not verified")}</p><span class="tile-action">View project details ↗</span></div>`;
      dir.append(tile);
    });
    $$("[data-project]").forEach((el) =>
      el.addEventListener(
        "click",
        () =>
          openProject(projects.find((p) => p.id === el.dataset.project), el),
      )
    );
  }
  function openProject(p, trigger) {
    if (!p) return;
    projectReturn = trigger || document.activeElement;
    let src = (d.sources || []).filter((s) =>
      p.sourceId === s.id || p.sourceIds?.includes(s.id)
    );
    $("#project-dialog-content").innerHTML = `<h2 id="project-dialog-title">${
      esc(p.name)
    }</h2>${image(p, p.name)}<p><strong>Location:</strong> ${
      esc(p.location || "Not specified")
    }</p><p><strong>Map:</strong> ${
      p.locator
        ? "Approximate area locator"
        : "No source-backed point; no map pin."
    }</p><p><strong>Status:</strong> ${esc(p.status || "Not verified")}</p><p>${
      esc(p.description || "")
    }</p><h3>Sources</h3><ul>${
      src.map((s) =>
        `<li>${
          s.url
            ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${
              esc(s.title)
            } · ${esc(s.date)} ↗</a>`
            : `${esc(s.title)} · ${esc(s.date)}`
        }</li>`
      ).join("")
    }</ul><p class="note">Map locators are not boundaries or navigation destinations. Development announcements do not establish patient demand.</p>`;
    $("#project-dialog").showModal();
  }
  function renderMarket() {
    let m = d.market || {}, p = d.presentation || {};
    txt("market-title", m.title || p.title || "Market and property review");
    txt("market-summary", m.summary);
    txt("market-note", m.note);
    const snapshot = $("#home-demographics");
    snapshot.hidden = !navIds.includes("demographics");
    if (!snapshot.hidden) {
      const model = window.PresentationDemographics.derive(d.demographics);
      const population = model.population.values.at(-1);
      const source = d.sources.find(item => item.id === model.population.sourceId);
      const incomeSource = d.sources.find(item => item.id === model.income.sourceId);
      $("#home-demographic-overview").innerHTML = `<a href="#demographics"><strong>${number(population.value)}</strong><span>Population · ${esc(population.label)} · people</span><small>${esc(source.title)}</small></a><a href="#demographics"><strong>${number(model.income.total)}</strong><span>Households · ${esc(model.income.period)}</span><small>${esc(incomeSource.title)}</small></a><a href="#demographics"><strong>${money(model.income.median.value)}</strong><span>Median household income · USD/year</span><small>${esc(model.income.period)} · ${esc(incomeSource.title)}</small></a>`;
    }
    const next = $(".home-actions a");
    next.href = properties.length ? "#purchases" : "#leases";
    next.textContent = properties.length ? "Review purchase options ↗" : "Review lease options ↗";
    txt("development-title", m.developmentTitle || "Projects in context");

  }
  function renderDemographics() {
    txt("demographics-title", d.demographics?.title || "Demographic context");
    let charts = $("#demographic-charts");
    charts.replaceChildren();
    if (!d.demographics) return;
    const model = window.PresentationDemographics.derive(d.demographics);
    const freshness = document.createElement("p");
    freshness.id = "demographic-freshness";
    freshness.className = "note";
    freshness.textContent = `Research as of ${model.asOfDate} · ${model.geography.label} · ${window.PresentationDemographics.freshness(model, new Date().toISOString().slice(0, 10))}`;
    charts.append(freshness);
    for (const s of model.series) {
      const source = d.sources.find(item => item.id === s.sourceId);
      const c = document.createElement("article");
      c.className = "visual-card";
      const max = Math.max(1, ...s.values.map(x => x.value));
      c.innerHTML = `<h3>${esc(s.name)}</h3><p class="visual-subtitle">${esc(model.geography.label)} · ${esc(s.period)} · ${esc(s.unit)}</p>${s.values.map(x => `<div class="bar-row"><span>${esc(x.label)}</span><div><i style="width:${x.value / max * 100}%"></i></div><strong>${number(x.value)}${x.share == null ? "" : ` (${(x.share * 100).toFixed(1)}%)`}</strong></div>`).join("")}<p class="source-caption">${esc(source.title)} · ${esc(source.date)}</p>`;
      charts.append(c);
    }
    const income = document.createElement("article");
    income.className = "visual-card income-summary";
    income.innerHTML = `<h3>${esc(model.income.median.label)}</h3><strong>${money(model.income.median.value)}/year</strong><p>${number(model.income.total)} households · ${esc(model.income.period)} · ${esc(model.geography.label)}</p><p class="source-caption">${esc(d.sources.find(s => s.id === model.income.sourceId).title)}</p>`;
    charts.append(income);
    let extra = $("#demographics-additional");
    extra.replaceChildren();
    for (const x of d.demographics?.cards || []) {
      const source = (d.sources || []).find((item) => item.id === x.sourceId);
      let c = document.createElement("article");
      c.className = "demo-card";
      c.innerHTML = `<span>${esc(x.geography)}</span><h3>${
        esc(x.title)
      }</h3><p>${esc(x.description || "")}</p><p class="source-caption">${esc(x.period)} · ${esc(source?.title || "Source not configured")} · ${esc(source?.date || "Date not configured")}</p>${
        x.url || source?.url
          ? `<a href="${esc(x.url || source.url)}" target="_blank" rel="noopener">Source ↗</a>`
          : ""
      }`;
      extra.append(c);
    }
  }
  function renderSources() {
    let list = $("#sources-list");
    list.replaceChildren();
    (d.sources || []).forEach((s) => {
      let c = document.createElement("article");
      c.className = "source-item";
      c.innerHTML = `<h3>${esc(s.title)}</h3><p>${esc(s.date)}${
        s.geography ? " · " + esc(s.geography) : ""
      }</p><p>${esc(s.notes || "")}</p>${
        s.url
          ? `<a href="${
            esc(s.url)
          }" target="_blank" rel="noopener">Open source ↗</a>`
          : ""
      }`;
      list.append(c);
    });
    txt("sources-title", d.market?.sourcesTitle || "Sources and next steps");
    txt("locator-disclaimer", d.locator?.disclaimer || "Map points are approximate and are not navigation destinations.");
    txt(
      "sources-intro",
      d.market?.sourcesIntro || "Review named sources, geography and dates.",
    );
  }
  function renderStrategy() {
    if (d.strategy.mode !== "owner_occupancy_30_70" || !visibleSections.has("strategy")) {
      $("#strategy").hidden = true;
      return;
    }
    txt("strategy-title", d.strategy.title || "Practice occupancy strategy");
    txt("strategy-overview", d.strategy.summary || "");
    txt("strategy-explainer", "The 30/70 scenario models 30% practice occupancy and 70% outside tenant space. Rental offsets use only the assumptions shown here and do not establish owner occupancy.");
    const eligible = properties.filter((p) =>
      Number.isFinite(p.price) && Number.isFinite(p.totalSf)
    );
    const controls = $("#finance-controls");
    controls.replaceChildren();
    const controlGrid = document.createElement("div");
    controlGrid.className = "scenario-fields";
    const propertyLabel = document.createElement("label");
    propertyLabel.textContent = "Purchase option";
    const picker = document.createElement("select");
    picker.id = "finance-property";
    for (const property of eligible) {
      const option = document.createElement("option");
      option.value = property.id;
      option.textContent = title(property);
      picker.append(option);
    }
    propertyLabel.append(picker);
    controlGrid.append(propertyLabel);
    const tiRange = d.strategy.tiRange;
    let selectedTiRate = d.strategy.tiContributionPerSf;
    for (const id of ["strategy-ti-controls", "ownership-ti-controls"]) {
      const field = document.createElement("fieldset");
      field.className = "ti-toggle";
      const legend = document.createElement("legend");
      legend.textContent = "Tenant TI Allowance / SF · Updates every comparison";
      field.append(legend);
      for (let rate = tiRange.min; rate <= tiRange.max; rate += tiRange.step) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "radio";
        input.name = id + "-rate";
        input.dataset.tenantTiRate = "";
        input.value = String(rate);
        input.checked = rate === selectedTiRate;
        const span = document.createElement("span");
        span.textContent = money(rate);
        label.append(input, span);
        field.append(label);
        input.addEventListener("change", () => {
          selectedTiRate = rate;
          document.querySelectorAll("[data-tenant-ti-rate]").forEach(node => { node.checked = Number(node.value) === rate; });
          update();
        });
      }
      $("#" + id).replaceChildren(field);
    }
    controls.append(controlGrid);
    const assumptions = d.assumptions;
    const tiRate = () => selectedTiRate;
    const model = (property, rate = tiRate()) => window.PresentationFinance.compute(
      {price: property.price, totalSf: property.totalSf}, assumptions, rate,
    );
    const lineProperty = $("#line-property");
    lineProperty.replaceChildren(...eligible.map((property) => {
      const option = document.createElement("option");
      option.value = property.id;
      option.textContent = title(property);
      return option;
    }));
    const comparison = (id, rows, measures) => {
      $("#" + id).innerHTML = `<thead><tr><th>Measure</th>${rows.map(({property}) => `<th><button type="button" class="text-button" data-preview="${esc(property.id)}">${esc(title(property))}</button></th>`).join("")}</tr></thead><tbody>${measures.map(([label, value]) => `<tr><th>${esc(label)}</th>${rows.map(row => `<td>${esc(value(row.result, row.property))}</td>`).join("")}</tr>`).join("")}</tbody>`;
    };
    function update() {
      const active = byId[picker.value] || eligible[0];
      const activeResult = model(active);
      txt("finance-results", `${title(active)} · Illustrative year ${activeResult.year}: estimated property equity ${money(activeResult.equity)}; modeled cash required ${money(activeResult.extraCashRequired)}; outside rent received ${money(activeResult.outsideRent)}. Equity is not liquid cash. Assumptions: ${(assumptions.assumptionNotes || []).join(" ")}`);
      const rows = eligible.map((property) => ({property, result: model(property)}));
      $("#strategy-benefits").innerHTML = [["Practice occupancy", `${number(activeResult.practiceSf)} SF allocated to the practice.`], ["Outside-tenant space", `${number(activeResult.tenantSf)} SF allocated to outside tenants under the stated scenario.`], ["Mortgage contribution", `${money(activeResult.carry)} over ${assumptions.holdYears} years after modeled outside rent, before other owner costs.`], ["Estimated equity", `${money(activeResult.equity)} at year ${assumptions.holdYears}; a balance-sheet estimate rather than liquid cash or profit.`]].map(([label, value],i) => `<article class="strategy-benefit"><span class="benefit-icon">${i+1}</span><h4>${label}</h4><p>${value}</p></article>`).join("");
      $("#strategy-assumptions").innerHTML = [[`${(assumptions.downPaymentFraction*100).toFixed(1)}%`, "Down payment"], [`${(assumptions.annualInterest*100).toFixed(2)}%`, "Annual interest"], [String(assumptions.amortizationYears), "Amortization · years"], [`${(assumptions.annualAppreciation*100).toFixed(2)}%`, "Annual appreciation assumption"], [money(assumptions.annualRentPerSf), "Rent / SF / year"], [String(assumptions.fillMonths), "Lease-up · months"]].map(([value,label]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join("");
      $("#allocation-spaces").innerHTML = rows.map(({property,result}) => `<button type="button" class="allocation-space-row text-button" data-preview="${esc(property.id)}"><b>${esc(title(property))}</b><div class="allocation-space-bar"><span class="practice" style="width:${result.practiceSf/property.totalSf*100}%"></span><span class="tenants" style="width:${result.tenantSf/property.totalSf*100}%"></span></div><div class="allocation-space-values"><span>Practice ${number(result.practiceSf)} SF</span><span>Outside tenants ${number(result.tenantSf)} SF</span></div></button>`).join("");
      $("#rent-coverage").innerHTML = rows.map(({property,result}) => {const rent=result.stabilizedMonthlyRent, scale=Math.max(1,rent,result.payment);return `<button type="button" class="coverage-row text-button" data-preview="${esc(property.id)}"><b>${esc(title(property))}</b><div class="coverage-measure"><span>Outside rent</span><i class="coverage-income" style="width:${rent/scale*100}%"></i><strong>${money(rent)}/month</strong></div><div class="coverage-measure"><span>Loan P&amp;I</span><i class="coverage-gap" style="width:${result.payment/scale*100}%"></i><strong>${money(result.payment)}/month</strong></div></button>`;}).join("");
      comparison("strategy-table", rows, [["Purchase price",(r,p)=>money(p.price)], ["Building area",(r,p)=>`${number(p.totalSf)} SF`], ["Practice area",r=>`${number(r.practiceSf)} SF`], ["Outside-tenant area",r=>`${number(r.tenantSf)} SF`], ["Down payment",r=>money(r.downPayment)], ["Loan amount",r=>money(r.loan)], ["Monthly principal and interest",r=>money(r.payment)]]);
      $("#strategy-highlights").innerHTML = rows.map(({property}) => `<button type="button" class="property-jump" data-preview="${esc(property.id)}">${image(property,title(property))}<div><strong>${esc(title(property))}</strong><small>${esc(property.planningNote || property.description)}</small><small>${esc(sourceLine(property))}</small><span class="tile-action">Review the property ↗</span></div></button>`).join("");
      comparison("buildout-table", rows, [["Practice area",r=>`${number(r.practiceSf)} SF`], ["Practice buildout / SF",()=>money(assumptions.practiceBuildoutPerSf)], ["Practice buildout budget",r=>money(r.practiceBuildout)], ["Outside-tenant area",r=>`${number(r.tenantSf)} SF`], ["Tenant TI / SF",()=>money(tiRate())], ["Tenant TI budget",r=>money(r.tenantTi)], ["Combined improvement budget",r=>money(r.combinedBudget)]]);
      comparison("cash-carry-table", rows, [["Down payment",r=>money(r.downPayment)], ["Mortgage payments",r=>money(r.mortgagePayments)], ["Outside rent received",r=>money(r.outsideRent)], ["Mortgage contribution",r=>money(r.carry)], ["Practice rent avoided",r=>money(r.avoidedPracticeRent)], ["Tenant TI budget",r=>money(r.tenantTi)], ["Additional cash compared with leasing",r=>money(r.extraCashRequired)]]);
      comparison("annual-carry-table", rows, Array.from({length:assumptions.holdYears},(_,i)=>[`Year ${i+1} · mortgage contribution`,r=>money(r.years[i+1].carry-r.years[i].carry)]));
      comparison("equity-components", rows, [[`Year ${assumptions.holdYears} · property value`,r=>money(r.value)], ["Remaining loan",r=>money(r.balance)], ["Initial down payment",r=>money(r.downPayment)], ["Principal repaid",r=>money(r.principalRepaid)], ["Signed appreciation",r=>money(r.appreciation)], ["Estimated equity",r=>money(r.equity)]]);
      comparison("ownership-summary", rows, [["Estimated property equity",r=>money(r.equity)], ["Additional cash compared with leasing",r=>money(r.extraCashRequired)], ["Modeled equity less additional cash",r=>money(r.benefit)]]);
      $("#equity-year").max = String(assumptions.holdYears);
      const year = Math.min(Number($("#equity-year").value || assumptions.holdYears), assumptions.holdYears);
      $("#equity-year-label").textContent = String(year);
      const pointAt = (r, y) => r.years[Math.max(0, Math.min(y, r.years.length - 1))];
      const maxValue = Math.max(...rows.flatMap(({result}) => { const point = pointAt(result, year); return [point.value, point.balance]; }), 1);
      $("#equity-chart").innerHTML = rows.map(({property, result}) => {
        const point = pointAt(result, year);
        return `<button type="button" class="equity-row" data-preview="${esc(property.id)}"><div class="equity-row-top"><b>${esc(title(property))}</b><strong>${money(point.equity)} Equity</strong></div><div class="equity-bar-line"><span>Property value</span><div class="equity-value-bar" role="img" aria-label="Value ${money(point.value)}" style="width:${point.value / maxValue * 100}%"></div></div><div class="equity-bar-line"><span>Remaining loan</span><div class="equity-loan-bar" role="img" aria-label="Remaining loan ${money(point.balance)}" style="width:${point.balance / maxValue * 100}%"></div></div><div class="equity-row-meta"><span>Value ${money(point.value)}</span><span>Loan ${money(point.balance)}</span><span>Principal repaid ${money(point.principalRepaid)}</span><span>Appreciation ${money(point.appreciation)}</span></div></button>`;
      }).join("");
      const lineView = $("#line-view").value;
      $("#line-property-control").hidden = lineView !== "carry";
      const selected = eligible.find((property) => property.id === lineProperty.value) || active;
      const svgW = 860, svgH = 300, left = 76, right = 24, top = 18, bottom = 42;
      const years = Array.from({length: assumptions.holdYears + 1}, (_, i) => i);
      const chartSeries = lineView === "app"
        ? rows.map(({property, result}, i) => ({name: title(property), color: ["#f57f29", "#002f6c", "#147d56"][i % 3], values: years.map((y) => pointAt(result, y).appreciation)}))
        : (() => { const result = model(selected); return [{name: "Property Equity", color: "#147d56", values: years.map((y) => pointAt(result, y).equity)}, {name: "Cumulative Cash Carry", color: "#b42318", values: years.map((y) => pointAt(result, y).carry)}]; })();
      const values = chartSeries.flatMap((series) => series.values);
      const floor = Math.min(0, ...values), ceiling = Math.max(0, ...values);
      const range = ceiling - floor || 1;
      const x = (i) => left + (years.length <= 1 ? 0 : i / (years.length - 1)) * (svgW - left - right);
      const y = (v) => svgH - bottom - (v - floor) / range * (svgH - top - bottom);
      let svg = `<svg class="ownership-line-svg" viewBox="0 0 ${svgW} ${svgH}" role="img" aria-label="${lineView === "app" ? "Appreciation" : "Equity and cash carry"} over ${assumptions.holdYears} years">`;
      for (let i = 0; i <= 4; i++) { const value = floor + (ceiling - floor) * i / 4; svg += `<line x1="${left}" y1="${y(value)}" x2="${svgW-right}" y2="${y(value)}" stroke="#dce4ee"/><text x="${left-8}" y="${y(value)+4}" text-anchor="end">${money(value)}</text>`; }
      svg += `<line x1="${left}" y1="${y(0)}" x2="${svgW-right}" y2="${y(0)}" stroke="#8198b9" stroke-width="2"/>`;
      for (let i = 0; i < years.length; i++) svg += `<text x="${x(i)}" y="${svgH-bottom+22}" text-anchor="middle">${years[i]}</text>`;
      for (const series of chartSeries) { svg += `<polyline points="${series.values.map((value, i) => `${x(i)},${y(value)}`).join(" ")}" fill="none" stroke="${series.color}" stroke-width="3"/>`; for (let i=0;i<series.values.length;i++) svg += `<circle cx="${x(i)}" cy="${y(series.values[i])}" r="4" fill="white" stroke="${series.color}" stroke-width="2"><title>${esc(series.name)} · Year ${years[i]}: ${money(series.values[i])}</title></circle>`; }
      svg += "</svg>";
      $("#ownership-line-chart").innerHTML = svg + `<div class="line-legend">${chartSeries.map((series) => `<span><i style="background:${series.color}"></i>${esc(series.name)}</span>`).join("")}</div>`;
      const compare = chartSeries.map((series) => `${esc(series.name)}: ${money(series.values.at(-1))}`).join(" · ");
      txt("line-summary", `Year ${assumptions.holdYears} · ${compare}`);
      txt("line-note", lineView === "carry" ? "Cash carry is mortgage payments less collected outside tenant rent under the stated lease-up and collection assumptions. It excludes other owner costs unless expressly included. This is a limited balance-sheet comparison, not profit or a cash-flow break-even claim." : `Appreciation gain uses the stated ${(assumptions.annualAppreciation * 100).toFixed(2)}% annual assumption. Appreciation alone does not establish an investment return.`);
    }
    picker.addEventListener("change", update);
    $("#line-view").addEventListener("change", update);
    $("#line-property").addEventListener("change", update);
    $("#equity-year").max = String(assumptions.holdYears);
    $("#equity-year").value = String(assumptions.holdYears);
    $("#equity-year").addEventListener("input", update);
    update();
  }
  const feedback = d.feedback || { mode: "disabled" };
  function status(text, state = "info") {
    $("#tour-save-status").textContent = text;
    $("#tour-save-status").dataset.state = state;
  }
  function syncButtons() {
    let s = new Set(selected.selected_ids);
    $$("[data-toggle]").forEach((b) => {
      let yes = s.has(b.dataset.toggle);
      b.textContent = yes ? "Added · Remove from list" : "Add to review list";
      b.setAttribute("aria-pressed", String(yes));
    });
  }
  function renderTour() {
    let available = $("#tour-available"), list = $("#tour-selected");
    available.replaceChildren();
    list.replaceChildren();
    let ss = new Set(selected.selected_ids);
    entities.forEach((p) => {
      let yes = ss.has(p.id), row = document.createElement(yes ? "li" : "div");
      row.className = yes ? "tour-item" : "tour-option";
      row.draggable = true;
      row.dataset.propertyId = p.id;
      row.innerHTML = `<span class="drag-handle" aria-hidden="true">⠿</span><button class="tour-open" type="button" data-preview="${
        esc(p.id)
      }" aria-label="Review ${esc(title(p))}">${
        p.image ? `<img src="${esc(p.image)}" alt="">` : ""
      }<span>${
        yes ? `<strong>${esc(title(p))}</strong>` : esc(title(p))
      }<small>${
        Number.isFinite(p.price)
          ? money(p.price)
          : Number.isFinite(p.rentPerSf)
          ? `${money(p.rentPerSf)}/SF/year`
          : ""
      }</small></span></button>${
        yes
          ? `<button type="button" data-remove="${esc(p.id)}">Remove</button>`
          : `<button type="button" data-add="${esc(p.id)}">Add</button>`
      }${yes ? `<label class="property-note">Notes for CARR · ${esc(title(p))}<textarea data-property-note="${esc(p.id)}" rows="3" maxlength="2000">${esc(selected.property_notes[p.id] || "")}</textarea></label>` : ""}`;
      (yes ? list : available).append(row);
    });
    if (!selected.selected_ids.length) {
      list.innerHTML = '<li class="tour-empty">No options selected yet.</li>';
    }
    $("#tour-save").disabled = !selected.ready || !selected.dirty ||
      selected.busy || selected.conflict;
    syncButtons();
  }
  function changed() {
    selected.dirty = true;
    status(feedback.mode === "shared" ? "Unsaved changes. Save to share this review list." : "Session selections updated. Shared saving is disabled.", "dirty");
    renderTour();
  }
  function add(id) {
    if (!byId[id] || selected.selected_ids.includes(id)) return;
    selected.selected_ids.push(id);
    changed();
  }
  function remove(id) {
    selected.selected_ids = selected.selected_ids.filter((x) => x !== id);
    delete selected.property_notes[id];
    changed();
  }
  async function loadSelection() {
    if (feedback.mode !== "shared") {
      status(
        "Shared saving is disabled. This review list is not shared or saved.",
        "disabled",
      );
      $("#tour-save").hidden = $("#tour-reload").hidden = true;

      renderTour();
      return;
    }
    adapter = window.PresentationSelectionAdapter.createSelectionAdapter({
      endpoint: feedback.endpoint,
      csrfHeader: feedback.csrfHeader || "X-CSRF-Token",
    });
    status("Loading shared review list…");
    let r = await adapter.load();
    if (r.status === "loaded") {
      Object.assign(selected, {
        version: r.state.version,
        selected_ids: r.state.selected_ids.filter((id) => byId[id]),
        notes: r.state.notes,
        property_notes: r.state.property_notes,
        csrf_token: r.state.csrf_token,
        ready: true,
        dirty: false,
        conflict: false,
      });
      status(
        r.state.updated_at
          ? `Shared list loaded · last saved ${
            new Date(r.state.updated_at).toLocaleString()
          }`
          : "Shared list loaded.",
        "saved",
      );
    } else {
      selected.ready = false;
      status(
        r.status === "unavailable"
          ? "Shared service unavailable; changes cannot be saved."
          : `Shared list could not load (${r.error || "error"}).`,
        "error",
      );
    }
    renderTour();
  }
  async function saveSelection() {
    if (!adapter || !selected.ready || !selected.dirty || selected.busy) return;
    selected.busy = true;
    status("Saving shared review list…", "saving");
    renderTour();
    let r = await adapter.save({
      selected_ids: selected.selected_ids,
      notes: selected.notes,
      property_notes: selected.property_notes,
    });
    selected.busy = false;
    if (r.status === "saved") {
      Object.assign(selected, {
        version: r.state.version,
        selected_ids: r.state.selected_ids.filter((id) => byId[id]),
        notes: r.state.notes,
        property_notes: r.state.property_notes,
        csrf_token: r.state.csrf_token,
        dirty: false,
      });
      status(
        "Saved to the shared review list. This is not a confirmed appointment.",
        "saved",
      );
    } else if (r.status === "conflict") {
      Object.assign(selected, {
        version: r.state.version,
        csrf_token: r.state.csrf_token,
        ready: false,
        conflict: true,
        dirty: true,
      });
      status(
        "A newer shared list exists. Your local edits remain here; reload the shared version to reconcile before saving.",
        "conflict",
      );
    } else {status(
        r.status === "unavailable"
          ? "Shared service unavailable. Your edits remain here."
          : `Save failed (${r.error || r.status}). Your edits remain here.`,
        "error",
      );}
    renderTour();
  }
  function bindTour() {
    for (const [selector, action] of [["#tour-available", remove], ["#tour-selected", add]]) {
      const area = $(selector);
      area.addEventListener("dragover", e => { e.preventDefault(); area.classList.add("drop-target"); });
      area.addEventListener("dragleave", () => area.classList.remove("drop-target"));
      area.addEventListener("drop", e => { e.preventDefault(); area.classList.remove("drop-target"); action(e.dataTransfer.getData("text/plain")); });
    }
    $("#tour").addEventListener("dragstart", e => {
      const row = e.target.closest("[data-property-id]");
      if (!row || e.target.closest("textarea")) {e.preventDefault();return;}
      e.dataTransfer.setData("text/plain", row.dataset.propertyId);
      e.dataTransfer.effectAllowed = "move";
    });
    document.addEventListener("click", (e) => {
      let b = e.target.closest(
        "[data-preview],[data-add],[data-remove],[data-toggle]",
      );
      if (!b) return;
      if (b.dataset.preview) openProperty(b.dataset.preview, b);
      if (b.dataset.add) add(b.dataset.add);
      if (b.dataset.remove) remove(b.dataset.remove);
      if (b.dataset.toggle) {
        selected.selected_ids.includes(b.dataset.toggle)
          ? remove(b.dataset.toggle)
          : add(b.dataset.toggle);
      }
    });
    $("#tour-selected").addEventListener("input", (e) => {
      if (!e.target.dataset.propertyNote) return;
      selected.property_notes[e.target.dataset.propertyNote] = Array.from(e.target.value).slice(0, 2000).join("");
      selected.dirty = true;
      status(feedback.mode === "shared" ? "Unsaved changes. Save to share this review list." : "Session notes updated. Shared saving is disabled.", "dirty");
      $("#tour-save").disabled = !selected.ready || selected.busy || selected.conflict;
    });
    $("#tour-save").addEventListener("click", saveSelection);
    $("#tour-reload").addEventListener("click", () => {
      if (
        selected.dirty &&
        !confirm("Reload the shared version and discard unsaved edits?")
      ) return;
      selected.dirty = false;
      selected.conflict = false;
      loadSelection();
    });
    renderTour();
    loadSelection();
  }
  function init() {
    buildNav();
    for (const id of ["purchases", "leases", "strategy", "demographics"]) {
      if (!navIds.includes(id)) $("#" + id).hidden = true;
    }
    setBrand();
    const header = $(".site-header");
    new ResizeObserver(() => document.documentElement.style.setProperty("--header-height", `${header.getBoundingClientRect().height}px`)).observe(header);
    renderMarket();
    renderProperties();
    renderLeases();
    renderProjects();
    renderDemographics();
    renderSources();
    renderStrategy();
    bindTour();
    $("#property-dialog-close").addEventListener(
      "click",
      () => $("#property-dialog").close(),
    );
    $("#property-dialog").addEventListener("close", () => {
      let fallback = $("#tour h1");
      (dialogReturn?.isConnected ? dialogReturn : fallback)?.focus({
        preventScroll: true,
      });
    });
    $("#project-dialog-close").addEventListener(
      "click",
      () => $("#project-dialog").close(),
    );
    $("#project-dialog").addEventListener(
      "close",
      () => projectReturn?.focus({ preventScroll: true }),
    );
    window.addEventListener("hashchange", show);
    show();
    loadMaps();
  }
  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", init)
    : init();
})();
