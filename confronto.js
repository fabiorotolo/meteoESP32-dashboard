// ========================
// CONFIGURAZIONE THINGSPEAK
// ========================

// Canale ESP32 (unico canale - dati esterni)
const ESP32_CHANNEL_ID = 3230363;
const ESP32_READ_KEY   = "37X0VL8GXSO0TB70";

const ESP32_FIELDS = {
  temp: 1,   // temperatura esterna
  hum: 2,    // umidità esterna
  press: 3,  // pressione
  cpu: 4     // temp CPU
};

// ========================
// CONFIGURAZIONE COLORI GIORNI
// ========================

const DAY_COLORS = [
  '#3d7cff',  // 1gg - Blu (oggi)
  '#ff5c5c',  // 2gg - Rosso (ieri)
  '#4ade80',  // 3gg - Verde
  '#fb923c',  // 4gg - Arancione
  '#a855f7',  // 5gg - Viola
  '#06b6d4',  // 6gg - Ciano
  '#fbbf24'   // 7gg - Giallo
];

const DAY_LABELS = [
  'Oggi',
  'Ieri',
  '2 giorni fa',
  '3 giorni fa',
  '4 giorni fa',
  '5 giorni fa',
  '6 giorni fa'
];

// ========================
// STATO GLOBALE
// ========================

let currentDays = 1;  // Numero di giorni da confrontare
let currentSensor = 'EXT';  // Solo EXT (ESP32)
let allEsp32Data = [];

// ========================
// VALIDAZIONE DATI
// ========================

const LIMITS = {
  tempInt: { min: -10, max: 50 },
  tempExt: { min: -30, max: 50 },
  hum:     { min: 0,   max: 100 },
  press:   { min: 950, max: 1050 },
  cpu:     { min: 0,   max: 100 }
};

function isValid(v, lim) {
  return Number.isFinite(v) && v >= lim.min && v <= lim.max;
}

// ========================
// UTILITÀ
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

async function fetchChannelFeeds(channelId, apiKey, maxResults = 8000) {
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

// ========================
// OROLOGIO
// ========================

function startClock() {
  function update() {
    const now = new Date();
    const el = document.getElementById("clock-time");
    if (el) el.textContent = fmtTime(now);
  }
  update();
  setInterval(update, 1000);
}

// ========================
// PROCESSAMENTO DATI PER CONFRONTO
// ========================

function groupDataByDay(feeds, fieldName, limits, daysBack) {
  const now = new Date();
  const result = [];
  
  for (let dayOffset = 0; dayOffset < daysBack; dayOffset++) {
    const dayData = [];
    
    // Definisci inizio e fine del giorno
    const dayStart = new Date(now);
    dayStart.setDate(now.getDate() - dayOffset);
    dayStart.setHours(0, 0, 0, 0);
    
    const dayEnd = new Date(now);
    dayEnd.setDate(now.getDate() - dayOffset);
    
    if (dayOffset === 0) {
      // Oggi: fino all'ora attuale
      dayEnd.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
    } else {
      // Giorni precedenti: 23:59:59
      dayEnd.setHours(23, 59, 59, 999);
    }
    
    // Filtra i feed per questo giorno
    feeds.forEach(f => {
      if (f.time >= dayStart && f.time <= dayEnd) {
        const v = parseFloat(f.raw[fieldName]);
        if (isValid(v, limits)) {
          // Estrai solo l'ora del giorno (0-24)
          const hourOfDay = f.time.getHours() + f.time.getMinutes() / 60 + f.time.getSeconds() / 3600;
          dayData.push({ x: hourOfDay, y: v });
        }
      }
    });
    
    // Ordina per ora del giorno
    dayData.sort((a, b) => a.x - b.x);
    
    result.push({
      dayOffset,
      label: DAY_LABELS[dayOffset],
      color: DAY_COLORS[dayOffset],
      data: dayData
    });
  }
  
  return result;
}

// ========================
// RENDERING GRAFICI
// ========================

function renderComparisonChart(elementId, title, dayGroups, unit) {
  const traces = dayGroups.map(group => ({
    x: group.data.map(p => p.x),
    y: group.data.map(p => p.y),
    mode: 'lines',
    name: group.label,
    line: {
      color: group.color,
      width: 2
    },
    hovertemplate: `<b>${group.label}</b><br>` +
                   `Ora: %{x:.2f}<br>` +
                   `${title}: %{y:.2f}${unit}<br>` +
                   `<extra></extra>`
  }));

  // Calcola annotazioni MIN/MAX per ogni giorno
  const annotations = [];
  dayGroups.forEach(group => {
    if (group.data.length === 0) return;
    
    const values = group.data.map(p => p.y);
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    
    // Trova la posizione X del minimo e massimo
    const minPoint = group.data.find(p => p.y === minVal);
    const maxPoint = group.data.find(p => p.y === maxVal);
    
    // Annotazione MIN
    if (minPoint) {
      annotations.push({
        x: minPoint.x,
        y: minVal,
        text: `${minVal.toFixed(1)}`,
        showarrow: true,
        arrowhead: 2,
        arrowsize: 1,
        arrowwidth: 1.5,
        arrowcolor: group.color,
        ax: 0,
        ay: 25,
        font: {
          size: 10,
          color: group.color,
          family: "JetBrains Mono, monospace"
        },
        bgcolor: "rgba(0, 0, 0, 0.7)",
        bordercolor: group.color,
        borderwidth: 1,
        borderpad: 3
      });
    }
    
    // Annotazione MAX
    if (maxPoint) {
      annotations.push({
        x: maxPoint.x,
        y: maxVal,
        text: `${maxVal.toFixed(1)}`,
        showarrow: true,
        arrowhead: 2,
        arrowsize: 1,
        arrowwidth: 1.5,
        arrowcolor: group.color,
        ax: 0,
        ay: -25,
        font: {
          size: 10,
          color: group.color,
          family: "JetBrains Mono, monospace"
        },
        bgcolor: "rgba(0, 0, 0, 0.7)",
        bordercolor: group.color,
        borderwidth: 1,
        borderpad: 3
      });
    }
  });

  const layout = {
    paper_bgcolor: "rgba(0, 0, 0, 0)",
    plot_bgcolor: "rgba(0, 0, 0, 0)",
    font: { color: "#c5c7d1", size: 11, family: "system-ui, sans-serif" },
    margin: { l: 45, r: 10, t: 10, b: 35 },
    xaxis: {
      title: { text: "Ora del giorno", font: { size: 10 } },
      gridcolor: "#2a2d3a",
      tickformat: ".0f",
      dtick: 3,
      range: [0, 24],
      ticksuffix: "h"
    },
    yaxis: {
      title: { text: `${title} (${unit})`, font: { size: 10 } },
      gridcolor: "#2a2d3a"
    },
    hovermode: "closest",
    showlegend: true,
    legend: {
      orientation: "h",
      x: 0,
      y: 1.15,
      font: { size: 10 }
    },
    annotations: annotations
  };

  const config = {
    responsive: true,
    displayModeBar: false
  };

  Plotly.newPlot(elementId, traces, layout, config);
}

// ========================
// CARICAMENTO E RENDERING
// ========================

async function loadAndRender() {
  const statusEl = document.getElementById("status-bar");
  statusEl.textContent = "Caricamento dati da ThingSpeak…";

  try {
    // Carica dati ESP32 (se non già caricati)
    if (allEsp32Data.length === 0) {
      allEsp32Data = await fetchChannelFeeds(ESP32_CHANNEL_ID, ESP32_READ_KEY, 8000);
    }

    // Aggiorna stato in alto
    updateTopStats();
    
    // Rendering grafici
    renderCharts();
    
    // Aggiorna meteo e astronomia
    updateForecast();
    updateAstroData();
    
    statusEl.textContent = `Confronto ${currentDays} giorni - Sensori ESP32`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Errore nel caricamento da ThingSpeak.";
  }
}

function updateTopStats() {
  // Ultimo valore ESP32
  if (allEsp32Data.length > 0) {
    const last = allEsp32Data[allEsp32Data.length - 1];
    const temp = parseFloat(last.raw["field" + ESP32_FIELDS.temp]);
    const hum = parseFloat(last.raw["field" + ESP32_FIELDS.hum]);
    const press = parseFloat(last.raw["field" + ESP32_FIELDS.press]);
    const cpu = parseFloat(last.raw["field" + ESP32_FIELDS.cpu]);
    
    if (Number.isFinite(temp)) {
      document.getElementById("stat-temp-ext").textContent = temp.toFixed(2) + " °C";
    }
    if (Number.isFinite(hum)) {
      document.getElementById("stat-hum-ext").textContent = hum.toFixed(1) + " %";
    }
    if (Number.isFinite(press)) {
      document.getElementById("stat-press").textContent = press.toFixed(1) + " hPa";
    }
    if (Number.isFinite(cpu)) {
      document.getElementById("stat-temp-cpu").textContent = cpu.toFixed(1) + " °C";
    }
    
    document.getElementById("stat-last-ts").textContent = fmtDateTime(last.time);
  }
  
  const totalPoints = allEsp32Data.length;
  document.getElementById("stat-total-points").textContent = totalPoints;
}

function renderCharts() {
  // PRESSIONE
  const pressGroups = groupDataByDay(
    allEsp32Data,
    "field" + ESP32_FIELDS.press,
    LIMITS.press,
    currentDays
  );
  renderComparisonChart("chart-press", "Pressione", pressGroups, " hPa");
  
  const pressMin = Math.min(...pressGroups.flatMap(g => g.data.map(p => p.y)));
  const pressMax = Math.max(...pressGroups.flatMap(g => g.data.map(p => p.y)));
  document.getElementById("press-subtitle").textContent = 
    `Min: ${pressMin.toFixed(1)} | Max: ${pressMax.toFixed(1)} hPa`;
  
  // TEMPERATURA ESP32
  const tempGroups = groupDataByDay(
    allEsp32Data,
    "field" + ESP32_FIELDS.temp,
    LIMITS.tempExt,
    currentDays
  );
  renderComparisonChart("chart-temp", "Temperatura", tempGroups, " °C");
  
  const tempMin = Math.min(...tempGroups.flatMap(g => g.data.map(p => p.y)));
  const tempMax = Math.max(...tempGroups.flatMap(g => g.data.map(p => p.y)));
  document.getElementById("temp-subtitle").textContent = 
    `Min: ${tempMin.toFixed(1)} | Max: ${tempMax.toFixed(1)} °C`;
  document.getElementById("temp-title").textContent = "Temperatura ESP32 - Confronto";
  
  // UMIDITÀ ESP32
  const humGroups = groupDataByDay(
    allEsp32Data,
    "field" + ESP32_FIELDS.hum,
    LIMITS.hum,
    currentDays
  );
  renderComparisonChart("chart-hum", "Umidità", humGroups, " %");
  
  const humMin = Math.min(...humGroups.flatMap(g => g.data.map(p => p.y)));
  const humMax = Math.max(...humGroups.flatMap(g => g.data.map(p => p.y)));
  document.getElementById("hum-subtitle").textContent = 
    `Min: ${humMin.toFixed(1)} | Max: ${humMax.toFixed(1)} %`;
  document.getElementById("hum-title").textContent = "Umidità ESP32 - Confronto";
}

// ========================
// GESTIONE PULSANTI
// ========================

function setupDayButtons() {
  const btns = document.querySelectorAll(".btn-range");
  
  // Funzione per aggiornare lo stato dei pulsanti
  function updateButtonStates(selectedDays) {
    btns.forEach(b => {
      const btnDays = parseInt(b.dataset.days);
      // Attiva tutti i pulsanti da 1 fino al giorno selezionato
      b.classList.toggle("active", btnDays <= selectedDays);
    });
  }
  
  // Inizializza lo stato
  updateButtonStates(currentDays);
  
  btns.forEach(btn => {
    const days = parseInt(btn.dataset.days);
    
    btn.addEventListener("click", () => {
      currentDays = days;
      updateButtonStates(days);
      renderCharts();
      document.getElementById("status-bar").textContent = 
        `Confronto ${currentDays} giorni - Sensori ${currentSensor}`;
    });
  });
}

// Funzione rimossa - non più necessaria (solo sensori ESP32)


// ========================
// FORECAST E METEO (copiato da main.js)
// ========================

const MAX_WINDOW_HOURS = 24.0;
const P_HIGH = 1020.0;
const P_LOW = 1002.0;
const DP3_STRONG = 4.0;
const DP3_MEDIUM = 2.0;

function filterByRange(feeds, hours) {
  if (!feeds.length) return [];
  const now = new Date();
  const start = new Date(now.getTime() - hours * 3600 * 1000);
  return feeds.filter(f => f.time >= start && f.time <= now);
}

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

function buildForecastFeatures() {
  if (!allEsp32Data.length) return null;

  const recentPress = filterByRange(allEsp32Data, MAX_WINDOW_HOURS);
  if (recentPress.length < 3) return null;

  const tsPress = recentPress.map(p => p.time);
  const pVals = recentPress.map(p => {
    const v = parseFloat(p.raw["field" + ESP32_FIELDS.press]);
    return Number.isFinite(v) ? v : null;
  });

  const uExtVals = recentPress.map(p => {
    const v = parseFloat(p.raw["field" + ESP32_FIELDS.hum]);
    return Number.isFinite(v) ? v : null;
  });

  const pNow = safeLast(pVals);
  const uExtNow = safeLast(uExtVals);
  const dp3h = deltaOverWindow(tsPress, pVals, 3.0);

  return { pNow, uExtNow, dp3h };
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

function updateForecast() {
  const feat = buildForecastFeatures();
  if (!feat) return;

  const pLevel = classifyPressureLevel(feat.pNow);
  const pTrend = classifyPressureTrend(feat.dp3h);

  let icon = "ℹ️";
  let text = "Meteo per il più stabile";

  if (pLevel === "low" && pTrend === "strong_down") {
    icon = "🌧️";
    text = "Probabile pioggia intensa o temporale";
  } else if (pLevel === "low") {
    icon = "☁️";
    text = "Nuvoloso, possibile pioggia";
  } else if (pTrend === "strong_down") {
    icon = "⛈️";
    text = "Peggioramento rapido";
  } else if (pLevel === "high" && pTrend === "up") {
    icon = "☀️";
    text = "Tempo stabile e soleggiato";
  } else if (pLevel === "high") {
    icon = "🌤️";
    text = "Tempo buono";
  } else if (pTrend === "strong_up") {
    icon = "🌤️";
    text = "Miglioramento rapido";
  }

  document.getElementById("forecast-icon").textContent = icon;
  document.getElementById("forecast-text").textContent = text;
  document.getElementById("debug-dp3h").textContent = 
    feat.dp3h != null ? feat.dp3h.toFixed(2) + " hPa" : "n/d";
  document.getElementById("debug-rh").textContent = 
    feat.uExtNow != null ? feat.uExtNow.toFixed(1) + " %" : "n/d";
  document.getElementById("debug-thresh").textContent = 
    `P_HIGH=${P_HIGH}, P_LOW=${P_LOW}`;
}

// ========================
// ASTRONOMIA (copiato da main.js)
// ========================

const LAT = 42.4626;
const LON = 14.2136;

function calculateMoonPhase() {
  const now = new Date();
  const moonIllum = SunCalc.getMoonIllumination(now);
  
  const phase = moonIllum.phase;
  const illumination = Math.round(moonIllum.fraction * 100);
  
  let phaseName = "";
  let emoji = "🌑";
  
  if (phase < 0.03 || phase > 0.97) {
    phaseName = "Luna Nuova";
    emoji = "🌑";
  } else if (phase < 0.22) {
    phaseName = "Luna Crescente";
    emoji = "🌒";
  } else if (phase < 0.28) {
    phaseName = "Primo Quarto";
    emoji = "🌓";
  } else if (phase < 0.47) {
    phaseName = "Gibbosa Crescente";
    emoji = "🌔";
  } else if (phase < 0.53) {
    phaseName = "Luna Piena";
    emoji = "🌕";
  } else if (phase < 0.72) {
    phaseName = "Gibbosa Calante";
    emoji = "🌖";
  } else if (phase < 0.78) {
    phaseName = "Ultimo Quarto";
    emoji = "🌗";
  } else {
    phaseName = "Calante";
    emoji = "🌘";
  }
  
  return { phase: phaseName, illumination, emoji };
}

async function loadSunData() {
  const now = new Date();
  const times = SunCalc.getTimes(now, LAT, LON);
  
  const sunrise = times.sunrise;
  const sunset = times.sunset;
  
  let progress = 0;
  if (now < sunrise) {
    progress = 0;
  } else if (now > sunset) {
    progress = 1;
  } else {
    const totalTime = sunset - sunrise;
    const elapsed = now - sunrise;
    progress = elapsed / totalTime;
  }
  
  return { sunrise, sunset, progress };
}

async function loadMoonData() {
  const now = new Date();
  const moonTimes = SunCalc.getMoonTimes(now, LAT, LON);
  
  let moonrise = moonTimes.rise;
  let moonset = moonTimes.set;
  let moonriseIsNextDay = false;
  let moonriseWasYesterday = false;
  let moonsetIsNextDay = false;
  let moonsetWasYesterday = false;
  
  if (!moonrise || moonrise < now) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const moonTimesTomorrow = SunCalc.getMoonTimes(tomorrow, LAT, LON);
    if (moonTimesTomorrow.rise) {
      moonrise = moonTimesTomorrow.rise;
      moonriseIsNextDay = true;
    }
  }
  
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
  
  let progress = 0;
  if (moonrise && moonset) {
    if (now < moonrise) {
      progress = 0;
    } else if (now >= moonset) {
      progress = 1;
    } else {
      const totalTime = moonset - moonrise;
      const elapsed = now - moonrise;
      progress = elapsed / totalTime;
    }
  } else {
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
}

async function updateAstroData() {
  try {
    const moon = calculateMoonPhase();
    document.getElementById("moon-icon").textContent = moon.emoji;
    document.getElementById("moon-phase").textContent = moon.phase;
    document.getElementById("moon-illumination").textContent = 
      `Illuminazione: ${moon.illumination}%`;
  } catch (error) {
    console.error("Errore fase lunare:", error);
  }
  
  try {
    const sun = await loadSunData();
    const sunriseStr = sun.sunrise.toLocaleTimeString("it-IT", { 
      hour: "2-digit", minute: "2-digit" 
    });
    const sunsetStr = sun.sunset.toLocaleTimeString("it-IT", { 
      hour: "2-digit", minute: "2-digit" 
    });
    
    document.getElementById("sunrise-time").textContent = sunriseStr;
    document.getElementById("sunset-time").textContent = sunsetStr;
    
    const sunIndicatorEl = document.getElementById("sun-indicator");
    if (sunIndicatorEl) {
      const progress = sun.progress;
      const leftPercent = progress * 100;
      const arcHeight = 50;
      const yPosition = Math.sin(progress * Math.PI) * arcHeight;
      const yOffset = 8;
      
      sunIndicatorEl.style.left = leftPercent + "%";
      sunIndicatorEl.style.bottom = (yPosition + yOffset) + "px";
      
      const now = new Date();
      if (now < sun.sunrise || now > sun.sunset) {
        sunIndicatorEl.style.opacity = "0.2";
      } else {
        sunIndicatorEl.style.opacity = "1";
      }
    }
  } catch (error) {
    console.error("Errore dati sole:", error);
  }
  
  try {
    const moonData = await loadMoonData();
    const moonriseEl = document.getElementById("moonrise-time");
    const moonsetEl = document.getElementById("moonset-time");
    const moonIndicatorEl = document.getElementById("moon-indicator");
    
    if (moonriseEl) {
      let moonriseText = "--:--";
      if (moonData.moonrise) {
        const timeStr = moonData.moonrise.toLocaleTimeString("it-IT", { 
          hour: "2-digit", minute: "2-digit" 
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
    
    if (moonsetEl) {
      let moonsetText = "--:--";
      if (moonData.moonset) {
        const timeStr = moonData.moonset.toLocaleTimeString("it-IT", { 
          hour: "2-digit", minute: "2-digit" 
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
    
    if (moonIndicatorEl) {
      const progress = moonData.progress;
      const leftPercent = progress * 100;
      const arcHeight = 50;
      const yPosition = Math.sin(progress * Math.PI) * arcHeight;
      const yOffset = -6;
      
      moonIndicatorEl.style.left = leftPercent + "%";
      moonIndicatorEl.style.bottom = (yPosition + yOffset) + "px";
      
      const now = new Date();
      if (moonData.moonrise && moonData.moonset) {
        if (now >= moonData.moonrise && now < moonData.moonset) {
          moonIndicatorEl.style.opacity = "1";
        } else {
          moonIndicatorEl.style.opacity = "0.2";
        }
      } else {
        moonIndicatorEl.style.opacity = "0.5";
      }
    }
  } catch (error) {
    console.error("Errore dati luna:", error);
  }
}

// ========================
// AVVIO
// ========================

window.addEventListener("load", () => {
  startClock();
  setupDayButtons();
  // setupSensorButton() rimossa - non più necessaria
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
