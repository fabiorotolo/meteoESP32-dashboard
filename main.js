// ========================
// CONFIGURAZIONE THINGSPEAK
// ========================

// Canale ESP32 (unico canale - dati esterni + pressione)
const ESP32_CHANNEL_ID = 3230363;
const ESP32_READ_KEY   = "37X0VL8GXSO0TB70";

const ESP32_FIELDS = {
  temp: 1,   // temperatura esterna (BMP180/BME280)
  hum: 2,    // umidità esterna
  press: 3,  // pressione
  cpu: 4     // temp CPU ESP32
};

// intervalli in ore
const RANGE_HOURS = {
  "1h": 1,
  "3h": 3,
  "6h": 6,
  "12h": 12,
  "1d": 24,
  "1w": 24 * 7,
  "1m": 24 * 30,
  "1y": 24 * 365
};

// ========================
// FILTRI DATI (VALIDAZIONE PUNTI SPORCHI)
// ========================

const LIMITS = {
  tempInt: { min: -10, max: 50 },
  tempExt: { min: -30, max: 50 },
  hum:     { min: 0,   max: 100 },
  press:   { min: 950, max: 1050 },
  cpu:     { min: 0,   max: 100 }
};

const DELTA_LIMITS = {
  tempInt: 10.0,
  tempExt: 10.0,
  press:   6.0,
  humInt:  20,
  humExt:  20
};

function isValid(v, lim) {
  return Number.isFinite(v) && v >= lim.min && v <= lim.max;
}

function filterSpikes(points, maxDelta) {
  if (points.length < 2) return points;
  const clean = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = clean[clean.length - 1].y;
    const curr = points[i].y;
    if (Math.abs(curr - prev) <= maxDelta) {
      clean.push(points[i]);
    }
  }
  return clean;
}

function buildSeries(feeds, field, limits, deltaLimit) {
  const raw = feeds
    .map(f => {
      const v = parseFloat(f.raw[field]);
      if (!isValid(v, limits)) return null;
      return { x: f.time, y: v };
    })
    .filter(Boolean);

  return deltaLimit ? filterSpikes(raw, deltaLimit) : raw;
}

// ========================
// STATO GLOBALE
// ========================
let currentRange = "1d";
let currentEndTime = new Date();   // ORA LOGICA di fine visualizzazione
let isDragging = false;            // FLAG per evitare aggiornamenti durante il drag

// ========================
// UTILITÀ DI BASE
// ========================

function fmtTime(date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function fmtDateTime(date) {
  const d = String(date.getDate()).padStart(2, "0");
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  return `${d}/${mo}/${y} ${fmtTime(date)}`;
}

// chiama ThingSpeak e ritorna feeds [] con Date + fields
async function fetchChannelFeeds(channelId, apiKey, maxResults = 2000) {
  const url =
    `https://api.thingspeak.com/channels/${channelId}/feeds.json` +
    `?api_key=${apiKey}&results=${maxResults}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Errore HTTP " + res.status);
  }
  const data = await res.json();
  return (data.feeds || []).map(f => ({
    time: new Date(f.created_at),
    raw: f
  }));
}

// Filtra per intervallo in ore rispetto a endTime
function filterByRange(feeds, hours, endTime) {
  if (!feeds.length) return [];
  const start = new Date(endTime.getTime() - hours * 3600 * 1000);
  return feeds.filter(f => f.time >= start && f.time <= endTime);
}

// ========================
// FEATURE & FORECAST LOGIC (porting da forecast.py)
// ========================

const MAX_WINDOW_HOURS = 24.0;
const P_HIGH = 1020.0;
const P_LOW = 1002.0;
const DP3_STRONG = 4.0;
const DP3_MEDIUM = 2.0;

function deltaOverWindow(tsList, values, windowHours) {
  if (!tsList.length || !values.length) return null;
  const tsLast = tsList[tsList.length - 1];
  const cutoff = new Date(tsLast.getTime() - windowHours * 3600 * 1000);

  let firstVal = null;
  let lastVal = null;

  for (let i = 0; i < tsList.length; i++) {
    const t = tsList[i];
    const v = values[i];
    if (t < cutoff) continue;
    if (v == null || Number.isNaN(v)) continue;
    if (firstVal === null) firstVal = v;
    lastVal = v;
  }
  if (firstVal === null || lastVal === null) return null;
  return lastVal - firstVal;
}

function safeLast(values) {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v != null && !Number.isNaN(v)) return v;
  }
  return null;
}

function computeTimeFeatures(tsNow) {
  const hour = tsNow.getHours();
  const startOfYear = new Date(tsNow.getFullYear(), 0, 1);
  const doy = Math.floor((tsNow - startOfYear) / (24 * 3600 * 1000)) + 1;

  const hourAngle = 2 * Math.PI * (hour / 24.0);
  const doyAngle = 2 * Math.PI * (doy / 365.0);

  const hourSin = Math.sin(hourAngle);
  const hourCos = Math.cos(hourAngle);
  const doySin = Math.sin(doyAngle);
  const doyCos = Math.cos(doyAngle);

  return { hour, doy, hourSin, hourCos, doySin, doyCos };
}

function buildForecastFeatures(esp32Filtered) {
  if (!esp32Filtered.length) return null;

  const recentPress = filterByRange(esp32Filtered, MAX_WINDOW_HOURS, currentEndTime);
  if (recentPress.length < 3) return null;

  const tsPress = recentPress.map(p => p.time);
  const pVals = recentPress.map(p => {
    const v = parseFloat(p.raw["field" + ESP32_FIELDS.press]);
    return Number.isFinite(v) ? v : null;
  });

  const tsExt = recentPress.map(p => p.time);
  const uExtVals = recentPress.map(p => {
    const v = parseFloat(p.raw["field" + ESP32_FIELDS.hum]);
    return Number.isFinite(v) ? v : null;
  });
  const tExtVals = recentPress.map(p => {
    const v = parseFloat(p.raw["field" + ESP32_FIELDS.temp]);
    return Number.isFinite(v) ? v : null;
  });

  const tsAll = tsPress.length ? tsPress : tsExt;
  if (!tsAll.length) return null;
  const tsNow = tsAll[tsAll.length - 1];

  const pNow = safeLast(pVals);
  const uExtNow = safeLast(uExtVals);
  const tExtNow = safeLast(tExtVals);

  const dp1h = deltaOverWindow(tsPress, pVals, 1.0);
  const dp3h = deltaOverWindow(tsPress, pVals, 3.0);
  const dp6h = deltaOverWindow(tsPress, pVals, 6.0);

  const du3h = deltaOverWindow(tsExt, uExtVals, 3.0);
  const du6h = deltaOverWindow(tsExt, uExtVals, 6.0);

  const timeFeat = computeTimeFeatures(tsNow);

  return {
    tsNow,
    pNow,
    tExtNow,
    uExtNow,
    dp1h,
    dp3h,
    dp6h,
    du3h,
    du6h,
    hour: timeFeat.hour,
    doy: timeFeat.doy,
    hourSin: timeFeat.hourSin,
    hourCos: timeFeat.hourCos,
    doySin: timeFeat.doySin,
    doyCos: timeFeat.doyCos,
    nPoints: recentPress.length
  };
}

function classifyPressureLevel(pNow) {
  if (pNow == null) return "unknown";
  if (pNow >= P_HIGH) return "high";
  if (pNow <= P_LOW) return "low";
  return "normal";
}

function classifyPressureTrend(dp3h) {
  if (dp3h == null) return "unknown";
  if (dp3h <= -DP3_STRONG) return "strong_down";
  if (dp3h <= -DP3_MEDIUM) return "down";
  if (dp3h >= DP3_STRONG) return "strong_up";
  if (dp3h >= DP3_MEDIUM) return "up";
  return "stable";
}

function computeInstabilityIndex(feat) {
  let inst = 0.0;
  const list = [
    [1.0, feat.dp3h],
    [0.5, feat.dp6h],
    [0.3, feat.dp1h]
  ];
  for (const [w, dp] of list) {
    if (dp != null) inst += w * Math.abs(dp);
  }

  if (feat.uExtNow != null) {
    inst += 0.02 * Math.max(0, feat.uExtNow - 70);
  }

  const duList = [
    [0.3, feat.du3h],
    [0.5, feat.du6h]
  ];
  for (const [w, du] of duList) {
    if (du != null && du > 0) inst += w * (du / 10.0);
  }

  inst *= 1.0 + 0.1 * feat.doySin;
  return inst;
}

function decideWeather(feat) {
  const level = classifyPressureLevel(feat.pNow);
  const trend = classifyPressureTrend(feat.dp3h);
  const inst = computeInstabilityIndex(feat);

  const tExt = feat.tExtNow;
  const uExt = feat.uExtNow;

  let icon = "cloud";
  let summary = "Condizioni stabili";
  let detail = "Nessuna variazione significativa prevista nelle prossime ore.";
  let iceRisk = false;

  if (feat.pNow == null) {
    if (uExt != null && uExt > 80) {
      icon = "rain";
      summary = "Possibile pioggia";
      detail = "Umidità molto elevata, possibili rovesci locali.";
    } else {
      icon = "cloud";
      summary = "Meteo incerto";
      detail = "Dati di pressione mancanti, previsione poco affidabile.";
    }
    return { icon, summary, detail, iceRisk, trend: "unknown", inst };
  }

  if (trend === "strong_up" || trend === "up") {
    if (level === "high") {
      icon = "sun";
      summary = "Miglioramento, bel tempo";
      detail = "Pressione in aumento su valori alti: cielo generalmente sereno.";
    } else {
      icon = "partly";
      summary = "Tendenza al miglioramento";
      detail = "Pressione in aumento: possibile attenuazione di nubi o precipitazioni.";
    }
  } else if (trend === "strong_down" || trend === "down") {
    if (inst > 6.0) {
      icon = "storm";
      summary = "Peggioramento deciso";
      detail =
        "Pressione in forte calo e atmosfera instabile: possibili rovesci o temporali nelle prossime ore.";
    } else {
      icon = "rain";
      summary = "Peggioramento";
      detail = "Pressione in calo: aumento di nubi e possibili precipitazioni.";
    }
  } else {
    if (level === "high") {
      icon = "sun";
      summary = "Condizioni stabili e buone";
      detail = "Pressione su valori alti e trend stabile: tempo generalmente buono.";
    } else if (level === "low") {
      if (inst > 5.0) {
        icon = "rain";
        summary = "Instabilità persistente";
        detail = "Pressione bassa e atmosfera instabile: possibili rovesci sparsi.";
      } else {
        icon = "cloud";
        summary = "Cielo coperto o variabile";
        detail =
          "Pressione bassa ma poco movimento: prevalenza di nubi, fenomeni limitati.";
      }
    } else {
      if (inst > 5.0) {
        icon = "rain";
        summary = "Instabilità moderata";
        detail =
          "Pressione nella norma ma atmosfera un po' instabile: possibili brevi rovesci locali.";
      } else {
        icon = "partly";
        summary = "Meteo per lo più stabile";
        detail =
          "Leggera variabilità ma senza segnali forti di peggioramento o miglioramento.";
      }
    }
  }

  // neve / ghiaccio
  if (tExt != null) {
    if (tExt >= -3.0 && tExt <= 1.0 && (uExt || 0) >= 80) {
      iceRisk = true;
    }

    if (tExt <= 1.0 && (icon === "rain" || icon === "storm")) {
      if (iceRisk) {
        icon = "ice";
        summary = "Neve o ghiaccio in formazione";
        detail =
          "Precipitazioni con temperature prossime allo zero: possibili nevicate e formazione di ghiaccio al suolo.";
      } else {
        icon = "snow";
        summary = "Possibili nevicate";
        detail =
          "Precipitazioni con temperature basse: possibili nevicate, specie nelle ore più fredde.";
      }
    } else if (iceRisk && (icon === "cloud" || icon === "partly" || icon === "sun")) {
      icon = "ice";
      summary = "Rischio ghiaccio / gelate";
      detail =
        "Temperature attorno allo zero e umidità elevata: possibili gelate su superfici esposte.";
    }
  }

  return { icon, summary, detail, iceRisk, trend, inst, dp3h: feat.dp3h, uExtNow: uExt };
}

function computeForecast(intFiltered, extFiltered) {
  const feat = buildForecastFeatures(intFiltered, extFiltered);
  if (!feat) return null;
  return decideWeather(feat);
}

// ========================
// GESTIONE OROLOGIO
// ========================

function startClock() {
  const el = document.getElementById("clock-time");
  if (!el) return;
  function tick() {
    el.textContent = fmtTime(new Date());
  }
  tick();
  setInterval(tick, 1000);
}

// ========================
// GESTIONE RANGE BUTTONS
// ========================

function setupRangeButtons() {
  const btns = document.querySelectorAll(".btn-range");
  btns.forEach(btn => {
    const r = btn.dataset.range;
    if (r === currentRange) btn.classList.add("active");
    btn.addEventListener("click", () => {
      currentRange = r;
      currentEndTime = new Date();  // RESET a ORA
      btns.forEach(b => b.classList.toggle("active", b.dataset.range === r));
      loadAndRender();
    });
  });
}

// Determina il formato dell'asse X in base all'intervallo
function getXAxisFormat(range) {
  const hours = RANGE_HOURS[range] || 24;
  return hours <= 24 ? "%H:%M" : "%d/%m";
}

// Determina i margini del grafico in base alla risoluzione
function getChartMargins() {
  const isSmallScreen = window.innerHeight <= 600 && window.innerWidth <= 900;
  return isSmallScreen 
    ? { l: 35, r: 5, t: 8, b: 18 }
    : { l: 55, r: 10, t: 10, b: 25 };
}

// Determina la dimensione del font dei marker in base alla risoluzione
function getMarkerFontSize() {
  const isSmallScreen = window.innerHeight <= 600 && window.innerWidth <= 900;
  return isSmallScreen ? 7 : 13;
}

function getMarkerFontSizeSmall() {
  const isSmallScreen = window.innerHeight <= 600 && window.innerWidth <= 900;
  return isSmallScreen ? 7 : 12;
}

// Determina il mode del marker (con o senza testo)
function getMarkerMode() {
  const isSmallScreen = window.innerHeight <= 600 && window.innerWidth <= 900;
  return isSmallScreen ? "markers" : "markers+text";
}

// ========================
// GESTIONE PAN TEMPORALE
// ========================

function setupPanHandler(chartId) {
  const div = document.getElementById(chartId);
  if (!div) return;

  // Rimuove listener precedenti (se esistono)
  div.removeAllListeners && div.removeAllListeners("plotly_relayout");
  div.removeAllListeners && div.removeAllListeners("plotly_relayouting");

  // Durante il drag
  div.on("plotly_relayouting", () => {
    isDragging = true;
  });

  // Al rilascio del drag
  div.on("plotly_relayout", ev => {
    if (!isDragging) return;
    if (!ev["xaxis.range[1]"]) return;

    isDragging = false;

    const newEnd = new Date(ev["xaxis.range[1]"]);
    
    // Evita aggiornamenti inutili se lo spostamento è minimo
    if (Math.abs(newEnd - currentEndTime) < 1000) return;

    currentEndTime = newEnd;
    loadAndRender();
  });
}

// ========================
// RENDER GRAFICI
// ========================

async function loadAndRender() {
  const status = document.getElementById("status-bar");
  try {
    status.textContent = "Caricamento dati da ThingSpeak…";

    const maxResults = currentRange === "1y" ? 8000 : 
                       currentRange === "1m" ? 5000 : 
                       currentRange === "1w" ? 3000 : 2000;

    // Carica solo dal canale ESP32
    const esp32Feeds = await fetchChannelFeeds(ESP32_CHANNEL_ID, ESP32_READ_KEY, maxResults);

    const hours = RANGE_HOURS[currentRange] || 24;
    const esp32Filtered = filterByRange(esp32Feeds, hours, currentEndTime);

    // === STATISTICHE IN ALTO ===
    if (esp32Filtered.length) {
      const last = esp32Filtered[esp32Filtered.length - 1].raw;
      const lastTime = new Date(last.created_at);

      const temp = parseFloat(last["field" + ESP32_FIELDS.temp]);
      const hum = parseFloat(last["field" + ESP32_FIELDS.hum]);
      const press = parseFloat(last["field" + ESP32_FIELDS.press]);
      const cpu = parseFloat(last["field" + ESP32_FIELDS.cpu]);

      // Aggiorna valori in alto
      if (!isNaN(temp)) {
        const el = document.getElementById("stat-temp-ext");
        el.innerHTML = temp.toFixed(2) + ' <span class="unit-small">°C</span>';
      }
      if (!isNaN(hum)) {
        const elHum = document.getElementById("stat-hum-ext");
        elHum.innerHTML = hum.toFixed(1) + ' <span class="unit-small">%</span>';
        document.getElementById("debug-rh").textContent = hum.toFixed(1) + " %";
      }
      if (!isNaN(press)) {
        const el = document.getElementById("stat-press");
        el.innerHTML = press.toFixed(1) + ' <span class="unit-small">hPa</span>';
      }
      if (!isNaN(cpu)) {
        document.getElementById("stat-temp-cpu").textContent = cpu.toFixed(1) + " °C";
      }

      document.getElementById("stat-last-ts").textContent = fmtDateTime(lastTime);
    }

    // === GRAFICO PRESSIONE (CON FILTRAGGIO) ===
    const pressPoints = buildSeries(
      esp32Filtered,
      "field" + ESP32_FIELDS.press,
      LIMITS.press,
      DELTA_LIMITS.press
    );

    let minPress, maxPress, minPressPoint, maxPressPoint;
    if (pressPoints.length > 0) {
      const pressValues = pressPoints.map(p => p.y);
      minPress = Math.min(...pressValues);
      maxPress = Math.max(...pressValues);
      
      minPressPoint = pressPoints.find(p => p.y === minPress);
      maxPressPoint = pressPoints.find(p => p.y === maxPress);
      
      document.getElementById("press-minmax").textContent = 
        `min: ${minPress.toFixed(1)} hPa | max: ${maxPress.toFixed(1)} hPa`;
    } else {
      document.getElementById("press-minmax").textContent = "--";
    }

    const pressTrace = {
      x: pressPoints.map(p => p.x),
      y: pressPoints.map(p => p.y),
      type: "scatter",
      mode: "lines",
      line: { color: "#00d4ff", width: 2.5 },
      fill: "tozeroy",
      fillcolor: "rgba(0, 212, 255, 0.15)",
      showlegend: false,
      hovertemplate: "%{y:.1f} hPa<extra></extra>"
    };

    const pressTraces = [pressTrace];
    
    if (minPressPoint) {
      pressTraces.push({
        x: [minPressPoint.x],
        y: [minPressPoint.y],
        mode: getMarkerMode(),
        marker: { size: 8, color: "#ff6666", symbol: "circle" },
        text: [minPress.toFixed(1)],
        textposition: "bottom center",
        textfont: { color: "#ffffff", size: getMarkerFontSize(), family: "system-ui", weight: "bold" },
        showlegend: false,
        hoverinfo: "skip"
      });
    }
    
    if (maxPressPoint) {
      pressTraces.push({
        x: [maxPressPoint.x],
        y: [maxPressPoint.y],
        mode: getMarkerMode(),
        marker: { size: 8, color: "#66ff66", symbol: "circle" },
        text: [maxPress.toFixed(1)],
        textposition: "top center",
        textfont: { color: "#ffffff", size: getMarkerFontSize(), family: "system-ui", weight: "bold" },
        showlegend: false,
        hoverinfo: "skip"
      });
    }

    Plotly.newPlot("chart-press", pressTraces, {
      margin: getChartMargins(),
      dragmode: "pan",
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { color: "#ffffff" },
      xaxis: {
        showgrid: true,
        gridcolor: "#555555",
        tickfont: { color: "#ffffff" },
        linecolor: "#ffffff",
        tickformat: getXAxisFormat(currentRange)
      },
      yaxis: {
        showgrid: true,
        gridcolor: "#555555",
        tickfont: { color: "#ffffff" },
        linecolor: "#ffffff",
        title: { text: "hPa", font: { color: "#ffffff" } },
        range: minPress != null ? [minPress - 2, maxPress + 2] : undefined
      }
    }, { displayModeBar: false });

    setupPanHandler("chart-press");

    // === GRAFICO TEMPERATURA EXT (CON FILTRAGGIO) ===
    const tempExtPoints = buildSeries(
      esp32Filtered,
      "field" + ESP32_FIELDS.temp,
      LIMITS.tempExt,
      DELTA_LIMITS.tempExt
    );

    let tempMinMaxText = "";
    let minTempExt, maxTempExt, minTempExtPoint, maxTempExtPoint;
    
    if (tempExtPoints.length > 0) {
      const tempExtValues = tempExtPoints.map(p => p.y);
      minTempExt = Math.min(...tempExtValues);
      maxTempExt = Math.max(...tempExtValues);
      minTempExtPoint = tempExtPoints.find(p => p.y === minTempExt);
      maxTempExtPoint = tempExtPoints.find(p => p.y === maxTempExt);
      tempMinMaxText = `EXT: ${minTempExt.toFixed(1)}-${maxTempExt.toFixed(1)}°C`;
    }
    document.getElementById("temp-minmax").textContent = tempMinMaxText || "--";

    const tempExtTrace = {
      x: tempExtPoints.map(p => p.x),
      y: tempExtPoints.map(p => p.y),
      mode: "lines",
      name: "Temp EXT",
      line: { width: 2.5, color: "#66aaff" },
      fill: "tozeroy",
      fillcolor: "rgba(102, 170, 255, 0.15)",
      showlegend: false,
      hovertemplate: "%{y:.1f} °C<extra></extra>"
    };

    const tempTraces = [tempExtTrace];
    
    if (minTempExtPoint) {
      tempTraces.push({
        x: [minTempExtPoint.x],
        y: [minTempExtPoint.y],
        mode: getMarkerMode(),
        marker: { size: 8, color: "#66aaff", symbol: "circle" },
        text: [minTempExt.toFixed(1)],
        textposition: "bottom center",
        textfont: { color: "#ffffff", size: getMarkerFontSize(), weight: "bold" },
        showlegend: false,
        hoverinfo: "skip"
      });
    }
    if (maxTempExtPoint) {
      tempTraces.push({
        x: [maxTempExtPoint.x],
        y: [maxTempExtPoint.y],
        mode: getMarkerMode(),
        marker: { size: 8, color: "#66aaff", symbol: "circle" },
        text: [maxTempExt.toFixed(1)],
        textposition: "top center",
        textfont: { color: "#ffffff", size: getMarkerFontSize(), weight: "bold" },
        showlegend: false,
        hoverinfo: "skip"
      });
    }

    Plotly.newPlot("chart-temp", tempTraces, {
      margin: getChartMargins(),
      dragmode: "pan",
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { color: "#ffffff" },
      xaxis: {
        showgrid: true,
        gridcolor: "#555555",
        tickfont: { color: "#ffffff" },
        linecolor: "#ffffff",
        tickformat: getXAxisFormat(currentRange)
      },
      yaxis: {
        showgrid: true,
        gridcolor: "#555555",
        tickfont: { color: "#ffffff" },
        linecolor: "#ffffff",
        title: { text: "°C", font: { color: "#ffffff" } }
      },
      legend: { orientation: "h", y: 1.15 }
    }, { displayModeBar: false });

    setupPanHandler("chart-temp");

    // === GRAFICO UMIDITÀ EXT (CON FILTRAGGIO) ===
    const humExtPoints = buildSeries(
      esp32Filtered,
      "field" + ESP32_FIELDS.hum,
      LIMITS.hum,
      DELTA_LIMITS.humExt
    );

    let humMinMaxText = "";
    let minHumExt, maxHumExt, minHumExtPoint, maxHumExtPoint;
    
    if (humExtPoints.length > 0) {
      const humExtValues = humExtPoints.map(p => p.y);
      minHumExt = Math.min(...humExtValues);
      maxHumExt = Math.max(...humExtValues);
      minHumExtPoint = humExtPoints.find(p => p.y === minHumExt);
      maxHumExtPoint = humExtPoints.find(p => p.y === maxHumExt);
      humMinMaxText = `EXT: ${minHumExt.toFixed(0)}-${maxHumExt.toFixed(0)}%`;
    }
    document.getElementById("hum-minmax").textContent = humMinMaxText || "--";

    const humExtTrace = {
      x: humExtPoints.map(p => p.x),
      y: humExtPoints.map(p => p.y),
      mode: "lines",
      name: "UR EXT",
      line: { width: 2.5, color: "#66aaff" },
      fill: "tozeroy",
      fillcolor: "rgba(102, 170, 255, 0.15)",
      showlegend: false,
      hovertemplate: "%{y:.1f} %<extra></extra>"
    };

    const humTraces = [humExtTrace];
    
    if (minHumExtPoint) {
      humTraces.push({
        x: [minHumExtPoint.x],
        y: [minHumExtPoint.y],
        mode: getMarkerMode(),
        marker: { size: 8, color: "#66aaff", symbol: "circle" },
        text: [minHumExt.toFixed(0)],
        textposition: "bottom center",
        textfont: { color: "#ffffff", size: getMarkerFontSize(), weight: "bold" },
        showlegend: false,
        hoverinfo: "skip"
      });
    }
    if (maxHumExtPoint) {
      humTraces.push({
        x: [maxHumExtPoint.x],
        y: [maxHumExtPoint.y],
        mode: getMarkerMode(),
        marker: { size: 8, color: "#66aaff", symbol: "circle" },
        text: [maxHumExt.toFixed(0)],
        textposition: "top center",
        textfont: { color: "#ffffff", size: getMarkerFontSize(), weight: "bold" },
        showlegend: false,
        hoverinfo: "skip"
      });
    }

    Plotly.newPlot("chart-hum", humTraces, {
      margin: getChartMargins(),
      dragmode: "pan",
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { color: "#ffffff" },
      xaxis: {
        showgrid: true,
        gridcolor: "#555555",
        tickfont: { color: "#ffffff" },
        linecolor: "#ffffff",
        tickformat: getXAxisFormat(currentRange)
      },
      yaxis: {
        showgrid: true,
        gridcolor: "#555555",
        tickfont: { color: "#ffffff" },
        linecolor: "#ffffff",
        title: { text: "%", font: { color: "#ffffff" } }
      },
      legend: { orientation: "h", y: 1.15 }
    }, { displayModeBar: false });

    setupPanHandler("chart-hum");

    // === PREVISIONE METEO AVANZATA ===
    const forecast = computeForecast(esp32Filtered, esp32Filtered);
    let forecastText = "Dati insufficienti per la tendenza.";
    let dp3hTxt = "n/d";

    if (forecast) {
      forecastText = `<strong>${forecast.summary}</strong><br><span style="font-size:12px">${forecast.detail}</span>`;
      if (forecast.dp3h != null) {
        dp3hTxt = forecast.dp3h.toFixed(1) + " hPa";
      }

      const iconMap = {
        sun: "☀️",
        partly: "⛅",
        cloud: "☁️",
        rain: "🌧️",
        snow: "❄️",
        storm: "⛈️",
        ice: "🧊"
      };
      const iconEl = document.getElementById("forecast-icon");
      if (iconEl) {
        iconEl.textContent = iconMap[forecast.icon] || "ℹ️";
      }

      if (forecast.uExtNow != null) {
        document.getElementById("debug-rh").textContent = forecast.uExtNow.toFixed(1) + " %";
      }
      document.getElementById("debug-thresh").textContent =
        `DP3 medium=${DP3_MEDIUM} hPa, strong=${DP3_STRONG} hPa`;
    }

    document.getElementById("forecast-text").innerHTML = forecastText;
    document.getElementById("debug-dp3h").textContent = dp3hTxt;

    // Aggiorna punti totali
    const totalPoints = esp32Feeds.length;
    document.getElementById("stat-total-points").textContent = totalPoints;

    status.textContent =
      `Range: ${currentRange} | Fine: ${fmtDateTime(currentEndTime)} | Punti ESP32: ${esp32Filtered.length}`;
  } catch (err) {
    console.error(err);
    status.textContent = "Errore nel caricamento ThingSpeak.";
  }
}

// ========================
// DATI ASTRONOMICI (FASE LUNARE E POSIZIONE SOLE)
// ========================

const LAT = 42.120333;
const LON = 14.401111;

function calculateMoonPhase(date = new Date()) {
  let year = date.getFullYear();
  let month = date.getMonth() + 1;
  const day = date.getDate();
  
  let c, e, jd, b;
  
  if (month < 3) {
    year--;
    month += 12;
  }
  
  ++month;
  c = 365.25 * year;
  e = 30.6 * month;
  jd = c + e + day - 694039.09;
  jd /= 29.5305882;
  b = parseInt(jd);
  jd -= b;
  b = Math.round(jd * 8);
  
  if (b >= 8) b = 0;
  
  const phase = b;
  const illumination = jd;
  const illumPercent = Math.round((1 - Math.cos(illumination * 2 * Math.PI)) * 50);
  
  const phaseNames = [
    "Nuova", "Crescente", "Primo quarto", "Gibbosa crescente",
    "Piena", "Gibbosa calante", "Ultimo quarto", "Calante"
  ];
  
  const moonEmojis = [
    "🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"
  ];
  
  return {
    phase: phaseNames[phase],
    illumination: illumPercent,
    emoji: moonEmojis[phase]
  };
}

async function loadSunData() {
  try {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];
    
    const url = `https://api.sunrise-sunset.org/json?lat=${LAT}&lng=${LON}&formatted=0&date=${dateStr}`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.status === "OK") {
      const sunrise = new Date(data.results.sunrise);
      const sunset = new Date(data.results.sunset);
      const now = new Date();
      
      let progress = 0;
      if (now >= sunrise && now <= sunset) {
        const totalDaylight = sunset - sunrise;
        const elapsed = now - sunrise;
        progress = elapsed / totalDaylight;
      } else if (now > sunset) {
        progress = 1;
      }
      
      return {
        sunrise,
        sunset,
        progress: Math.max(0, Math.min(1, progress))
      };
    }
  } catch (error) {
    console.error("Errore caricamento dati sole:", error);
  }
  
  // Fallback
  const now = new Date();
  const fallbackSunrise = new Date(now);
  fallbackSunrise.setHours(7, 0, 0, 0);
  const fallbackSunset = new Date(now);
  fallbackSunset.setHours(17, 0, 0, 0);
  
  let progress = 0.5;
  if (now >= fallbackSunrise && now <= fallbackSunset) {
    const totalDaylight = fallbackSunset - fallbackSunrise;
    const elapsed = now - fallbackSunrise;
    progress = elapsed / totalDaylight;
  } else if (now > fallbackSunset) {
    progress = 1;
  }
  
  return {
    sunrise: fallbackSunrise,
    sunset: fallbackSunset,
    progress: Math.max(0, Math.min(1, progress))
  };
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CALCOLA DATI LUNA (sorgere e tramonto)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function loadMoonData() {
  try {
    const now = new Date();
    
    // Calcola per OGGI
    const moonTimesToday = SunCalc.getMoonTimes(now, LAT, LON);
    
    let moonrise = moonTimesToday.rise;
    let moonset = moonTimesToday.set;
    
    let moonriseIsNextDay = false;
    let moonriseWasYesterday = false;
    let moonsetIsNextDay = false;
    let moonsetWasYesterday = false;
    
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // GESTIONE MOONRISE
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // LOGICA: Mostra sempre moonrise di OGGI (anche se passato)
    //         Solo se NON esiste oggi, cerca domani o ieri
    
    // Se moonrise NON esiste oggi, cerca DOMANI
    if (!moonrise) {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      
      const moonTimesTomorrow = SunCalc.getMoonTimes(tomorrow, LAT, LON);
      
      if (moonTimesTomorrow.rise) {
        moonrise = moonTimesTomorrow.rise;
        moonriseIsNextDay = true;
      }
    }
    
    // Se ancora null, prova IERI
    if (!moonrise) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);
      
      const moonTimesYesterday = SunCalc.getMoonTimes(yesterday, LAT, LON);
      
      if (moonTimesYesterday.rise) {
        moonrise = moonTimesYesterday.rise;
        moonriseWasYesterday = true;
      }
    }
    
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // GESTIONE MOONSET
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // LOGICA: Mostra sempre il PROSSIMO tramonto futuro
    //         Se è passato oggi, cerca domani
    
    // Se moonset è passato o null, cerca DOMANI
    if (!moonset || (moonset && moonset < now)) {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      
      const moonTimesTomorrow = SunCalc.getMoonTimes(tomorrow, LAT, LON);
      
      if (moonTimesTomorrow.set) {
        moonset = moonTimesTomorrow.set;
        moonsetIsNextDay = true;
      }
    }
    
    // Se ancora null, prova IERI
    if (!moonset) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);
      
      const moonTimesYesterday = SunCalc.getMoonTimes(yesterday, LAT, LON);
      
      if (moonTimesYesterday.set) {
        moonset = moonTimesYesterday.set;
        moonsetWasYesterday = true;
      }
    }
    
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // CALCOLO PROGRESS (Posizione arco)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    
    let progress = 0;
    
    if (moonrise && moonset) {
      // Calcola progress in base a posizione tra rise e set
      // (funziona anche se set è domani!)
      if (now < moonrise) {
        // Luna non ancora sorta
        progress = 0;
      } else if (now >= moonset) {
        // Luna già tramontata
        progress = 1;
      } else {
        // Luna visibile: calcola posizione nell'arco
        const totalTime = moonset - moonrise;
        const elapsed = now - moonrise;
        progress = elapsed / totalTime;
      }
    } else {
      // Fallback: usa ora del giorno
      progress = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
    }
    
    progress = Math.max(0, Math.min(1, progress));
    
    return {
      moonrise,
      moonset,
      moonriseIsNextDay,
      moonriseWasYesterday,
      moonsetIsNextDay,
      moonsetWasYesterday,
      progress
    };
  } catch (error) {
    console.error("Errore calcolo dati Luna:", error);
    
    const now = new Date();
    const progress = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
    
    return {
      moonrise: null,
      moonset: null,
      moonriseIsNextDay: false,
      moonriseWasYesterday: false,
      moonsetIsNextDay: false,
      moonsetWasYesterday: false,
      progress: progress
    };
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AGGIORNA DATI ASTRONOMICI (Sole e Luna)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function updateAstroData() {
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // FASE LUNARE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  try {
    const moon = calculateMoonPhase();
    
    const moonIconEl = document.getElementById("moon-icon");
    const moonPhaseEl = document.getElementById("moon-phase");
    const moonIllumEl = document.getElementById("moon-illumination");
    
    if (moonIconEl) moonIconEl.textContent = moon.emoji;
    if (moonPhaseEl) moonPhaseEl.textContent = moon.phase;
    if (moonIllumEl) moonIllumEl.textContent = `Illuminazione: ${moon.illumination}%`;
  } catch (error) {
    console.error("Errore aggiornamento fase lunare:", error);
  }
  
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SOLE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  try {
    const sun = await loadSunData();
    
    const sunriseStr = sun.sunrise.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    const sunsetStr = sun.sunset.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    
    const sunriseEl = document.getElementById("sunrise-time");
    const sunsetEl = document.getElementById("sunset-time");
    const sunIndicatorEl = document.getElementById("sun-indicator");
    
    if (sunriseEl) sunriseEl.textContent = sunriseStr;
    if (sunsetEl) sunsetEl.textContent = sunsetStr;
    
    if (sunIndicatorEl) {
      const progress = sun.progress;
      const leftPercent = progress * 100;
      const arcHeight = 50;
      const yPosition = Math.sin(progress * Math.PI) * arcHeight;
      const yOffset = 8;
      
      sunIndicatorEl.style.left = leftPercent + "%";
      sunIndicatorEl.style.bottom = (yPosition + yOffset) + "px";
      
      // Opacità dinamica
      const now = new Date();
      if (now < sun.sunrise || now > sun.sunset) {
        sunIndicatorEl.style.opacity = "0.2";
      } else {
        sunIndicatorEl.style.opacity = "1";
      }
    }
  } catch (error) {
    console.error("Errore aggiornamento dati sole:", error);
  }
  
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // LUNA (sorgere e tramonto)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  try {
    const moonData = await loadMoonData();
    
    const moonriseEl = document.getElementById("moonrise-time");
    const moonsetEl = document.getElementById("moonset-time");
    const moonIndicatorEl = document.getElementById("moon-indicator");
    
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // MOONRISE con -1d / +1d
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (moonriseEl) {
      let moonriseText = "--:--";
      
      if (moonData.moonrise) {
        const timeStr = moonData.moonrise.toLocaleTimeString("it-IT", { 
          hour: "2-digit", 
          minute: "2-digit" 
        });
        
        if (moonData.moonriseIsNextDay) {
          moonriseText = `+1d ${timeStr}`;
        } else if (moonData.moonriseWasYesterday) {
          moonriseText = `-1d ${timeStr}`;
        } else {
          moonriseText = timeStr;
        }
      }
      
      moonriseEl.textContent = moonriseText;
    }
    
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // MOONSET con -1d / +1d
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (moonsetEl) {
      let moonsetText = "--:--";
      
      if (moonData.moonset) {
        const timeStr = moonData.moonset.toLocaleTimeString("it-IT", { 
          hour: "2-digit", 
          minute: "2-digit" 
        });
        
        if (moonData.moonsetIsNextDay) {
          moonsetText = `+1d ${timeStr}`;
        } else if (moonData.moonsetWasYesterday) {
          moonsetText = `-1d ${timeStr}`;
        } else {
          moonsetText = timeStr;
        }
      }
      
      moonsetEl.textContent = moonsetText;
    }
    
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // INDICATORE LUNA (posizione arco)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (moonIndicatorEl) {
      const progress = moonData.progress;
      const leftPercent = progress * 100;
      const arcHeight = 50;
      const yPosition = Math.sin(progress * Math.PI) * arcHeight;
      const yOffset = -6;
      
      moonIndicatorEl.style.left = leftPercent + "%";
      moonIndicatorEl.style.bottom = (yPosition + yOffset) + "px";
      
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // OPACITÀ DINAMICA
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // LOGICA: Luna opaca (1) se visibile ORA
      //         Trasparente (0.2) se non visibile
      const now = new Date();
      if (moonData.moonrise && moonData.moonset) {
        // Luna visibile se: ora >= sorgere E ora < tramonto
        // (non importa se rise/set sono oggi o domani!)
        if (now >= moonData.moonrise && now < moonData.moonset) {
          moonIndicatorEl.style.opacity = "1";  // Luna visibile!
        } else {
          moonIndicatorEl.style.opacity = "0.2";  // Luna non visibile
        }
      } else {
        // Fallback se mancano dati
        moonIndicatorEl.style.opacity = "0.5";
      }
    }
  } catch (error) {
    console.error("Errore aggiornamento dati luna:", error);
  }
}

// ========================
// AVVIO
// ========================

window.addEventListener("load", () => {
  startClock();
  setupRangeButtons();
  loadAndRender();
  updateAstroData();

  setInterval(loadAndRender, 120000);
  setInterval(updateAstroData, 600000);
});

window.addEventListener("orientationchange", () => {
  document.body.style.opacity = "0";
  setTimeout(() => {
    location.reload();
  }, 200);
});
